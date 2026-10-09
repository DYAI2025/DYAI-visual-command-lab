# Durable authoring persistence (DYAI-39)

Commands, versioned Recipes and Categories live in a relational database behind the server-side
repository ports. Operators create and maintain them without editing source catalogue files. Model
Capability stays in its own runtime registry (`src/server/models`) and is never written to this
database (D-014, D-017, ADR-0001).

## Engine and why

| Decision | Choice | Reason |
|---|---|---|
| Engine | SQLite through Node's built-in `node:sqlite` (Node ≥ 24.15, where the module is a release candidate) | Real durable file storage with transactions, `FOREIGN KEY`, `UNIQUE`, `CHECK`, `STRICT` tables and triggers. It adds no npm dependency and no native build. Local runs and CI need no service, so there is no remote prerequisite (DYAI-39 invariant 11). Next.js 16 keeps it as an external built-in with no config. |
| Access layer | Plain SQL in `src/server/persistence/sqlite-store.ts`, no ORM | The domain is small and the contract validators (DYAI-31) already define every record. An ORM would add a second schema language. |
| Migrations | Ordered, append-only entries in `src/server/persistence/migrations.ts`, recorded with their sha256 in `schema_migrations` | Deterministic, and bundled with the server code (no runtime file reads). A changed or unknown migration is refused (`SCHEMA_DRIFT`), and so is a database whose tables, indexes or triggers differ from what its recorded migrations create (compared with a freshly migrated in-memory reference at open). |
| Rejected | `better-sqlite3` (native addon), PGlite (pre-1.0, about 25 MB), Postgres + testcontainers (needs Docker locally and a hosted DB later; paid resources are out of scope) | See the DYAI-39 Jira preflight comment for the measured comparison. |

## Runtime selection

| `COMMAND_STORE_ADAPTER` | `DATABASE_URL` | Runtime |
|---|---|---|
| unset / `static` | ignored | Validated bootstrap JSON, exactly as before DYAI-39. This is the default and the current Render preview. |
| `sqlite` | `file:` URL of an existing, migrated file | The durable store serves Commands/Recipes/Categories. |
| `sqlite` | missing, non-`file:`, in-memory, absent file, unopenable path, unmigrated, drifted or corrupt | Fail closed. `CatalogueStoreError` with code `CONFIG_INVALID`, `DATABASE_MISSING`, `DATABASE_UNREADABLE`, `SCHEMA_NOT_MIGRATED`, `SCHEMA_DRIFT` or `DATABASE_CORRUPT`. A SQLite failure at query time (after open) is `DATABASE_UNREADABLE` too, and lock contention past the busy timeout is `DATABASE_BUSY` (transient). The schema-object comparison runs at open, not on every query. Pages error, and `/api/generate` answers `503 catalogue_unavailable`. **There is no fallback to the static JSON.** |
| anything else | – | `CONFIG_INVALID` |

The runtime never creates or migrates a database. The sqlite module is loaded only when it is
configured (`src/server/catalogue/index.ts`), so the default runtime never touches `node:sqlite`.

## Source-of-truth transition

1. **Before activation**, `src/domain/commands/catalogue.json` and `src/server/recipes/recipes.json` are the runtime source (static adapter).
2. **Bootstrap**:
   * `npm run db:migrate -- --database <file>` creates the schema.
   * `npm run db:import -- --database <file>` imports the VC-01 seed. The import validates the whole bundle against the contract, with the registry, and runs in one transaction. VC-01 commands enter `ACTIVE` (they are the published catalogue) with origin `vc01_import`, and their recipe versions are marked as seed-imported.
   * The first successful import is the bootstrap. Authored content that does not collide with the seed may already exist. A seed slash, command id or recipe id that is already authored (even with identical content) is a conflict, so a seed command is never bound to a recipe history it was not validated with.
3. **After activation** (`COMMAND_STORE_ADAPTER=sqlite`), the database is the runtime truth for Commands, Recipes and Categories. Authoring writes go through `AuthoringRepository` only. The JSON files are not written back and are not read at runtime: they are the historical seed. The import bootstraps once; a re-run only confirms the seed:
   * A seed command or recipe equal to what the seed originally imported counts as `unchanged`, even if an operator has since edited the persisted command or authored newer recipe versions. Commands are compared with their `import` revision, not today's record; recipe versions only with seed-imported versions. Such a re-run changes no catalogue content and only records an `import_runs` row.
   * A seed entry that differs from what was imported, or that is new after the bootstrap, is refused as a whole (`IMPORT_CONFLICT`, nothing written). Adding a command to the JSON therefore never publishes it: new content is authored through the repository and goes `DRAFT → TESTING → ACTIVE`.
   * No JSON-to-database dual-write contract exists.
