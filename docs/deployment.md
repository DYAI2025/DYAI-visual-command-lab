# Deployment preparation

## Bootstrap guarantees

- `npm ci && npm run build` requires no OpenRouter credential.
- No remote database is required for build/test.
- Health endpoint: `GET /api/health`.
- Provider secrets stay server-side.
- Generation remains fail-closed until DYAI-37 is completed in this repository.

## Runtime

- Node 24.x
- environment-variable injection for future auth/provider/database configuration
- one Next.js deployable

## Hosting

TBD. D-017 does not choose Vercel, Render, Fly.io, Cloud Run or another provider. A later hosting decision must verify Next.js support, request/body limits, generation timeouts, secret handling, observability and rollback.

## Database

TBD under DYAI-39. Production database hosting is a separate decision. Bootstrap currently binds the repository ports to validated static data.
