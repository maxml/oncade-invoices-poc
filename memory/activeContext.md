# Active context

## State (2026-11-18)

- Agent turn works end to end inside bwrap and without it (`pnpm ask`, ~10 s, 3 tool calls).
- Web page, login and webhook receiver verified with curl (200 / 401 paths, event stored and read
  back by the agent through `recent_webhooks`).
- Verified end-to-end run: one prompt created two drafts ($500 and $200), sent the first without
  email, cancelled the second, listed invoices; 7 tool calls, sandboxed, ~$0.03 on Sonnet. The
  server received 4 signed webhooks (`Platform.Invoice.Created` x2, `Platform.Invoice.Sent`,
  `Platform.Invoice.Cancelled`), 0 rejected.
- Published as a public GitHub repo: `maxml/oncade-invoices-poc`.

## Known issues

- The owner grant Oncade creates has only `vc:*` scopes, so invoice calls return 403
  `SCOPE_NOT_GRANTED` until a business admin approves a link session for the invoice scopes
  (done for the current test business). Reported to Oncade as feedback. The agent explains this
  and calls `request_invoice_access`, which returns the approval link.
- New API keys start with no scopes.
- Every run that hits the 403 creates a new link session on Oncade.

## Fixed

- bwrap runs hung until the timeout with no output: `/etc/resolv.conf` is a symlink into `/run`,
  which the sandbox did not mount, so DNS failed. The target is now bound read-only. The runner
  also closes the child's stdin and reports stderr when no result event arrives.
- Oncade's sample webhook verifier throws on a signature of the wrong length; ours returns false
  (regression test in `webhook.test.ts`).