4. Model Capability stays in the committed registry (`src/server/models/registry.json`) behind `ModelRegistryPort`. The store reads it only to validate writes.

The click-dummy prototype route (`/[locale]/click-dummy`, PROTOTYPE ONLY) keeps reading the bootstrap
catalogue directly. It is a frozen demonstration artefact, not a runtime catalogue consumer. The product
route `/[locale]` and `/api/generate` read through the repositories.

## Data model

| Table | Holds | Guarantees |
|---|---|---|
| `commands` | The full contract `CommandRecord` as canonical JSON, plus projected columns (`lane`, `maturity`, `lifecycle`, `recipe_id`, DE/EN texts) and metadata (`origin`, `revision`, `created_at`, `updated_at`, `archived_at`) | `CHECK`s tie every projected column to the stored document. `canonical_slash = '/' \|\| id` is `UNIQUE`. Blank DE/EN text is refused. A row is never deleted. Identity is fixed. Every write is exactly one new revision. |
| `command_slashes` | Every canonical slash and alias, catalogue-wide | One slash names one command. Archived commands keep theirs. |
| `recipe_versions` | One immutable row per `(recipe_id, version)` holding the full contract `Recipe` | No update, no delete. Versions only grow (semver). |
| `recipes` | Current version per recipe id (what `Command.recipeId` executes) | Composite foreign key to an existing version. It moves only through `addRecipeVersion(…, { makeCurrent: true })` or `setCurrentRecipeVersion`, never as a side effect of creating a command, and not while an `ACTIVE` command executes the recipe (`RECIPE_IN_ACTIVE_USE`). |
| `categories` | Taxonomy: slug id, slug, DE/EN name and description, archived flag | Never deleted. An archived category cannot be newly assigned; commands that already carry it keep it through later edits. |
| `command_categories` | Category ↔ Command | Independent of `lane`. Queryable by lane, category or both. |
| `command_revisions` | Append-only history: the document, lifecycle, categories and recipe version at every write | No update, no delete. |
| `import_runs` | Every successful seed import with its source sha256 and counts | – |

### Authoring lifecycle vs. contract maturity

`lifecycle` (VC-02: `DRAFT → TESTING → ACTIVE → ARCHIVED`) and the contract's `maturity` and `evidence`
(DYAI-31) are separate columns with separate meanings and are never derived from each other.

* **Allowed transitions:** `DRAFT→TESTING`, `DRAFT→ARCHIVED`, `TESTING→DRAFT`, `TESTING→ACTIVE`, `TESTING→ARCHIVED`, `ACTIVE→TESTING`, `ACTIVE→ARCHIVED`, `ARCHIVED→DRAFT`. They are enforced in the repository and again by a database trigger.
* **New authored commands start as `DRAFT`**, enforced by a trigger.
* **Promotion to `ACTIVE`** re-validates the persisted record against the contract with its current recipe and the live registry. The DYAI-44 promotion workflow can add stricter gates.
* **Only `ACTIVE` commands reach the public repositories** (`listPublicCommands`, `getById`, `findBySlash`), and therefore the page and the generation route. A `DRAFT` or `TESTING` command is never resolvable or executable through them. Executability still needs an approved adapter on an allowlisted model (unchanged DYAI-31/37 rules).
* **Archive** is soft removal. The command leaves the public and default operator queries, while its record, categories, slashes and full history stay. An archived command is frozen: it reports the recipe version it was archived with. `ARCHIVED→DRAFT` restores it after re-validating it against the recipe version it would now execute.

## Repository interfaces

* **Read ports (unchanged signatures):** `CommandRepository`, `RecipeRepository` and `CategoryRepository` in `src/server/catalogue/port.ts`. On sqlite, `RecipeRepository.getById` returns the current version.
* **Authoring port (new):** `AuthoringRepository` in `src/server/authoring/port.ts`, obtained through `authoringRepository()` in `src/server/authoring/index.ts`. Operations:
  * categories: create, archive, list;
  * recipe versions: add, set current, get, list;
  * commands: create a DRAFT (optionally with its recipe in the same transaction), update (optimistic `expectedRevision`), transition, archive, get, list (by lane, category or lifecycle), history.
* **Failure reporting:** every refusal is a `CatalogueStoreError` with a code (`src/server/persistence/errors.ts`), and a write that fails rolls back completely. A database rule that refuses a write the repository did not catch first is `CONSTRAINT_VIOLATION`.
* **Read consistency:** operator reads that combine several statements (`getCommand`, `listCommands`) run in one read transaction, so a record, its categories and its recipe version come from the same snapshot even while another process writes.
* **Server-only:** no client component may reach `src/server/**` (`tests/ui-boundary.test.mjs`). With the static adapter, `authoringRepository()` fails closed (`AUTHORING_UNAVAILABLE`).

