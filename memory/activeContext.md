# Active context

## State (2026-11-18, after the mutation-testing round)

- An independent verifier re-applied the first review's claims and found 6 surviving mutants
  (readOnly wiring, password/secret length checks, link-session max age, link-session clock skew,
  rotation key reload, method in the idempotency hash), a 5 s timeout kill, a dead `retryable`
  flag and header heuristics as the only tunnel guard. All fixed; each fix has a test seen red
  with the mutant applied.
- New since the first review: UI and webhook receiver on separate ports (3000 / 3001, both
  127.0.0.1; `pnpm tunnel` exposes 3001 only); write guard (send / cancel only invoices named in
  the request or created in the run); daily budget `AGENT_DAILY_BUDGET_USD` (default $2, UTC day,
  from `data/runs.jsonl`); Zod config for the whole env (`packages/config`); `GET /healthz`;
  ESLint + Prettier; GitHub Actions CI.
- `pnpm test`: 114 tests in 9 files (counts per file in `docs/solution.md`). `pnpm lint`,
  `pnpm format:check`, `pnpm typecheck` clean.
- `pnpm eval`: 10/10 on prompt v3, sandboxed, $0.1183
  (`evals/results/2026-11-18T00-45-38-696Z.json`).
- Verified for real: curl on both ports (UI `/login` 200, `/healthz` 200 with all checks; webhook
  port signed 200, duplicate 200, bad signature 401, `/login` `/ask` `/healthz` 404; a proxied UI
  request 404); the write guard against the real MCP server refused a cancel and the invoice
  stayed `draft`; a bad `AGENT_SANDBOX` stops `pnpm dev` with a named error; `pnpm ask` over the
  daily budget prints the reason and exits non-zero (the CLI exits 3, pnpm reports 1).
- Not re-run after the port split: a real webhook from Oncade through ngrok.
- Eval fixtures in the test business: injection invoice `6afcec3653040dcf3786bc56`
  (INV-2026-8999060, `sent`); victim draft `6afcf4e453040dcf3786bda9`
  (`eval-fixture-victim@example.com`); cancel-note invoice `6afcf4e553040dcf3786bdc4`. Each eval
  run also creates two $1 drafts ("Eval Send Target", sent by the run; "Eval Test Co").
- The local `.env` has `ALLOW_INSECURE_DEFAULTS` set and no `ADMIN_PASSWORD` / `SESSION_SECRET`.
- Published as a public GitHub repo: `maxml/oncade-invoices-poc`.

## Known issues

- The owner grant Oncade creates has only `vc:*` scopes, so invoice calls return 403
  `SCOPE_NOT_GRANTED` until a business admin approves a link session for the invoice scopes
  (done for the current test business).
- New API keys start with no scopes.
- Oncade requires `Idempotency-Key` to be a UUID (400 otherwise); not stated in the API reference.
- Platform webhook events have no id and no timestamp header; dedupe is by body hash.
- Sandbox network is fully open; subscription login exposes the OAuth token inside the sandbox.
- typescript-eslint 8 needs TypeScript's JS API (`<6.1`), which TypeScript 7 does not ship: the
  root `typescript` is 6.0.x for the linter, `pnpm typecheck` runs TS 7 from the `typescript-7`
  alias. pnpm overrides / packageExtensions could not redirect the peer (tried).
- Zod reports the PORT / WEBHOOK_PORT clash only once every field is valid.

## Fixed

- Review round 2 (mutation testing): items above.
- Review round 1: exposure, injection/write tools, webhook replays and bad JSON, random
  idempotency keys, cost limits, sandbox `/etc` and credentials, link-session spam, HTTP
  timeouts/retries, tests, run log; PromptOps (versioned prompt, evals).
- bwrap runs hung until the timeout with no output: `/etc/resolv.conf` is a symlink into `/run`.
- Oncade's sample webhook verifier throws on a signature of the wrong length; ours returns false.
