# System patterns

## Structure

- `packages/oncade-client/src/client.ts`: typed client for `https://www.oncade.gg/api/v1/platform`.
  Sends `Authorization`, `X-Oncade-API-Version: v1`, `X-Target-Business-Id` (except on
  platform-level calls) and an `Idempotency-Key` on writes. Non-2xx throws `OncadeError` with
  status, endpoint and parsed body.
- `packages/oncade-client/src/webhook.ts`: `verifyOncadeSignature(raw, sig, secret)`, hex
  HMAC-SHA256 over the raw body, constant-time compare, returns a boolean.
- `apps/mcp/src/server.ts`: MCP stdio server; each tool wraps a client call and returns API errors
  to the model as JSON data (`isError: true`), so the model can explain them.
- `apps/agent/src/run-agent.ts`: one turn of `claude -p` with `--output-format stream-json`;
  collects `tool_use` blocks and the final `result` event.
- `apps/agent/prompts/system.md`: the agent's rules and answer format.
- `apps/server/src/server.ts`: Fastify page (`/login`, `/ask`) and `POST /webhooks/oncade`.
- `apps/server/src/env.ts`: loads `.env` with Node's `process.loadEnvFile`, fails fast on missing keys.

## Conventions

- TypeScript, ESM, Node 24, run with `tsx` (no build step). Zod for MCP tool inputs.
- Errors from Oncade are data for the agent, not crashes.
- Webhook bodies are parsed as raw `Buffer` so the HMAC covers the exact bytes.
- Tests sit next to the code (`*.test.ts`, vitest).

## Sandbox (bubblewrap)

`AGENT_SANDBOX=auto|on|off`. With bwrap the agent gets: `/usr` and `/etc` read-only, the
`/etc/resolv.conf` target (systemd-resolved keeps it under `/run`), the Node install and the
Claude Code binary read-only, the repo read-only, `data/` read-only, a private `/tmp`, an empty
tmpfs `$HOME` with only `~/.claude/.credentials.json` bound in, the network, and a cleared
environment with an allowlist (`ONCADE_*`, `ANTHROPIC_API_KEY`, `WEBHOOK_LOG`).

## Security

- Session cookie is signed (`SESSION_SECRET`), `httpOnly`, `sameSite=lax`.
- The server listens on 127.0.0.1; webhooks reach it through a tunnel.
- Invalid webhook signature: 401, nothing stored.
