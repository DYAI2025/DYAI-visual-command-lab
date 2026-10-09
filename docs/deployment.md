# Deployment preparation

## Bootstrap guarantees

- `npm ci && npm run build` requires no OpenRouter credential.
- No remote database is required for build/test.
- Health endpoint: `GET /api/health`.
- Provider secrets stay server-side.
- Generation remains fail-closed until DYAI-37 is completed in this repository.

## Runtime

- Node >= 24.15 (< 25); `.nvmrc` pins 24.21.0. `node:sqlite` is used only when `COMMAND_STORE_ADAPTER=sqlite`.
- environment-variable injection for future auth/provider/database configuration
- one Next.js deployable

## Hosting

TBD. D-017 does not choose Vercel, Render, Fly.io, Cloud Run or another provider. A later hosting decision must verify Next.js support, request/body limits, generation timeouts, secret handling, observability and rollback.

## Database

DYAI-39 provides the durable store (SQLite file via `node:sqlite`, `docs/persistence.md`). It is opt-in: without `COMMAND_STORE_ADAPTER=sqlite` the runtime serves the validated static data, which is what the current Render preview (DYAI-48: free plan, ephemeral disk) runs. Production database provisioning, backups, recovery and hosting credentials are a separate, not yet authorised deployment decision; the migration options (persistent disk, libSQL/Turso, PostgreSQL) are listed in `docs/persistence.md`. Never point `DATABASE_URL` at an ephemeral disk for real data.
