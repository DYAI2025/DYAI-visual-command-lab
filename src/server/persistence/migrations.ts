// Ordered, append-only schema migrations for the authoring catalogue (DYAI-39). A migration is never
// edited once released: the runner stores each migration's sha256 and refuses a database whose
// recorded checksum differs (SCHEMA_DRIFT). New schema changes are new entries at the end.
//
// The SQL stays inside the subset SQLite and PostgreSQL share where practical (see
// docs/persistence.md for the hosted migration path); STRICT tables, GLOB checks and triggers are the
// SQLite-specific parts.

export interface Migration {
  id: string;
  sql: string;
}

const SLUG = (column: string) => `${column} GLOB '[a-z0-9]*' AND ${column} NOT GLOB '*[^a-z0-9-]*'`;
const TEXT = (column: string) => `${column} TEXT NOT NULL CHECK (length(trim(${column})) > 0)`;
const LIFECYCLES = "'DRAFT', 'TESTING', 'ACTIVE', 'ARCHIVED'";
const TRANSITIONS = [
  "DRAFT>TESTING",
  "DRAFT>ARCHIVED",
  "TESTING>DRAFT",
  "TESTING>ACTIVE",
  "TESTING>ARCHIVED",
  "ACTIVE>TESTING",
  "ACTIVE>ARCHIVED",
  "ARCHIVED>DRAFT",
];
const abort = (message: string) => `SELECT RAISE(ABORT, '${message}');`;

