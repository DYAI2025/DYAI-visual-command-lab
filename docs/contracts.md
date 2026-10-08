# Contract ownership

## Command

Human-facing capability metadata consumed by the UI. It contains no provider-specific prompt logic.

## Recipe

Versioned execution semantics, preservation rules, constraints and evaluation state. Server-side ownership.

## Model Capability

Provider/runtime capability plus allowlist, benchmark and privacy state. It remains separate from authoring persistence.

## Persistence

`CommandRepository`, `RecipeRepository` and `CategoryRepository` are server-only ports. Bootstrap binds them to validated static artefacts. DYAI-39 supplies a durable relational implementation and deterministic VC-01 import path.
