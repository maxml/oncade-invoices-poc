# Oncade invoices POC

A small TypeScript integration with the Oncade **test** environment, built with AI. One flow end
to end: **invoices**, including webhooks. Log in, ask a question in plain English ("Create a draft
invoice for Acme, 10 hours at $50", "Show my last 5 invoices"), and an agent answers by calling
the Oncade API through an MCP server, sandboxed. An **Allow changes** box (off by default) decides
whether it may create, send or cancel in that run.

![One screen: a question, the agent's answer, the tools it called, sandbox flag, time and cost](docs/screenshot.png)

Design, security model, tests, evals and the production checklist: [docs/solution.md](docs/solution.md).

## Quick start

Requirements: Node 24+, pnpm 9, the Claude Code CLI (`claude`), optionally `bwrap` (Linux) and `ngrok`.

```bash
pnpm install
cp .env.example .env     # ONCADE_API_KEY (oncade_platform_test_...), ONCADE_BUSINESS_ID,
                         # and ANTHROPIC_API_KEY (or a logged-in Claude Code)
```

Local demo, admin / admin, with a loud warning:

```bash
ALLOW_INSECURE_DEFAULTS=1 pnpm dev      # UI on http://127.0.0.1:3000
```

The secure way: set `ADMIN_PASSWORD` (12+ characters) and `SESSION_SECRET` (`openssl rand -hex 32`)
in `.env`, then `pnpm dev`. Without them the server refuses to start. `GET /healthz` reports
whether Oncade and the `claude` CLI are reachable.

From the terminal: `pnpm ask "Show my last 5 invoices"` (read-only) or
`pnpm ask --allow-changes "Send invoice INV-2026-1234567"`. `pnpm runs` lists the last runs.

## Webhooks

1. `pnpm tunnel` (ngrok to the webhook port, 3001; the UI port is never exposed).
2. In dev.oncade.xyz, Platform Settings: webhook URL `https://<ngrok-host>/webhooks/oncade`.
3. Copy the webhook secret into `ONCADE_WEBHOOK_SECRET` in `.env` and restart `pnpm dev`.

## Checks

```bash
pnpm test           # 152 tests, no network, no secrets
pnpm lint           # ESLint (typescript-eslint); pnpm format:check for Prettier
pnpm typecheck      # TypeScript 7
pnpm eval           # 11 eval cases through the real agent (Sonnet, sandboxed), about $0.14
```

CI (GitHub Actions) runs install, lint, format check, typecheck and test on every push. Last
eval: 11/11 on prompt v3, $0.1419.

## How AI was used

The AI setup is in the repo: `AGENTS.md` holds the rules for any coding agent (commands,
MUST/SHOULD directives, verification and secrets rules), `CLAUDE.md` points to it, `memory/`
keeps the brief, the patterns and the current state.

Claude Code (Opus) wrote the code and did the research, with background subagents for
implementation chunks. Codex, a different model family, fact-checked the research. Code changes
were re-verified by independent verifier subagents (Claude Sonnet, fresh context) that re-applied
every claimed mutation and probed for bypasses. The in-app agent is Claude Code in headless mode on Sonnet. Nothing counted as done until it was
run, and every guard has a test that was seen failing with the guard removed.

Where AI got it wrong, and how it was caught:

- A research agent guessed a documentation URL and reported a broken page (404) that does not
  exist on Oncade's site. The independent Codex check caught it.
- The first sandboxed run hung silently and ended with "no result event": DNS failed inside
  bubblewrap because `/etc/resolv.conf` is a symlink into `/run`. The fix binds the resolver
  file, and the runner now shows stderr when the CLI returns no result.
- An early dependency pin named an SDK version that does not exist.
- When the shell swallowed "$50" from a test prompt, the agent did not guess an amount: it said
  the rate was missing and asked for it, as its system prompt requires.
- The first eval run found that "Send it." **sent** the only draft invoice. Prompt v3 forbids
  acting on an invoice the request does not name, and the MCP server now refuses it as well.
- Mutation testing: an independent verifier re-applied the claimed fixes and found 6 surviving
  mutants (for example, hard-coding `readOnly = false` left every test green). Each now has a
  test that goes red with the mutant applied ([details](docs/solution.md#verification-rounds)).
- A second verifier round found bypasses: parallel runs all passed the daily budget check (the
  cost was written only after a run), a crashed run counted as $0, and an injected note could
  create a draft to an attacker's address and have Oncade email it. Fixed with a shared
  reservation ledger and an email guard, each with a test seen red first.

Oncade issues found while building: the owner grant had only `vc:*` scopes, so invoice calls
returned `SCOPE_NOT_GRANTED` until a link session was approved; new API keys start with no scopes;
the sample webhook verifier throws on a malformed signature (500 instead of 401);
`Idempotency-Key` must be a UUID, which the API reference does not say; platform webhook events
carry no event id; "Mark as paid" in the dashboard emits no `Platform.Invoice.Paid` webhook;
failed webhook deliveries are not retried automatically (attempt #1 stays failed, only a manual
Resend delivers it).
