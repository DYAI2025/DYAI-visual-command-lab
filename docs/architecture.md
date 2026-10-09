# Architecture

## Container view

```text
Browser
  |
  +-- Capability Picker / Blue Thread UI
  |       |
  |       +-- public Command view models
  |
  +-- Next.js server boundary
          +-- AuthPort
          +-- Rate / quota / budget ports
          +-- Generation provider boundary
          +-- CommandRepository
          +-- RecipeRepository
          +-- CategoryRepository
                   |
                   +-- bootstrap: validated static JSON adapter
                   +-- DYAI-39: durable relational adapter

Model Capability registry stays outside authoring persistence.
```

## Runtime source transition

VC-01 JSON catalogue and recipes are bootstrap/import inputs. When DYAI-39 persistence is enabled (`COMMAND_STORE_ADAPTER=sqlite`, after `db:migrate` + `db:import`), persisted Commands/Recipes/Categories become runtime authoring/read truth. No manual dual-write contract is allowed: the seed bootstraps the database once; a re-run that matches the imported seed is a no-op, and any changed or new seed entry is refused, never merged or published. A configured but unusable database fails closed instead of falling back to the JSON. Details: `docs/persistence.md`.

## Product shell

The DE/EN root routes use the approved click-dummy UX and semantic Blue Thread. Authentication and generation are not considered production-capable until their own real-boundary slices are verified.
