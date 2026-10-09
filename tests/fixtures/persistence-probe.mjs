// Child-process probe for tests/persistence-durability.test.mjs. Each mode runs in its own Node
// process, so whatever a later mode reads came from the database file, not from memory.
//
//   write <file>  : create category + DRAFT command + recipe through the store, print what was written
//   read <file>   : open a new store on the file, print what is persisted
//   runtime       : bind the app's catalogue ports from the environment (COMMAND_STORE_ADAPTER /
//                   DATABASE_URL) exactly like the server, print what the public and authoring ports serve

import { openSqliteCatalogueStore } from "../../src/server/persistence/sqlite-store.ts";
import { modelRegistry } from "../../src/server/models/index.ts";
import { category, newCommand, newRecipe } from "../helpers/persistence.mjs";

const [mode, file] = process.argv.slice(2);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function snapshot(store) {
  return {
    command: await store.authoring.getCommand("sticker"),
    history: await store.authoring.getCommandHistory("sticker"),
    recipe: await store.authoring.getRecipeVersion("sticker-v1", "0.1.0"),
    categories: await store.authoring.listCategories({ includeArchived: true }),
    publicIds: (await store.commands.listPublicCommands()).map((command) => command.id),
  };
}

if (mode === "write" || mode === "read") {
  const store = openSqliteCatalogueStore({ file, models: modelRegistry, now: () => "2026-10-09T12:00:00.000Z" });
  if (mode === "write") {
    await store.authoring.createCategory(category("portraits"));
    await store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe(), categoryIds: ["portraits"] });
  }
  print({ pid: process.pid, ...(await snapshot(store)) });
  store.close();
} else if (mode === "transition") {
  // transition <file> <TO>: one lifecycle step for the "sticker" draft, from its current revision
  const to = process.argv[4];
  const store = openSqliteCatalogueStore({ file, models: modelRegistry });
  const current = await store.authoring.getCommand("sticker");
  const next = await store.authoring.transitionCommand("sticker", to, { expectedRevision: current.revision });
  print({ pid: process.pid, lifecycle: next.lifecycle, revision: next.revision });
  store.close();
} else if (mode === "runtime") {
  const { commandRepository, recipeRepository, categoryRepository } = await import("../../src/server/catalogue/index.ts");
  const { authoringRepository } = await import("../../src/server/authoring/index.ts");
  try {
    const commands = await commandRepository.listPublicCommands();
    const result = {
      pid: process.pid,
      publicIds: commands.map((command) => command.id),
      draftViaPublic: await commandRepository.findBySlash("/sticker"),
      recipe: await recipeRepository.getById("actionfigure-v1"),
      categories: await categoryRepository.listActive(),
    };
    try {
      result.draftViaAuthoring = await (await authoringRepository()).getCommand("sticker");
    } catch (error) {
      result.authoringError = error.code ?? error.name;
    }
    print(result);
  } catch (error) {
    print({ pid: process.pid, error: { name: error.name, code: error.code } });
    process.exitCode = 3;
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
