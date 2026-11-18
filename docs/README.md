# Documentation

How the Oncade invoices PoC is built, secured, tested and run. The [repo README](../README.md) covers setup.

## Reading order for a reviewer

In five minutes:

1. [architecture.md](architecture.md): the components, how one question flows through them, and why each technology.
2. [security.md](security.md): what stops the agent from acting on invoices or emails the user did not name.
3. [oncade-api-notes.md](oncade-api-notes.md): what we learned about the Oncade API that its docs do not say.

If you have more time:

4. [testing.md](testing.md): the tests, the mutation rounds that checked them, what was run for real, and the evals.
5. [roadmap.md](roadmap.md): known limitations, the production checklist and the next improvement.
6. [operations.md](operations.md): configuration, commands, webhook setup, logs and `/healthz`.

## All docs

| Doc                                        | What it covers                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)         | Components, request flow, module and file tables, demo and doctor, technology       |
| [security.md](security.md)                 | Exposure, login, write and email guards, budget ledger, webhooks, sandbox, secrets  |
| [testing.md](testing.md)                   | Test table, mutation-tested findings and fixes, real runs, evals and PromptOps      |
| [operations.md](operations.md)             | Configuration reference, running, webhook setup, logs, `/healthz`                   |
| [roadmap.md](roadmap.md)                   | Known limitations, production checklist, long-lived agent backend                   |
| [oncade-api-notes.md](oncade-api-notes.md) | Scopes, idempotency keys, webhook ids and retries, the sample verifier, money units |

Images used by the README are in [images/](images/). The current project state (last verified run, test count, open
issues) is in [STATUS.md](../STATUS.md).
