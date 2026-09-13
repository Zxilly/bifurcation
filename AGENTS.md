# Repository guidance

## Git commit style

Before every git commit, inspect recent messages with `git log --oneline -20` and match the most recent consistent repository style.

## Architecture

Read docs/PRODUCT.md, docs/ARCHITECTURE.md and docs/DATA-AND-PROTOCOL.md before changing domain behavior. Setup, generation and checks are documented in docs/DEVELOPMENT.md.

The control plane is one self-hosted Next.js process with SQLite. Linux daemons embed sing-box and initiate Connect task streams. Keep permanent machine tokens, account-scoped API Keys, Passkey/backup-password authentication and explicit installation binding semantics.

Preserve authorization policy floors, immutable task payloads, cursor/outbox transactions and acknowledgement-based cleanup. Do not trade revoked access or accounting correctness for apparent availability.

## Code and UI

Keep transport handlers thin and enforce authorization on the server. Generated Go/TypeScript/Ent files must come from their definitions. Use tests at the actual behavior boundary and retain meaningful regressions.

Use Kumo semantic components and styles. User-facing copy should describe state, required input and action consequences. Activation, creation confirmations and first key display are transient flows; machine tokens remain visible to authorized administrators.

Use an independent development database. Never include runtime credentials, local databases, build output or temporary investigations in source changes.
