# Architecture

A small TypeScript integration with the Oncade Platform API (test environment). You log in, ask one question in plain
English ("how many invoices do we have?", "create a draft for Acme, 10 hours at $50"), and an AI agent answers by calling
the Platform API through an MCP server. Oncade's webhooks come back to a separate port, where they are verified and
stored, and the agent can read them. `pnpm demo` runs the same invoice flow on the API client alone, without an LLM, and
`scripts/doctor.sh` tells a new machine what it can run.

## Components and request flow

```
                 127.0.0.1:PORT (3000), never tunnelled
 browser ──────► UI app: /login, /ask, /healthz ──► runAgent() ── reserve budget (shared ledger)
                                                       │  allowed invoices / emails = from the request
                                                       ▼
                                          bubblewrap ─► claude -p (Sonnet, no built-in tools)
                                                       │ stdio
                                                       ▼
                                   MCP server "oncade" ──► Oncade Platform API (test)
                                   (write guard, envelope)        │
                                                       ▲          │ webhooks
                                    recent_webhooks    │          ▼
 data/runs.jsonl ◄── one line per run    data/webhooks.jsonl ◄── webhook app: POST /webhooks/oncade
                                                                  127.0.0.1:WEBHOOK_PORT (3001)
                                                                  ▲
                                                       ngrok ─────┘  (`pnpm tunnel` exposes only this port)
```

One question goes through these steps:

1. The UI app (or `pnpm ask`) calls `runAgent`. It reserves the run's budget in the shared ledger, decides the mode
   (read-only unless the user allowed changes) and extracts from the request the invoice ids, invoice numbers and email
   addresses the run may act on.
2. `runAgent` writes an MCP config that carries the mode and those permissions as environment variables, then starts one
   turn of `claude -p` inside bubblewrap. The CLI has no built-in tools; its only tools come from the `oncade` MCP
   server, which it starts over stdio.
3. The MCP server calls the Oncade Platform API through the typed client. Every write passes the write guard, and every
   tool result goes back to the model wrapped in an `untrusted_data` envelope.
4. When the CLI exits, `runAgent` parses its stream (tool calls, answer, cost), appends a line to `data/runs.jsonl` and
   settles the reservation.

Oncade's webhooks arrive on a different process and port. The tunnel points at an app that has only
`POST /webhooks/oncade`; the UI is not on that port. The webhook app verifies the signature, dedupes and appends to
`data/webhooks.jsonl`, which the agent reads through the `recent_webhooks` tool. The UI app also keeps a header check and
a loopback check on the socket's remote address as defence in depth (see [security.md](security.md)).

## Modules

| Path                     | What it is                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `packages/oncade-client` | Typed Platform API client (test keys only, timeouts, retries, deterministic idempotency keys), webhook verifier |
| `packages/config`        | The whole environment as one Zod schema; every entry point reads settings from it                               |
| `apps/mcp`               | Invoice tools as an MCP stdio server; read-only unless told otherwise; the write guard                          |
| `apps/agent`             | `runAgent` (one sandboxed turn of `claude -p`), `pnpm ask`, the run log, the daily budget, the system prompt    |
| `apps/server`            | The UI app and the webhook app, and the entry point that serves them on two ports                               |
| `apps/demo`              | `pnpm demo`: create, send, cancel and read invoices with the API client alone, then wait for their webhooks     |
| `scripts/doctor.sh`      | Checks Node, pnpm, dependencies and `.env` (values never printed), prints fix hints and what can run; `--fix`   |
| `evals`                  | Eval cases, deterministic grader, runner, committed results                                                     |

### Key files

- `packages/oncade-client/src/client.ts`: the client for `https://www.oncade.gg/api/v1/platform`. It sends
  `Authorization`, `X-Oncade-API-Version: v1` and `X-Target-Business-Id` (except on platform-level calls). Every write
  carries a deterministic `Idempotency-Key`. A non-2xx response throws `OncadeError` with the status, the endpoint and
  the parsed body (status 0 means no response).
