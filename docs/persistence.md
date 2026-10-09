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
| `sqlite` | missing, non-`file:`, in-memory, absent file, unopenable path, unmigrated, drifted or corrupt | Fail closed. `CatalogueStoreError` with code `CONFIG_INVALID`, `DATABASE_MISSING`, `DATABASE_UNREADABLE`, `SCHEMA_NOT_MIGRATED`, `SCHEMA_DRIFT` or `DATABASE_CORRUPT`. A SQLite failure at query time (after open) is `DATABASE_UNREADABLE` too, and lock contention past the busy timeout, at open or at query time, is `DATABASE_BUSY` (transient). The schema-object comparison runs at open, not on every query. Pages error, and `/api/generate` answers `503 catalogue_unavailable`. **There is no fallback to the static JSON.** |
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

Before any write, and for each seed command and recipe before the import, the repository runs
`src/server/persistence/content-guard.ts`. A hit is refused with `FORBIDDEN_CONTENT`.

**Threat model.** The guard catches content that arrives *by accident*: an operator, or an AI-generated candidate (DYAI-40), pastes a `data:` URI, an encoded image, a well-known credential or one of this server's own secrets into authoring data. An authenticated operator who *deliberately* disguises bytes or an unknown secret is out of scope, since such an operator could change the code as well. For that case only the size caps limit how much can be stored.

The guard checks only these mechanisms. It does not judge whether a word "looks like" a secret or
a payload:

1. **Structure:** credential-named keys (`apiKey`, `secret`, `token`, `password`, `authorization`, …) and
   Model Capability keys (`providerModelId`, `allowlist`, `benchmarkStatus`, modalities, cost, privacy) at any depth.
   An offending key is reported without its text, because the key may itself be the secret.
2. **This server's own secrets:** any text that contains, as written, JSON-escaped or `encodeURIComponent`-encoded,
   the value of a configured secret environment variable
   (`OPENROUTER_API_KEY`, and every variable whose name ends in `KEY`, `SECRET`, `TOKEN` or `PASSWORD`, if its
   value has 16 or more characters).
3. **Fixed formats:**
   * RFC 2397 `data:` URIs: `data:[type/subtype][;parameter]*,`. Type and subtype are RFC 2045 tokens (ASCII
     `!#$%&'*+.^_`|~`, digits, letters, `-`). The comma must be followed directly by data: a base64 or
     percent-encoded character, or inline markup opening with `<svg` / `<html` (followed by a space, `>` or `/`), `<?xml ` or `<!doctype `. So prose
     such as "never return data:image/*, …", "data:image/png;base64,… in the response" or a `<base64>` / `<svg-markup>`
     placeholder passes. The parameter section (`;` …) is up to 1600 non-whitespace characters without a comma. A
     `{data:true,…}` code snippet is not a `data:` URI.
   * The prefix-anchored credential formats in `CREDENTIAL_FORMATS`: `sk-or-v1-` (OpenRouter), `sk-proj-` /
     `sk-ant-`, Stripe `sk_/rk_live|test_`, PEM private keys, `AKIA…` (AWS), `AIza…` (Google), `xox?-` (Slack),
     `ghp_…` / `github_pat_…` (GitHub), JWTs, and connection strings with `user:password@` for service schemes
     (`postgres(ql)`, `mysql`, `mariadb`, `mongodb(+srv)`, `redis(s)`, `amqp(s)`, `mssql`, `sqlserver`, `ftp(s)`,
     `sftp`, `smtp(s)`, `ldap(s)`, `ssh`).
   * These formats are matched against the text as written and with the JSON/URL escaping of item 4 undone.
     `http(s)` URLs are deliberately not checked for userinfo. Redirect and safelink links such as
     `?next=https://host:8443&mail=a@b` cannot be told apart from `user:password@` lexically.
4. **Image bytes:**
   * The guard first undoes JSON (`\/`) and URL (`%2F`, `%2B`, `%3D`, `%3A`,
     `%3B`, `%2C`) escaping.
   * It then decodes every run of 16 or more base64/base64url characters (24 or more for hex) in every alignment.
   * It refuses the text if an image file signature of 4 or more bytes occurs at any byte position. The signatures
     are PNG (8 bytes), JPEG (`FF D8 FF` plus a marker byte), GIF87a/89a, WebP, BMP, TIFF, ICO and HEIF/AVIF.
   * An accidentally pasted image carries its signature, raw, wrapped, after a prefix, escaped, or inside a
     `data:` URI.
   * Words, paths, slugs, links and `-`/`_` separator runs form such runs too, and the guard decodes them. They pass
     because no signature occurs in their decoded bytes. A hash or ID inside a link or path is subject to the chance
     rate below. The tests' positive controls cover these cases.
   * Hashes and IDs are encoded runs. A random one matches a signature only by chance. JPEG is the weakest signature, at about
     4.9·10⁻⁹ per byte position (21 marker bytes / 2³²). That gives roughly 1 in 2 million per digest over all alignments. The tests check 2000 sha256 digests in hex, base64 and base64url.
5. **Capacity:** at most 4000 characters per text, and a per-document cap of 32 KB (command), 64 KB (recipe) or
   8 KB (category). VC-01 copy stays far below this; its largest document is 1.6 KB.

**Not detected (by design):**

* A credential in an unknown format that is not one of this server's own secrets (for example a generic
  bearer token, or a password typed into prose).
