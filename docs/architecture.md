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

VC-01 JSON catalogue and recipes are bootstrap/import inputs. When DYAI-39 persistence is enabled, persisted Commands/Recipes/Categories become runtime authoring/read truth. No manual dual-write contract is allowed.

## Product shell

The DE/EN root routes use the approved click-dummy UX and semantic Blue Thread. Authentication and generation are not considered production-capable until their own real-boundary slices are verified.