- `packages/oncade-client/src/webhook.ts`: `verifyOncadeSignature(raw, sig, secret)`, hex HMAC-SHA256 over the raw body
  with a constant-time compare. It returns a boolean and never throws.
- `packages/config/src/config.ts`: `parseConfig(env)` (defaults, coercion, empty counts as unset) throws `ConfigError`
  naming each bad variable. `parseOncadeConfig` validates only the Oncade part, for `pnpm demo`.
- `apps/mcp/src/tools.ts`: `buildServer(client, options)`. In read-only mode it registers the read tools and
  `propose_invoice_change`; with changes allowed it registers the write tools instead. Every result goes through
  `envelope()` (`trust: "untrusted_data"`). `apps/mcp/src/write-guard.ts` holds the `WriteGuard`, `server.ts` is the
  stdio entry, and `options.ts` maps the env (`ONCADE_READ_ONLY`, `ONCADE_ALLOWED_INVOICES`, `ONCADE_ALLOWED_EMAILS`,
  `ONCADE_EMAIL_ALLOWED`, `ONCADE_RUN_ID`).
- `apps/mcp/src/link-session.ts`: reuses the cached link session for 30 minutes or until `expiresAt`, and never one
  dated in the future.
- `apps/agent/prompts/system.md` and `CHANGELOG.md`: the system prompt and its versions. `prompt.ts` reads them, and a
  test ties the newest entry's hash to the file. Prettier ignores this folder.
- `apps/server/src/app.ts`: `buildUiApp(deps)` (login, `/ask`, `/healthz`) and `buildWebhookApp(deps)` (only
  `POST /webhooks/oncade`), both testable with `fastify.inject`. `server.ts` serves them on `PORT` and `WEBHOOK_PORT`.
  `webhook-store.ts` parses, dedupes, appends and rotates the webhook log. `env.ts` has `loadEnv()` (`.env` plus Zod,
  exit 1 on error) and `securityConfig()`.
- `evals/`: `cases.json` (the cases and their fixtures), `grade.ts` (pure grader, including the real invoice status
  before and after a run), `run.ts` (`pnpm eval`), `results/`.
- Tooling: ESLint flat config (`eslint.config.js`), Prettier (`.prettierrc.json`), CI in `.github/workflows/ci.yml`.

### Inside `apps/agent/src`

One file per concern:

| File               | What it does                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `run-agent.ts`     | `runAgent`: reserves the budget, writes the MCP config, starts the CLI, builds the result, settles the run |
| `request-scope.ts` | `agentMode()` (the only place the mode is decided) and the invoices and emails the request allows          |
| `mcp-config.ts`    | The `oncade` MCP server config for one run (mode and permissions in its env) and the write tool names      |
| `sandbox.ts`       | bwrap arguments, `ETC_FILES`, and the allowlisted env the agent gets                                       |
| `cli-process.ts`   | Starts the CLI, collects stdout and stderr, kills it at the timeout                                        |
| `stream-parser.ts` | `parseAgentStream` (tool calls, result event, model) and the answer / error status of a run                |
| `budget.ts`        | The daily cap: `spentToday`, the reservation ledger and its lock, `reserveBudget`, `settleBudget`, errors  |
| `runs-log.ts`      | `data/runs.jsonl`: `RunRecord`, append, read, `formatRuns` (`pnpm runs`)                                   |
| `ask.ts`, `cli.ts` | `pnpm ask`                                                                                                 |
| `prompt.ts`        | The system prompt's version and hash                                                                       |

`runAgent(prompt, { allowChanges, runId, source }, deps?)` runs one turn of `claude -p` with
`--output-format stream-json`, `--max-turns`, `--max-budget-usd` and a wall-clock timeout. Tests inject `deps` (config,
spawn, which, runsLog, now).

## The demo and the doctor

