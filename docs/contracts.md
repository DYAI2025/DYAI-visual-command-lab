# Contract ownership

## Command

Human-facing capability metadata consumed by the UI. It contains no provider-specific prompt logic.

## Recipe

Versioned execution semantics, preservation rules, constraints and evaluation state. Server-side ownership.

## Model Capability

Provider/runtime capability plus allowlist, benchmark and privacy state. It remains separate from authoring persistence.

## Persistence

`CommandRepository`, `RecipeRepository` and `CategoryRepository` are server-only ports. By default they bind to the validated static artefacts; with `COMMAND_STORE_ADAPTER=sqlite` they bind to the DYAI-39 durable store (SQLite via `node:sqlite`), which also provides the operator-only `AuthoringRepository` and the deterministic VC-01 import. The store validates every write against these contracts and the separate Model Capability registry; the registry itself is never persisted there. The VC-02 authoring lifecycle (`DRAFT/TESTING/ACTIVE/ARCHIVED`) is stored next to, never instead of, the Command `maturity`/`evidence`. See `docs/persistence.md`.