* A server secret that has been split, re-cased or spaced out.
* Image bytes without their file header, other binary data, and other encodings such as base32.
* Hex dumps with separators: the default `xxd` output, `xxd -i` C arrays, `\x89\x50` byte literals.
* `user:password@` in an `http(s)` URL, and a connection string whose `@` is percent-encoded (`%40`, as in
  full `encodeURIComponent` output). JSON-escaped (`\/`) and `%2F`/`%3A`-escaped connection strings are found. A configured server secret is also found JSON-escaped
  or fully `encodeURIComponent`-encoded.
* Escaping other than the listed JSON `\/` and `%XX` forms, such as HTML entities (`&#x2F;`) or double URL encoding
  (`%252F`).
* Anything deliberately disguised.

Within the capacity limits these cases are bounded by the closed contract schemas, which have no field for
credentials or bytes.

The checks are single-pass regexes without overlapping quantifiers plus a linear decode-and-scan that uses only
byte compares.

* **Gated:** catastrophic backtracking, the failure that would block the server for seconds. Two tests guard it:
  * A structural test checks every regular expression in `content-guard.ts`. A scan of the source must find
    exactly the patterns registered in `GUARD_PATTERNS`. Each pattern must follow two rules:
    * no group that repeats more than once (`+`, `*`, `{n,}`, `{n,m}` with m > 1, `{n}` with n > 1) may contain a
      quantifier or an alternation;
    * at most one unbounded quantifier per pattern.

    This excludes nested and alternated repetition, the shapes behind exponential backtracking. The detector is
    canaried on known-bad patterns (`(a+)+`, `(a+){10}`, `(a|a)+`, `a+b+`).
  * A timing test runs adversarial 4000-character texts, including one per credential prefix with a long run that
    has no terminator. Each may cost at most 8× a random encoded text of the same length, with a 10 ms floor,
    measured interleaved, minimum of several runs.
* **Not gated:** constant-factor efficiency. For example, an allocation per compared byte position slows the scan
  several times but stays linear. Wall-clock ratios cannot separate that reliably from machine load, so no test
  claims to catch it.
* **Informational:** measured on a development Mac (Node 24.16), under 10 ms per adversarial 4000-character text,
  and about 20–30 ms for a maximal 64 KB recipe of low-entropy runs.

Positive controls in the tests must pass:

* prose ("basic troubleshooting", "Bearer bonds", "metadata:", "Password: required…", German text);
* Markdown tables, ASCII and Unicode separator lines;
* links in German quotes, guillemets and bold;
* long `mailto:` addresses, `www.` links and paths;
* git and sha256 hashes;
* `{data:true,…}` snippets.

Contract validation then applies the schemas and the provider-term scan. The schema contains no model,
provider, secret or image table or column (`tests/persistence-schema.test.mjs`).

## Operations

```bash
npm run db:migrate -- --database data/catalogue.db   # create + migrate (idempotent)
npm run db:import  -- --database data/catalogue.db   # import VC-01 seed (bootstrap once; a matching re-run changes no catalogue content; conflicts refused)
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
