# Security notes

## Secrets

`OPENROUTER_API_KEY` and future auth/rate-limit credentials are server-only. Never commit real values and never expose them through `NEXT_PUBLIC_*` variables.

## Generation boundary

The generation route is designed to fail closed until both authentication and rate-limiting adapters are configured. This is deliberate; a public anonymous image-generation endpoint is not an acceptable fallback.

## Logging

Do not log uploaded image bytes, base64 images, generated image bytes, authentication tokens, or provider credentials.

## Reporting

Until a public security contact is defined, use the repository's private owner/admin channel. Do not publish exploitable details in a public issue.
