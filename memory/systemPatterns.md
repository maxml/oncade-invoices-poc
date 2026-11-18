# System patterns

## Structure

- `packages/oncade-client/src/client.ts`: typed client for `https://www.oncade.gg/api/v1/platform`.
  Sends `Authorization`, `X-Oncade-API-Version: v1`, `X-Target-Business-Id` (except on
  platform-level calls). Every write carries a deterministic `Idempotency-Key`: a UUID laid out
  from sha256(runId, method, path, canonical JSON body). 15 s timeout per attempt; 429, 5xx,
  network errors and timeouts retried up to 3 attempts with backoff (`Retry-After` honoured).
  Non-2xx throws `OncadeError` with status, endpoint and parsed body (status 0 = no response).
- `packages/oncade-client/src/webhook.ts`: `verifyOncadeSignature(raw, sig, secret)`, hex
  HMAC-SHA256 over the raw body, constant-time compare, returns a boolean.
- `packages/config/src/config.ts`: `parseConfig(env)`, the whole environment as one Zod schema
  (defaults, coercion, empty = unset); throws `ConfigError` naming each bad variable.
- `apps/mcp/src/tools.ts`: `buildServer(client, { readOnly, webhookLog, linkSessionCache,
allowedInvoices })`. Read-only registers read tools + `propose_invoice_change`; allow-changes
  registers the write tools instead. Send / cancel go through `WriteGuard`
  (`apps/mcp/src/write-guard.ts`): allowed only for ids / INV numbers from the request
  (numbers mapped by `getInvoice`) or drafts created in the run; otherwise an error envelope with
  `refused: true`. Every result goes through `envelope()` (`trust: "untrusted_data"`).
  `apps/mcp/src/server.ts` is the stdio entry; `options.ts` maps the env (`ONCADE_READ_ONLY`
  read-only unless exactly `0`; `ONCADE_ALLOWED_INVOICES`; `ONCADE_RUN_ID`).
- `apps/mcp/src/link-session.ts`: reuses the cached link session for 30 min / until `expiresAt`;
  never one dated in the future.
- `apps/agent/src/run-agent.ts`: `runAgent(prompt, { allowChanges, runId, source }, deps?)`.
  Reserves `AGENT_MAX_BUDGET_USD` in the shared ledger first (`reserveBudget`, settled with the
  real or estimated cost by `settleBudget`), then `agentMode()` decides read-only,
  `extractInvoiceRefs()` / `extractEmails()` / `requestAsksForEmail()` give the write permissions,
  all go into the generated MCP config's `env`; one turn of
  `claude -p` with `--output-format stream-json`, `--max-turns`, `--max-budget-usd`, a wall-clock
  timeout. `deps` (config, spawn, which, runsLog, now) are injected in tests.
  `parseAgentStream` (pure) collects tool calls, the `result` event and the model. Appends a
  `RunRecord` to `data/runs.jsonl` (`apps/agent/src/runs.ts`: reader, `spentToday`, the
  reservation ledger `data/budget-reservations.json` with its `.lock`, `BudgetExceededError`,
  `BudgetLedgerError`; `pnpm runs`). `ask.ts` is `pnpm ask`.
- `apps/agent/prompts/system.md` + `CHANGELOG.md`: prompt and its versions (`prompt.ts` reads
  them; a test ties the newest entry's hash to the file). Prettier ignores this folder.
- `apps/server/src/app.ts`: `buildUiApp(deps)` (login, `/ask`, `/healthz`; 404 for proxy headers,
  non-loopback Host or socket) and `buildWebhookApp(deps)` (only `POST /webhooks/oncade`). Both
  testable with `fastify.inject`. `server.ts` serves them on `PORT` and `WEBHOOK_PORT`.
- `apps/server/src/webhook-store.ts`: parse, dedupe (event id or sha256 of raw body), append,
  rotate at 1 MB. `apps/server/src/env.ts`: `loadEnv()` (.env + Zod, exit 1 on error) and
  `securityConfig()`.
- `evals/`: `cases.json` (10 cases, fixtures), `grade.ts` (pure grader, incl. real invoice status
  before / after), `run.ts` (`pnpm eval`), `results/`.
- Tooling: ESLint flat config (`eslint.config.js`), Prettier (`.prettierrc.json`), CI in
  `.github/workflows/ci.yml`.

## Conventions

- TypeScript, ESM, Node 24, run with `tsx` (no build step). Zod for MCP tool inputs and config.
- Errors from Oncade are data for the agent, not crashes.
- Webhook bodies are parsed as raw `Buffer` so the HMAC covers the exact bytes.
- Tests sit next to the code (`*.test.ts`, vitest). Dependencies (fetch, clock, runAgent,
  store) are injected so tests need no network.

## Sandbox (bubblewrap)

`AGENT_SANDBOX=auto|on|off`. With bwrap the agent gets: `/usr` read-only, the `/etc` files in
`ETC_FILES` plus the `resolv.conf` target, the Node install and the Claude Code binary read-only,
the repo read-only, `data/` read-only with `data/state/` writable, a private `/tmp`, an empty tmpfs
`$HOME`, the network, and a cleared environment with an allowlist (`ONCADE_*`,
`ANTHROPIC_API_KEY`, `WEBHOOK_LOG`). `~/.claude/.credentials.json` is bound read-write only when
`ANTHROPIC_API_KEY` is not set.

## Security

- Start-up refuses default `ADMIN_PASSWORD` / `SESSION_SECRET` unless `ALLOW_INSECURE_DEFAULTS=1`.
- Session cookie is a random id, signed, `httpOnly`, `sameSite=lax`, 12 h, kept in memory.
- Two listeners on 127.0.0.1: UI on `PORT` (never tunnelled), webhooks on `WEBHOOK_PORT`
  (`pnpm tunnel`). The UI app also 404s proxied / non-loopback requests.
- Allow-changes runs: send / cancel only on invoices the request names or the run created.
- Daily spend cap: reservations under a lock, across processes; `/ask` 429 (503 if the ledger is
  unavailable), `pnpm ask` exit 3, eval case fails.
- Allow-changes runs: drafts only to an address in the request; `sendEmail: true` only when the
  request asks for email.
- Invalid webhook signature: 401, nothing stored. Signed non-object JSON: 400. Duplicate: 200.
