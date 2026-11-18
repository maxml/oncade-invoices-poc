# Operations

## Configuration

Everything comes from `.env` (documented in `.env.example`) and is validated by `packages/config/src/config.ts`. Empty
values count as unset. A bad value stops start-up with the variable's name and what is wrong. `pnpm demo` validates only
the Oncade part (`parseOncadeConfig`: the two required Oncade variables, the webhook secret and `WEBHOOK_PORT`), so it
needs no LLM or admin settings, and a bad value in them does not stop it.

| Variable                                                      | Default         | Notes                                                                        |
| ------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| `ONCADE_API_KEY`                                              | required        | Must start with `oncade_platform_test_`                                      |
| `ONCADE_BUSINESS_ID`                                          | required        | Sent as `X-Target-Business-Id`                                               |
| `ONCADE_WEBHOOK_SECRET`                                       | unset           | Without it every webhook gets 401                                            |
| `ANTHROPIC_API_KEY`                                           | unset           | Preferred; without it the CLI uses the Claude Code login                     |
| `AGENT_MODEL`                                                 | `sonnet`        |                                                                              |
| `AGENT_SANDBOX`                                               | `auto`          | `auto` (bwrap if installed), `on` (required), `off`                          |
| `AGENT_TIMEOUT_MS`, `AGENT_MAX_TURNS`, `AGENT_MAX_BUDGET_USD` | 180000, 12, 0.5 | Per run                                                                      |
| `AGENT_DAILY_BUDGET_USD`                                      | 2               | Per UTC day, over all runs (see [security.md](security.md))                  |
| `ADMIN_USER`, `ADMIN_PASSWORD`, `SESSION_SECRET`              | `admin`, -, -   | Password at least 12 characters, secret at least 32, not on the default list |
| `ALLOW_INSECURE_DEFAULTS`                                     | unset           | `1`: local demo with admin/admin and a built-in secret, with a loud warning  |
| `PORT`, `WEBHOOK_PORT`                                        | 3000, 3001      | Must differ                                                                  |

## Running

| Command                                 | What it does                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `./scripts/doctor.sh` (`--fix`)         | Checks what this machine can run, never prints values; `--fix` asks y/N per step. Also `pnpm run doctor` |
| `pnpm demo`                             | Create and send, create and cancel, read back, then wait for webhooks if set up. Oncade key only, no LLM |
| `pnpm dev`                              | UI on `127.0.0.1:$PORT` (3000), webhook receiver on `127.0.0.1:$WEBHOOK_PORT` (3001)                     |
| `pnpm ask "<question>"`                 | One agent turn from the terminal, read-only                                                              |
| `pnpm ask --allow-changes "<question>"` | The same, with the create, send and cancel tools                                                         |
| `pnpm runs`                             | The last 20 agent runs from `data/runs.jsonl`                                                            |
| `pnpm eval`                             | The eval cases through the real agent, about $0.14 ([testing.md](testing.md#evals-and-promptops))        |
| `pnpm mcp`                              | The Oncade MCP server on stdio (read-only unless `ONCADE_READ_ONLY=0`)                                   |
| `pnpm tunnel`                           | ngrok to the webhook port only (3001)                                                                    |

Each `pnpm demo` run creates two new $1 test invoices, because idempotency keys are per run. `pnpm dev` needs
`ADMIN_PASSWORD` (12+ characters) and `SESSION_SECRET` (`openssl rand -hex 32`) in `.env`, or `ALLOW_INSECURE_DEFAULTS=1`
for a local admin/admin demo. Plain `pnpm doctor` is pnpm's built-in command and does not run the script.

## Webhooks setup

1. `pnpm tunnel` (ngrok to the webhook port, 3001; the UI port is never exposed).
2. In dev.oncade.xyz, Platform Settings: webhook URL `https://<ngrok-host>/webhooks/oncade`.
3. Copy the webhook secret into `ONCADE_WEBHOOK_SECRET` in `.env` and restart `pnpm dev`.

With `pnpm dev` running, `pnpm demo` then waits up to 60 s for `Platform.Invoice.Created`, `Sent` and `Cancelled` of its
own invoices. How Oncade retries failed deliveries is in [oncade-api-notes.md](oncade-api-notes.md).

## Logs and observability

- Fastify's structured JSON logs (pino) on both apps: one line per request, plus webhook stored, duplicate or rejected
  with the reason, and "daily agent budget reached".
- `data/runs.jsonl`: one line per agent run with source (web, cli, eval), mode, prompt version and hash, model, tools
  called, error or timeout, turns, duration, cost (with `costEstimated` when the CLI reported none) and whether it ran
  sandboxed. `pnpm runs` prints the last 20, an estimate as `~$0.5000 (estimated)`. The daily budget is computed from
  this file plus `data/budget-reservations.json`.
- `data/webhooks.jsonl`: every verified webhook with its arrival time and dedupe key. It rotates at 1 MB to
  `webhooks.jsonl.1`. The agent reads it through `recent_webhooks`, and `pnpm demo` polls it for its own invoices.
- Each answer on the page shows the tools called with their arguments, the mode, whether it ran sandboxed, the time, the
  cost and the prompt version.

## /healthz

`GET /healthz` on the UI port checks that the process is up, that Oncade is reachable (`GET /me`, one attempt, 2.5 s
client timeout, 3 s check timeout) and that the `claude` CLI is found. It returns 200 when all pass and 503 otherwise,
with each check's result. The body carries no paths and no raw error text: the CLI check is `{ "ok": true|false }`, and
an Oncade failure is `timeout`, `http <status>` or `network` (details go to the server log).
