# Project brief

**Goal:** a small TypeScript integration against the Oncade test environment, built with AI.
One flow end to end: **invoices**, including webhooks. The AI setup is committed with the code.

**Scope:**

- Read platform info and business readiness.
- List, read, create (draft), send and cancel invoices.
- Ask the business admin for invoice scopes when the grant lacks them (link session).
- Receive Oncade webhooks, verify the HMAC signature, store events, let the agent read them.
- One web page: log in, ask one question, get one answer plus the tools that were used.

**Out of scope:** production keys, persistence beyond a JSONL file, multi-user auth, a UI
framework, multi-turn chat.

**Invariants:**

- Test environment only (`oncade_platform_test_...` keys).
- The webhook verifier never throws.
- The agent can call only the Oncade MCP tools and runs sandboxed where bubblewrap is available.
- Write tools exist in a run only when the user ticked "Allow changes" (or passed `--allow-changes`).
- Only the webhook route is reachable through a tunnel; no default credentials.
- Secrets only in `.env`.
