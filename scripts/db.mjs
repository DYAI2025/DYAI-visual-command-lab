// Operator CLI for the durable authoring catalogue (DYAI-39).
//
//   node scripts/db.mjs migrate     --database <file>   create the file if needed and apply pending migrations
//   node scripts/db.mjs import-vc01 --database <file>   import the committed VC-01 seed (catalogue + recipes)
//   node scripts/db.mjs status      --database <file>   migrations and per-lifecycle counts
//
// --database defaults to DATABASE_URL (a file: URL). The VC-01 JSON documents are read here, at the
// import boundary, and nowhere on the runtime path: after import the database is the runtime truth
// and the JSON is not written back (no dual-write). Re-running the import is idempotent; a seed that
// differs from what is persisted is refused as a whole (IMPORT_CONFLICT), never merged.

import fs from "node:fs";
import path from "node:path";

import { databaseFile } from "../src/server/catalogue/config.ts";
import { migrate, migrationStatus, openDatabase } from "../src/server/persistence/database.ts";
import { CatalogueStoreError } from "../src/server/persistence/errors.ts";
import { openSqliteCatalogueStore } from "../src/server/persistence/sqlite-store.ts";
import { modelRegistry } from "../src/server/models/index.ts";

const SEED = { catalogue: "src/domain/commands/catalogue.json", recipes: "src/server/recipes/recipes.json" };

function databaseArgument(argv) {
  const index = argv.indexOf("--database");
  if (index !== -1) {
    const value = argv[index + 1];
    if (!value) throw new CatalogueStoreError("CONFIG_INVALID", "--database needs a path");
    return path.resolve(value);
  }
  return databaseFile(process.env.DATABASE_URL);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const file = databaseArgument(rest);
  switch (command) {
    case "migrate": {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = openDatabase(file, { create: true });
      try {
        const applied = migrate(db);
        console.log(JSON.stringify({ event: "db.migrate", applied, status: migrationStatus(db) }));
      } finally {
        db.close();
      }
      return;
    }
    case "import-vc01": {
      const bundle = {
        catalogue: JSON.parse(fs.readFileSync(SEED.catalogue, "utf8")),
        recipes: JSON.parse(fs.readFileSync(SEED.recipes, "utf8")),
      };
      const store = openSqliteCatalogueStore({ file, models: modelRegistry });
      try {
        const report = await store.importSeed(bundle, { source: `${SEED.catalogue} + ${SEED.recipes}` });
        console.log(JSON.stringify({ event: "db.import-vc01", ...report }));
      } finally {
        store.close();
      }
      return;
    }
    case "status": {
      const db = openDatabase(file, { create: false });
      try {
        const counts = db.prepare("SELECT lifecycle, count(*) AS n FROM commands GROUP BY lifecycle ORDER BY lifecycle").all();
        const recipes = db.prepare("SELECT count(*) AS n FROM recipe_versions").get();
        const categories = db.prepare("SELECT count(*) AS n FROM categories").get();
        console.log(JSON.stringify({ event: "db.status", migrations: migrationStatus(db), commands: counts, recipeVersions: recipes.n, categories: categories.n }));
      } finally {
        db.close();
      }
      return;
    }
    default:
      throw new CatalogueStoreError("CONFIG_INVALID", "usage: node scripts/db.mjs <migrate|import-vc01|status> [--database <file>]");
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof CatalogueStoreError) {
    console.error(JSON.stringify({ event: "db.error", code: error.code, message: error.message, conflicts: error.conflicts, issues: error.issues }));
    process.exit(2);
  }
  throw error;
}