## Forbidden content

Before any write (and before the seed import), the repository runs `src/server/persistence/content-guard.ts`
and refuses with `FORBIDDEN_CONTENT`. The guard measures these mechanisms, and nothing more:

1. **Structure:** credential-named keys (`apiKey`, `secret`, `token`, `password`, `authorization`, …) and
   Model Capability keys (`providerModelId`, `allowlist`, `benchmarkStatus`, modalities, cost, privacy) at any depth.
2. **Size:**
   * any text longer than 4000 characters;
   * any whitespace-free token longer than 64 characters (paths and `http(s)` URLs: 512);
   * more than two tokens of 40+ characters in one text;
   * a document above 32 KB (command), 64 KB (recipe) or 8 KB (category).

   VC-01 copy stays far below this: its longest token is 24 characters and its largest document 1.6 KB.
   Encoded images and keys are long unbroken tokens, so they hit these limits. A payload deliberately cut
   into short whitespace-separated pieces is not detected, but it stays under 4000 characters per text.
3. **Shapes:** `data:` URIs (`data:` + optional media type + `;` or `,`), auth-header values
   (`bearer`/`basic`/`digest` + a 16+ character value with a digit, symbol or mixed case), and the formats listed in
   `CREDENTIAL_SHAPES`: OpenRouter, OpenAI/Anthropic-style `sk-` keys, PEM private keys, AWS access key ids,
   Google API keys, Slack and GitHub tokens, JWTs, URLs with `user:password@`.

Credential detection in free text cannot be exhaustive: an unknown key format shorter than 65 characters
is not recognised. What bounds it is the closed contract schemas (no field exists for credentials) and the
rules above. Every check is a split or a single-pass regex without overlapping quantifiers. A test
asserts that adversarial 4000-character inputs finish in under 50 ms. Positive controls in the tests
(prose such as "basic understanding", "metadata:", "Password: required…", German text, URLs, a 63-character
token) must pass.

Contract validation then applies the schemas and the provider-term scan. The schema contains no model,
provider, secret or image table or column (`tests/persistence-schema.test.mjs`).

## Operations

```bash
npm run db:migrate -- --database data/catalogue.db   # create + migrate (idempotent)
npm run db:import  -- --database data/catalogue.db   # import VC-01 seed (idempotent / conflict-refusing)
npm run db:status  -- --database data/catalogue.db   # migrations + per-lifecycle counts
COMMAND_STORE_ADAPTER=sqlite DATABASE_URL=file:data/catalogue.db npm start
```

`*.db` and `/data/` are gitignored. Database files are never committed.

## Verification

* **`npm test`:** the persistence suites cover schema/migrations/backstops, import parity and conflicts, the authoring lifecycle, negatives, cross-process durability and the runtime binding, and generation through the store.
* **`npm run smoke:persistence` (part of `npm run verify`):** the operator CLI, a separate authoring process and the production `next start` serving from the database. Lifecycle changes by other processes appear live without any JSON edit, a missing database fails closed, and the default static runtime is unchanged.

## Hosted persistence: migration path (not part of DYAI-39)

Production database provisioning, backups, recovery and hosting credentials are a **separate authorised
deployment decision** (DYAI-48 / PO 2026-10-09). The current Render preview runs on the free plan with an
**ephemeral filesystem**:

* it keeps `COMMAND_STORE_ADAPTER` unset (static);
* no production command data may be stored on its disk.

Options, in order of effort:

1. **Render persistent disk** (paid instance + disk) holding the SQLite file. No code change: set `DATABASE_URL=file:/var/data/catalogue.db`, then run `db:migrate` and `db:import` once. Single instance only, since SQLite is single-writer and per-host.
2. **libSQL/Turso** (hosted SQLite dialect). Add a libSQL adapter that implements the same ports and the same migrations (same SQL dialect).
3. **PostgreSQL** (Render Postgres or other). Port the migration SQL:
   * `STRICT` → native types;
   * `GLOB` checks → `~` regex checks;
   * `json_extract` → `jsonb` operators;
   * triggers → PL/pgSQL.

   Then add a `pg` adapter behind the same ports. The repository contract tests (`tests/persistence-*.test.mjs`) are the acceptance suite for any new adapter.

Every option needs backup/restore, credentials handling and a PO/deployment gate before real data is stored.
