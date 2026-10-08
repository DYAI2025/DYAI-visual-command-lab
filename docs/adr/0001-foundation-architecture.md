# ADR-0001: Standalone Next.js modular monolith for Visual Command Lab

- Status: accepted
- Original decision: 2026-10-06 (D-013)
- Standalone carry-forward: 2026-10-08 (D-017)

## Decision

Use one Next.js 16.3.8 App Router application on Node 24 with React 19.3 and TypeScript 6.0.3. UI, command contracts, authoring persistence boundaries, authentication, rate/cost controls and provider execution remain inside one deployable modular monolith with explicit module ports.

Canonical repository: `DYAI2025/DYAI-visual-command-lab`.

## Data boundary

Command, Recipe and Model Capability remain separate. D-014 permits durable Commands/Recipes/Categories behind server-side repository ports. Model Capability remains a separate runtime registry. Bootstrap uses validated static artefacts; DYAI-39 replaces the adapter with durable persistence.

## Deployment boundary

No hosting provider or production database host is selected here. Build/test must not require provider credentials or a remote managed database.

## Review triggers

Re-open if a standalone API becomes necessary, generation becomes durable/asynchronous, another client requires the backend, or hosting/security/operational evidence makes this structure materially inferior.
