# Status

Current state of the project. Update it when what works, the numbers below, or an open issue changes. History is in
`git log` and in [docs/testing.md](docs/testing.md).

## Current state (2026-11-18)

- The invoices flow works end to end against the Oncade test API: list, read, create a draft, send, cancel, ask for
  invoice scopes, and receive signed webhooks.
- `pnpm demo` (API client only, no LLM) last run for real on 2026-11-18: draft `6afd631504c10f21fe8b8c62` sent, draft
  `6afd631604c10f21fe8b8c7e` cancelled, both read back. It ends with "Demo finished: the invoice flow worked (draft,
  send, cancel, read back)."; any failure prints "Demo FAILED: ..." and exits 1. The webhook step is optional.
- The README's curl block, run as written on 2026-11-18, did the same as the demo.
- `scripts/doctor.sh` passes every check on the dev machine except ngrok: the machine's default authtoken is expired and
  the probe reports `ERR_NGROK_107`. The doctor screenshot in the README is from an earlier run.
- `pnpm test`: 194 tests in 11 files. `pnpm lint`, `pnpm format:check`, `pnpm typecheck` green; CI green on `main`.
- Last eval: 11/11 on prompt v3 (Sonnet, sandboxed), $0.1419, `evals/results/2026-11-18T01-16-37-309Z.json`. Prompt and
  agent behaviour have not changed since.
- Published as the public GitHub repo `maxml/oncade-invoices-poc`.

## Eval fixtures in the Oncade test business

- Injection invoice `6afcec3653040dcf3786bc56` (INV-2026-8999060, `sent`).
- Victim draft `6afcf4e453040dcf3786bda9` (`eval-fixture-victim@example.com`), re-created by `pnpm eval` if a failed run
  cancelled it.
- Cancel-note invoice `6afcf4e553040dcf3786bdc4`.
- Each eval run also creates two $1 drafts ("Eval Send Target", sent by the run, and "Eval Test Co").

## Open issues

- Not run for real since the UI and the webhook receiver moved to separate ports: a real Oncade webhook through ngrok,
  and the demo's 60 s webhook wait (tested only against a fake log). Needs a valid ngrok authtoken.
- The write guard's authorisation is lexical ("do NOT cancel <id>" authorises <id>; "without email" allows email).
  Documented, not fixed; see [docs/roadmap.md](docs/roadmap.md#known-limitations) for this and the other limitations.
- typescript-eslint 8 needs TypeScript's JS API (`<6.1`), which TypeScript 7 does not ship. The root `typescript` is
  6.0.x for the linter and `pnpm typecheck` runs TS 7 from the `typescript-7` alias. pnpm overrides and
  packageExtensions could not redirect the peer (tried).
- Oncade-side issues (scopes, UUID idempotency keys, no event id, no Paid webhook on "Mark as paid", short retries) are
  in [docs/oncade-api-notes.md](docs/oncade-api-notes.md).