const INITIAL_SCHEMA = `
CREATE TABLE categories (
  id TEXT PRIMARY KEY CHECK (${SLUG("id")}),
  slug TEXT NOT NULL UNIQUE CHECK (${SLUG("slug")}),
  ${TEXT("name_en")},
  ${TEXT("description_en")},
  ${TEXT("name_de")},
  ${TEXT("description_de")},
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- One immutable row per recipe version; the document is the full contract Recipe.
CREATE TABLE recipe_versions (
  recipe_id TEXT NOT NULL CHECK (${SLUG("recipe_id")}),
  version TEXT NOT NULL CHECK (version GLOB '[0-9]*.[0-9]*.[0-9]*'),
  truth_mode TEXT NOT NULL CHECK (truth_mode IN ('creative_entertainment', 'truth_preserving_edit', 'evidence_grounded_workflow')),
  document TEXT NOT NULL CHECK (json_valid(document)),
  -- where the version came from: the seed import or the authoring repository
  origin TEXT NOT NULL CHECK (origin IN ('vc01_import', 'authored')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (recipe_id, version),
  CHECK (json_extract(document, '$.recipeId') = recipe_id),
  CHECK (json_extract(document, '$.version') = version),
  CHECK (json_extract(document, '$.truthMode') = truth_mode)
) STRICT;

-- The version a recipe id resolves to (what Command.recipeId executes).
CREATE TABLE recipes (
  recipe_id TEXT PRIMARY KEY,
  current_version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (recipe_id, current_version) REFERENCES recipe_versions (recipe_id, version)
) STRICT;

CREATE TABLE commands (
  id TEXT PRIMARY KEY CHECK (${SLUG("id")}),
  canonical_slash TEXT NOT NULL UNIQUE CHECK (canonical_slash = '/' || id),
  lane TEXT NOT NULL CHECK (lane IN ('play', 'explain', 'polish')),
  -- contract maturity (DYAI-31) and VC-02 authoring lifecycle are separate columns on purpose
  maturity TEXT NOT NULL CHECK (maturity IN ('candidate', 'seed', 'curated', 'validated', 'deprecated')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (${LIFECYCLES})),
  recipe_id TEXT REFERENCES recipes (recipe_id),
  ${TEXT("name_en")},
  ${TEXT("description_en")},
  ${TEXT("name_de")},
  ${TEXT("description_de")},
  ${TEXT("job_en")},
  ${TEXT("job_de")},
  document TEXT NOT NULL CHECK (json_valid(document)),
  origin TEXT NOT NULL CHECK (origin IN ('vc01_import', 'authored')),
  sort_key INTEGER NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK ((lifecycle = 'ARCHIVED') = (archived_at IS NOT NULL)),
  CHECK (json_extract(document, '$.id') = id),
  CHECK (json_extract(document, '$.canonicalSlash') = canonical_slash),
  CHECK (json_extract(document, '$.lane') = lane),
  CHECK (json_extract(document, '$.maturity') = maturity),
  CHECK (json_extract(document, '$.recipeId') IS recipe_id),
  CHECK (json_extract(document, '$.display.en.name') = name_en),
  CHECK (json_extract(document, '$.display.en.description') = description_en),
  CHECK (json_extract(document, '$.display.de.name') = name_de),
  CHECK (json_extract(document, '$.display.de.description') = description_de),
  CHECK (json_extract(document, '$.job.en') = job_en),
  CHECK (json_extract(document, '$.job.de') = job_de)
) STRICT;
CREATE INDEX commands_lane ON commands (lane, lifecycle);
CREATE INDEX commands_lifecycle ON commands (lifecycle, sort_key);

-- Every canonical slash and alias, catalogue-wide: one slash names at most one command, archived
-- commands keep theirs (history stays resolvable for the operator).
CREATE TABLE command_slashes (
  slash TEXT PRIMARY KEY CHECK (slash GLOB '/[a-z0-9]*' AND substr(slash, 2) NOT GLOB '*[^a-z0-9-]*'),
  command_id TEXT NOT NULL REFERENCES commands (id),
  kind TEXT NOT NULL CHECK (kind IN ('canonical', 'alias'))
) STRICT;
CREATE UNIQUE INDEX command_slashes_one_canonical ON command_slashes (command_id) WHERE kind = 'canonical';

-- Category is taxonomy, independent of lane.
CREATE TABLE command_categories (
  command_id TEXT NOT NULL REFERENCES commands (id),
  category_id TEXT NOT NULL REFERENCES categories (id),
  PRIMARY KEY (command_id, category_id)
) STRICT;
CREATE INDEX command_categories_category ON command_categories (category_id);

-- Append-only history of every command write.
CREATE TABLE command_revisions (
  command_id TEXT NOT NULL REFERENCES commands (id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (${LIFECYCLES})),
  document TEXT NOT NULL CHECK (json_valid(document)),
  category_ids TEXT NOT NULL CHECK (json_valid(category_ids) AND json_type(category_ids) = 'array'),
  recipe_version TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('import', 'create', 'update', 'transition', 'recipe_version')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (command_id, revision)
) STRICT;

CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  commands_inserted INTEGER NOT NULL,
  commands_unchanged INTEGER NOT NULL,
  recipes_inserted INTEGER NOT NULL,
  recipes_unchanged INTEGER NOT NULL,
  imported_at TEXT NOT NULL
) STRICT;

-- Database-level backstops for the repository rules.
CREATE TRIGGER recipe_versions_immutable BEFORE UPDATE ON recipe_versions BEGIN ${abort("recipe versions are immutable")} END;
CREATE TRIGGER recipe_versions_kept BEFORE DELETE ON recipe_versions BEGIN ${abort("recipe versions are never deleted")} END;
CREATE TRIGGER recipes_kept BEFORE DELETE ON recipes BEGIN ${abort("recipes are never deleted")} END;
CREATE TRIGGER categories_kept BEFORE DELETE ON categories BEGIN ${abort("categories are archived, never deleted")} END;
CREATE TRIGGER commands_kept BEFORE DELETE ON commands BEGIN ${abort("commands are archived, never deleted")} END;
CREATE TRIGGER command_revisions_append_only BEFORE UPDATE ON command_revisions BEGIN ${abort("command history is append-only")} END;
CREATE TRIGGER command_revisions_kept BEFORE DELETE ON command_revisions BEGIN ${abort("command history is append-only")} END;
CREATE TRIGGER commands_authored_start_as_draft BEFORE INSERT ON commands
  WHEN NEW.origin = 'authored' AND NEW.lifecycle <> 'DRAFT'
  BEGIN ${abort("authored commands start as DRAFT")} END;
CREATE TRIGGER commands_identity_fixed BEFORE UPDATE ON commands
  WHEN NEW.id IS NOT OLD.id OR NEW.canonical_slash IS NOT OLD.canonical_slash OR NEW.origin IS NOT OLD.origin
    OR NEW.created_at IS NOT OLD.created_at OR NEW.sort_key IS NOT OLD.sort_key
  BEGIN ${abort("command identity is fixed")} END;
CREATE TRIGGER commands_revision_steps BEFORE UPDATE ON commands
  WHEN NEW.revision <> OLD.revision + 1
  BEGIN ${abort("every command write is exactly one new revision")} END;
CREATE TRIGGER commands_archived_frozen BEFORE UPDATE ON commands
  WHEN OLD.lifecycle = 'ARCHIVED' AND NEW.lifecycle = 'ARCHIVED'
  BEGIN ${abort("an archived command is restored to DRAFT before it changes")} END;
CREATE TRIGGER commands_lifecycle_transition BEFORE UPDATE OF lifecycle ON commands
  WHEN NEW.lifecycle <> OLD.lifecycle AND (OLD.lifecycle || '>' || NEW.lifecycle) NOT IN (${TRANSITIONS.map((t) => `'${t}'`).join(", ")})
  BEGIN ${abort("lifecycle transition not allowed")} END;
`;

export const MIGRATIONS: readonly Migration[] = [{ id: "0001_authoring_catalogue", sql: INITIAL_SCHEMA }];

/** Allowed authoring lifecycle transitions (mirrors the commands_lifecycle_transition trigger). */
export const LIFECYCLE_TRANSITIONS: ReadonlySet<string> = new Set(TRANSITIONS);
