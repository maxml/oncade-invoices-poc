# Limitations and roadmap

## Known limitations

- The network inside the sandbox is fully open. bwrap can share or cut the network but cannot filter it; limiting egress
  to Oncade and Anthropic needs a proxy or firewall rules.
- A subscription login puts the OAuth token in the sandbox (read-write). Use `ANTHROPIC_API_KEY`.
- The write guard's authorisation is lexical. Any invoice id or number in the request counts as named, including one
  inside a quote or pasted text and the id in "do NOT cancel <id>". The same goes for receiver addresses and for the word
  "email": a negation ("do not email it", "send it without email") still allows `sendEmail: true`. Text the user pastes
  into the request, such as an invoice note carrying an injected instruction, counts as the user's own words. Addresses
  are taken only when the whole token is an ASCII address; anything else, an internationalised address included, is not
  allowed. The guard does not parse intent. It narrows what an injection can reach to what the user typed, and inside
  that the system prompt ("act only on what the user asked") and the model decide. The eval case `do-not-cancel-named`
  checks the model on exactly this. A draft for a customer named only by name ("invoice Acme like last time") is
  refused, because the address has to be in the request.
- Budget reservations are conservative. Each run holds `AGENT_MAX_BUDGET_USD` while it runs, so near the cap fewer runs
  start than would fit their real cost. The cap counts what the CLI reports, or the per-run maximum when it reports
  nothing. Several failure modes fail closed, blocking budget and never freeing it:
  - A process killed before it settled (kill -9, power loss) leaves its reservation in the ledger for the rest of that
    UTC day.
  - A lock whose holder is still running is never taken over, so a hung process holding it refuses runs until it exits.
    A pid reused by an unrelated process makes a dead lock look alive, with the same effect.
  - A process that dies in the microseconds between claiming a dead lock and replacing it leaves a `.reap-*` file that
    blocks the takeover until it is removed by hand (the error names the lock file).
  - Any invalid ledger entry refuses every run until the file is fixed.
- The budget is shared only between processes that use the same `RUNS_LOG` (the ledger and its lock sit next to it); a
  process with a different `RUNS_LOG` has its own budget.
- Idempotency is per run. Two identical invoices in one run become one; across runs the same request creates a new
  invoice each time. That is why each `pnpm demo` run makes new invoices.
- There is no webhook timestamp window. Oncade sends no timestamp header and the body's `timestamp` stays the same on
  retries, so replays are caught by dedupe only, and dedupe memory covers the current log and one rotated file. Two
  genuinely different deliveries with the same event name, timestamp and data would be treated as one.
- Rate limits, sessions and the one-run lock are in memory and per process. A busy server answers 429; there is no
  queue.
- Read-only mode still allows `request_invoice_access`, which creates an Oncade link session (at most one per 30 minutes)
  for a business admin to approve.
- Config errors come in two passes when the port clash is not the only problem: Zod runs the cross-field check only
  after every field is valid.
- The evals are small and single-sample: eleven cases, one run each, against live test data. A pass says how the model
  behaved on those eleven runs.
- The demo's 60 s webhook wait has been tested only against a fake log, and a real webhook through the tunnel has not
  been re-run since the UI and the webhook receiver moved to separate ports ([testing.md](testing.md#run-for-real)).

## Production checklist

The owner's monorepo starter lists what a production-leaning repo has to answer. For a PoC with one page, one webhook
route and JSONL files, the cheap and relevant items are done and the rest are skipped on purpose.

| Starter item                               | Status             | Why                                                                                                               |
| ------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Configuration and env validation           | Done               | One Zod schema for the whole env, fail fast with the variable's name                                              |
| Health checks                              | Done               | `GET /healthz`: process, Oncade (`/me`, short timeout), `claude` CLI; 200 / 503                                   |
| Input validation                           | Done               | Zod on every MCP tool input and on the config; the forms have two fields                                          |
| HTTP client and error envelope             | Done               | Typed client, `OncadeError`, timeouts, retries; tool results always in one envelope                               |
| API framework                              | Done               | Fastify                                                                                                           |
| Auth                                       | Done, minimal      | One admin user, signed session cookie, login rate limit; multi-user auth is out of scope                          |
| Telemetry                                  | Partial            | Structured pino logs and `data/runs.jsonl`; no OpenTelemetry exporter for a local PoC                             |
| CI                                         | Done               | GitHub Actions: install, lint, format check, typecheck, test. Evals are not in CI (they cost money and need keys) |
| Lint / format / pre-commit                 | Done without hooks | ESLint + Prettier; Husky / lint-staged skipped, CI enforces the same checks                                       |
| Testing                                    | Done               | Vitest; fetch, clock and CLI injected instead of MSW; no Playwright for one server-rendered page                  |
| AI agent configuration                     | Done               | `AGENTS.md` (rules and agent context) + `STATUS.md` (current state)                                               |
| Package management                         | Done               | pnpm with a lockfile; one package, so no workspaces                                                               |
| Monorepo orchestration (Nx)                | Skipped            | Five small source folders and plain pnpm scripts; nothing to cache or order                                       |
| Database, ORM, DB TLS                      | Skipped            | Runs and webhooks are append-only JSONL files                                                                     |
| Caching / Redis, queues, realtime          | Skipped            | One process, one agent run at a time by design                                                                    |
| File storage, email                        | Skipped            | Not part of the invoices flow (Oncade sends invoice email itself)                                                 |
| Containerization, deploy manifest          | Skipped            | The agent needs bubblewrap and a local Claude Code CLI; nesting that in a container is not worth it for a PoC     |
| Error reporting backend                    | Skipped            | Errors are logged and returned to the page                                                                        |
| API contract / OpenAPI                     | Skipped            | No public API: four HTML routes and one webhook                                                                   |
| Frontend architecture, design system, i18n | Skipped            | One server-rendered page                                                                                          |
| Dependency / code scanning (Snyk)          | Skipped            | Five runtime dependencies; worth adding before anything real                                                      |

## Next improvement: a long-lived agent backend

Every question starts two processes: `claude -p`, and inside it the MCP server over stdio. That costs 3 to 10 seconds
per question, and the configuration is read again each time. For a product I would change four things:

1. Serve MCP over HTTP. Run the MCP server once, next to the app, using the Streamable HTTP transport from
   `@modelcontextprotocol/sdk` on a local port. `claude -p` then connects to it by URL (`"type": "http"` in
   `--mcp-config`), so no Node process starts per question.
2. Move per-run permissions from environment variables into a session. Today read-only mode, the allowed invoice ids and
   emails, and the run id behind the idempotency keys reach the MCP server as environment variables, because the process
   is new for every run. A long-lived server needs a run token instead: `runAgent` registers the run's permissions with
   the server and gets a short-lived token back, the MCP client sends it in a header, and the write guard applies the
   permissions of the session that owns the token. The main risk is mixing up two runs' permissions, so this needs
   tests for session isolation.
3. Keep the sandbox narrow. The sandbox still needs network access, but only to the local MCP port. The simple option is
   to bind MCP to 127.0.0.1 and require the token. The stricter one is a Unix socket mounted into the sandbox.
4. Replace the CLI with an in-process agent loop. Starting `claude -p` is the other half of the delay. An agent loop on
   the Anthropic SDK (Messages API with tool use), running in the same process as the server, removes both the CLI start
   and the need to sandbox the model process. Only the tools need isolation then. It is the biggest change, and the
   right one for a product.

Estimate: half a day for points 1 to 3 including the session-isolation tests, and one more day for point 4.
