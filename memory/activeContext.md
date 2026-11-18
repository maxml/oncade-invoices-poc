# Active context

## State (2026-11-18, after verification round 3)

- Round 3 (independent verifier on ab1acbe): every earlier mutation re-applied and killed; new
  findings fixed with tests seen red first (docs/solution.md, Verification rounds): non-ASCII
  address tokens yield no allowed address; the ledger lock carries an owner token, a live
  holder is never taken over, one taker per dead lock (O_EXCL reap file + re-read + rename),
  8-process test; ledger entries validated with Zod (fail closed), future-dated entries kept;
  nothing that can throw runs between the reservation and its settle; ledger / 503 / exit 3 /
  normalised receiver email pinned. From the live test: webhook dedupe key from canonical
  event + timestamp + data, recomputed for stored lines on load (legacy lines without
  `dedupeKey` now dedupe).
- `pnpm test`: 186 tests in 10 files. No eval re-run: prompt and agent behaviour unchanged.

## Earlier: after verification round 2

- Round 2 (independent verifier on 54b65e5) found bypasses; all fixed, each test seen red first
  (details in `docs/solution.md`, Verification rounds): the daily budget is now a reservation
  ledger (`data/budget-reservations.json`, `O_EXCL` lock, shared across processes, fail closed);
  a run without a reported cost counts `AGENT_MAX_BUDGET_USD` with `costEstimated: true`; drafts
  only to an address in the request and `sendEmail: true` only when it asks for email
  (`ONCADE_ALLOWED_EMAILS`, `ONCADE_EMAIL_ALLOWED`); invoice ids normalised once; `/healthz`
  without paths or raw errors; `listenBoth` binds 127.0.0.1 (tested); tests throw under vitest
  instead of using the real spawn / which / fetch. New eval case `do-not-cancel-named`.
- `pnpm test`: 152 tests in 9 files. `pnpm eval`: 11/11 on prompt v3, $0.1419
  (`evals/results/2026-11-18T01-16-37-309Z.json`).
- Known, documented, not fixed: the write guard's authorisation is lexical ("do NOT cancel <id>"
  authorises <id>; "without email" allows email).

## Earlier: after the mutation-testing round

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
- Platform webhook events have no id and no timestamp header; dedupe is by a hash of the
  canonical event + timestamp + data (a "Resend" repeats all three).
- Sandbox network is fully open; subscription login exposes the OAuth token inside the sandbox.
- typescript-eslint 8 needs TypeScript's JS API (`<6.1`), which TypeScript 7 does not ship: the
  root `typescript` is 6.0.x for the linter, `pnpm typecheck` runs TS 7 from the `typescript-7`
  alias. pnpm overrides / packageExtensions could not redirect the peer (tried).
- Zod reports the PORT / WEBHOOK_PORT clash only once every field is valid.

- Oncade: "Mark as paid" in the dashboard emits no `Platform.Invoice.Paid` webhook; failed webhook
  deliveries are not retried automatically (only manual Resend).

## Fixed

- Verification round 2 (bypasses): budget race, unrecorded cost, fail-open log, create-then-email,
  id normalisation, healthz leaks, bind address test, vitest guards.
- Review round 2 (mutation testing): items above.
- Review round 1: exposure, injection/write tools, webhook replays and bad JSON, random
  idempotency keys, cost limits, sandbox `/etc` and credentials, link-session spam, HTTP
  timeouts/retries, tests, run log; PromptOps (versioned prompt, evals).
- bwrap runs hung until the timeout with no output: `/etc/resolv.conf` is a symlink into `/run`.
- Oncade's sample webhook verifier throws on a signature of the wrong length; ours returns false.
