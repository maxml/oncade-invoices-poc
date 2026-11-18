# Active context

## State (2026-11-18, after the review fixes)

- A hostile review raised ten findings; all are fixed with a guard at the choke point and a test
  that was seen failing with the guard removed (mutation checks recorded in the commit/report).
- `pnpm test`: 71 tests across client, MCP tools, link-session cache, server routes, webhook
  store, stream parsing, sandbox args, run log, prompt versioning, eval grader. `pnpm typecheck`
  clean.
- `pnpm eval`: 8/8 on prompt v3, sandboxed, $0.060 total
  (`evals/results/2026-11-18T00-09-58-072Z.json`). v2 scored 7/8: "Send it." sent the only draft.
- Verified for real: server refuses default secrets; with real ones, curl showed tunnel requests
  404 except the webhook, login limiter 429 after 5 failures, webhook stored / duplicate /
  400 bad JSON / 401 bad signature; a web `/ask` in read-only mode ran sandboxed and only proposed
  the cancel. Sandboxed runs work with `ANTHROPIC_API_KEY` (no `$HOME` bind) and with the
  subscription credentials file.
- Eval fixture in the test business: invoice `6afcec3653040dcf3786bc56` (INV-2026-8999060,
  receiver `eval-fixture-injection@example.com`, note with a prompt injection). Status is now
  `sent` (the v2 eval run sent it). Each eval run also creates one $1 draft for "Eval Test Co".
- The local `.env` has no `ADMIN_PASSWORD` / `SESSION_SECRET` yet: `pnpm dev` refuses to start
  until the owner sets them (or uses `ALLOW_INSECURE_DEFAULTS=1` for a local demo).
- Published as a public GitHub repo: `maxml/oncade-invoices-poc`.

## Known issues

- The owner grant Oncade creates has only `vc:*` scopes, so invoice calls return 403
  `SCOPE_NOT_GRANTED` until a business admin approves a link session for the invoice scopes
  (done for the current test business). The agent explains this and calls
  `request_invoice_access`, which now reuses a link session for 30 minutes.
- New API keys start with no scopes.
- Oncade requires `Idempotency-Key` to be a UUID (400 otherwise); not stated in the API reference.
- Platform webhook events have no id and no timestamp header; dedupe is by body hash, no
  tolerance window (see README, Known limitations).
- Sandbox network is fully open; subscription login exposes the OAuth token inside the sandbox.

## Fixed

- Review findings 1-10 (exposure, injection/write tools, webhook replays and bad JSON, random
  idempotency keys, cost limits, sandbox `/etc` and credentials, link-session spam, HTTP
  timeouts/retries, tests, run log) and PromptOps (versioned prompt, evals).
- bwrap runs hung until the timeout with no output: `/etc/resolv.conf` is a symlink into `/run`.
  Its target is now bound read-only at `/etc/resolv.conf`.
- Oncade's sample webhook verifier throws on a signature of the wrong length; ours returns false
  (regression test in `webhook.test.ts`).
