# Oncade API notes

What we learned about the Oncade Platform API (test environment) while building this, where it differs from what the
docs say or leaves out. The code handles each point; the file that does it is named in brackets.

## Access and scopes

- The owner grant Oncade creates has only `vc:*` scopes, so invoice calls returned 403 `SCOPE_NOT_GRANTED` until a
  business admin approved a link session for the invoice scopes. This is done for the current test business; the agent's
  `request_invoice_access` tool creates such a link session when needed (`apps/mcp/src/link-session.ts`).
- New API keys start with no scopes.

## Requests

- `Idempotency-Key` must be a UUID; anything else gets 400. The API reference does not say so. The client derives a UUID
  from sha256(run id, method, path, canonical body) (`packages/oncade-client/src/client.ts`).
- Requests carry `Authorization: Bearer <key>`, `X-Oncade-API-Version: v1` and `X-Target-Business-Id` (except
  platform-level calls) against `https://www.oncade.gg/api/v1/platform`.
- Money units: invoice item `rate` and `amount` are dollars, per the Invoices guide. A `rate` of 1 is a $1 item.

## Webhooks

- Platform webhook events carry no event id and no timestamp header. The body's `timestamp` stays the same on retries
  and on a dashboard "Resend". Dedupe is therefore by a hash of the canonical event name, timestamp and data
  (`apps/server/src/webhook-store.ts`).
- "Mark as paid" in the dashboard emits no `Platform.Invoice.Paid` webhook.
- Failed deliveries are retried for only about two minutes, three attempts (for example #1 404, #2 404, #3 status 0, then
  nothing). The retry policy is not documented.
- Oncade's sample webhook verifier throws on a signature of the wrong length, which turns a malformed signature into a
  500 instead of a 401. Ours returns `false` for any missing, malformed or wrong signature
  (`packages/oncade-client/src/webhook.ts`).