`pnpm demo` (`apps/demo/src/demo.ts`) lets a reviewer see the flow without an LLM. It creates a $1 draft for
`demo@example.com` and sends it with `sendEmail: false`, creates a second draft and cancels it, and reads both back,
printing each id, number and status. Each run has its own run id (`demo-<timestamp>`), so every write's Idempotency-Key
is deterministic within the run, and the two drafts, which differ in name and item, get different keys. If
`ONCADE_WEBHOOK_SECRET` is set and something listens on `127.0.0.1:WEBHOOK_PORT`, it polls `data/webhooks.jsonl` for up
to 60 s for `Platform.Invoice.Created`, `Sent` and `Cancelled` with exactly these two invoice ids, and exits 1 with the
missing events and a hint if they do not come. Otherwise it labels the webhook step optional, prints
"Demo finished: the invoice flow worked (draft, send, cancel, read back).", shows how to set up webhooks and exits 0.
Every failure (missing settings, Oncade API error, webhook timeout) prints a "Demo FAILED: ..." line and exits 1.

`scripts/doctor.sh` runs on bash 3.2 (macOS) and later and needs no sudo. It reads each variable the way the app does
(the shell first, then the last line in `.env`) and reports only whether it is set, its prefix (the test key) or its
length (admin password and session secret). It never installs system packages; it prints the command instead. With
`--fix` it offers `corepack enable`, `pnpm install` and `cp .env.example .env`, each after a y/N question, and skips them
when stdin is not a terminal. Run it as `./scripts/doctor.sh` or `pnpm run doctor` (plain `pnpm doctor` is a built-in
pnpm command and does not run the script).

## Technology

| Part          | Technology                                             | Why                                                                                                                                                                             |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API client    | TypeScript, `fetch`, typed `OncadeError`               | Small and readable. It refuses any key that is not `oncade_platform_test_...`, so the PoC cannot touch live money                                                               |
| Configuration | Zod 4                                                  | One schema for every variable; a bad value stops start-up with the variable's name and what is wrong                                                                            |
| Agent tools   | MCP server (`@modelcontextprotocol/sdk`, stdio)        | Invoice tools defined once and usable from any MCP client: this app, Claude Code, Codex, an IDE                                                                                 |
| Agent runtime | Claude Code CLI in headless mode (`claude -p`)         | No agent loop to write; works with `ANTHROPIC_API_KEY` or a Claude Code login; the model is one setting                                                                         |
| Isolation     | bubblewrap (`bwrap`)                                   | The agent process sees a read-only system and repo, a private `/tmp`, and nothing of `$HOME` beyond what it needs                                                               |
| Web           | Fastify 5, signed session cookie, server-rendered HTML | One screen and one webhook route; no frontend build                                                                                                                             |
| Webhooks      | HMAC-SHA256 over the raw body, constant-time compare   | The verifier never throws (Oncade's sample does on a short signature); dedupe by event id or content hash                                                                       |
| Tests         | Vitest, `fastify.inject`, injected fetch/clock/CLI     | No network and no secrets in tests, so CI needs none                                                                                                                            |
| Lint, format  | ESLint 10 (flat config, typescript-eslint), Prettier   | `pnpm lint`, `pnpm format:check`, both in CI                                                                                                                                    |
| Typecheck     | TypeScript 7 (`pnpm typecheck`)                        | typescript-eslint needs TypeScript's JS API, which TS 7 does not ship, so the root `typescript` is 6.0.x for the linter and `typecheck` runs TS 7 from the `typescript-7` alias |
| CI            | GitHub Actions                                         | install, lint, format check, typecheck, test on every push and pull request                                                                                                     |

## Conventions

- TypeScript, ESM, Node 24, run with `tsx` (no build step). Zod for MCP tool inputs and the config.
- Errors from Oncade are data for the agent and do not crash the run.
- Webhook bodies are parsed as a raw `Buffer`, so the HMAC covers the exact bytes.
- Tests sit next to the code (`*.test.ts`, Vitest). Dependencies (fetch, clock, runAgent, store) are injected, so tests
  need no network.
