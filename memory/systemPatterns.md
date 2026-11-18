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
- `apps/mcp/src/tools.ts`: `buildServer(client, { readOnly, webhookLog, linkSessionCache })`.
  Read-only registers read tools + `propose_invoice_change`; allow-changes registers the write
  tools instead of the propose tool. Every result goes through `envelope()` (JSON with
  `trust: "untrusted_data"`). `apps/mcp/src/server.ts` is the stdio entry (env: `ONCADE_READ_ONLY`,
  default read-only; `ONCADE_RUN_ID`).
- `apps/mcp/src/link-session.ts`: reuses the cached link session for 30 min / until `expiresAt`.
- `apps/agent/src/run-agent.ts`: `runAgent(prompt, { allowChanges, runId, source })`, one turn of
  `claude -p` with `--output-format stream-json`, `--max-turns`, `--max-budget-usd`, a wall-clock
  timeout; the mode goes into the generated MCP config's `env`. `parseAgentStream` (pure) collects
  tool calls, the `result` event and the model. Appends a `RunRecord` to `data/runs.jsonl`
  (`apps/agent/src/runs.ts`, reader `pnpm runs`).
- `apps/agent/prompts/system.md` + `CHANGELOG.md`: prompt and its versions (`prompt.ts` reads
  them; a test ties the newest entry's hash to the file).
- `apps/server/src/app.ts`: `buildApp(deps)` (testable with `fastify.inject`): proxy/tunnel
  requests reach only `/webhooks/*`; login with in-memory sessions and a failed-login limiter;
  `/ask` with "Allow changes", a per-session limiter and one run at a time.
- `apps/server/src/webhook-store.ts`: parse, dedupe (event id or sha256 of raw body), append,
  rotate at 1 MB. `apps/server/src/env.ts`: `.env` loading and `securityConfig()`.
- `evals/`: `cases.json`, `grade.ts` (pure grader), `run.ts` (`pnpm eval`), `results/`.

## Conventions

- TypeScript, ESM, Node 24, run with `tsx` (no build step). Zod for MCP tool inputs.
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
- The server listens on 127.0.0.1; requests with proxy headers or a non-loopback Host get 404
  except `/webhooks/*`.
- Invalid webhook signature: 401, nothing stored. Signed non-object JSON: 400. Duplicate: 200.
