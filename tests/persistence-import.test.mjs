import assert from "node:assert/strict";
import test from "node:test";

import { staticCommandRepository, staticRecipeRepository } from "../src/server/catalogue/static-adapter.ts";
import { migratedDatabase, newCommand, newRecipe, openStore, rawQuery, rejects, seedBundle, seededStore, tableCounts } from "./helpers/persistence.mjs";

// DYAI-39: VC-01 seed -> deterministic import -> semantic readback, idempotent re-run, and refusal
// (never overwrite) of a seed that conflicts with what is persisted.

const seed = seedBundle();

test("import persists all 12 VC-01 commands and 3 recipes and reads every one back unchanged", async (t) => {
  const { store, cleanup } = await seededStore();
  t.after(() => {
    store.close();
    cleanup();
  });
  assert.equal(seed.catalogue.commands.length, 12);
  for (const command of seed.catalogue.commands) {
    assert.deepEqual(await store.commands.getById(command.id), command, `command ${command.id}`);
    const authored = await store.authoring.getCommand(command.id);
    assert.equal(authored.lifecycle, "ACTIVE");
    assert.equal(authored.origin, "vc01_import");
    assert.equal(authored.revision, 1);
  }
  for (const recipe of seed.recipes.recipes) {
    assert.deepEqual(await store.recipes.getById(recipe.recipeId), recipe, `recipe ${recipe.recipeId}`);
    assert.deepEqual(await store.authoring.listRecipeVersions(recipe.recipeId), [recipe.version]);
  }
});

test("representative PLAY, EXPLAIN and POLISH records keep slash, aliases, DE/EN, lane, recipe identity/version, truth mode, preservation and maturity/evidence", async (t) => {
  const { file, store, cleanup } = await seededStore();
  t.after(() => {
    store.close();
    cleanup();
  });
  const source = (id) => seed.catalogue.commands.find((command) => command.id === id);
  const sourceRecipe = (id) => seed.recipes.recipes.find((recipe) => recipe.recipeId === id);
  const expectations = [
    { id: "actionfigure", lane: "play", recipeId: "actionfigure-v1", truthMode: "creative_entertainment" },
    { id: "mindmap", lane: "explain", recipeId: "mindmap-v1", truthMode: "creative_entertainment" },
    { id: "35mm", lane: "polish", recipeId: "35mm-v1", truthMode: "truth_preserving_edit" },
  ];
  for (const expected of expectations) {
    const command = await store.commands.findBySlash(`/${expected.id}`);
    const original = source(expected.id);
    assert.equal(command.id, expected.id);
    assert.equal(command.canonicalSlash, original.canonicalSlash);
    assert.deepEqual(command.aliases, original.aliases);
    assert.deepEqual(command.display, original.display, "DE/EN name and description");
    assert.deepEqual(command.job, original.job, "DE/EN job");
    assert.equal(command.lane, expected.lane);
    assert.equal(command.recipeId, expected.recipeId);
    assert.equal(command.maturity, original.maturity, "contract maturity");
    assert.deepEqual(command.evidence, original.evidence, "contract evidence");
    assert.deepEqual(command.riskFlags, original.riskFlags);
    assert.deepEqual(command.inputRequirements, original.inputRequirements);

    const authored = await store.authoring.getCommand(expected.id);
    assert.equal(authored.lifecycle, "ACTIVE", "authoring lifecycle is its own field");
    assert.notEqual(authored.lifecycle, authored.command.maturity);

    const recipe = await store.recipes.getById(command.recipeId);
    const originalRecipe = sourceRecipe(expected.recipeId);
    assert.equal(recipe.recipeId, expected.recipeId);
    assert.equal(recipe.version, originalRecipe.version);
    assert.equal(authored.recipeVersion, originalRecipe.version);
    assert.equal(recipe.truthMode, expected.truthMode);
    assert.deepEqual(recipe.preserve, originalRecipe.preserve, "preservation rules");
    assert.deepEqual(recipe.mayChange, originalRecipe.mayChange);
    assert.deepEqual(recipe.immutableFeatures, originalRecipe.immutableFeatures);
    assert.deepEqual(recipe.negativeConstraints, originalRecipe.negativeConstraints);
  }
  // what is physically stored, not only what the repository returns
  const [row] = rawQuery(file, "SELECT lane, maturity, lifecycle, recipe_id, name_de FROM commands WHERE id = '35mm'");
  assert.deepEqual({ ...row }, { lane: "polish", maturity: "seed", lifecycle: "ACTIVE", recipe_id: "35mm-v1", name_de: source("35mm").display.de.name });
});

test("public reads through the durable store equal the static bootstrap adapter (order, slash and alias rules)", async (t) => {
  const { store, cleanup } = await seededStore();
  t.after(() => {
    store.close();
    cleanup();
  });
  assert.deepEqual(await store.commands.listPublicCommands(), await staticCommandRepository.listPublicCommands());
  const slashes = seed.catalogue.commands.flatMap((command) => [command.canonicalSlash, ...command.aliases.map((alias) => alias.slash)]);
  for (const slash of [...slashes, "/unknown"]) {
    for (const options of [undefined, { allowReviewRequiredAliases: true }]) {
      assert.deepEqual(await store.commands.findBySlash(slash, options), await staticCommandRepository.findBySlash(slash, options), `${slash} ${JSON.stringify(options)}`);
    }
  }
  assert.equal(await store.commands.findBySlash("/lego"), null, "review-gated brand alias stays gated");
  for (const recipe of seed.recipes.recipes) {
    assert.deepEqual(await store.recipes.getById(recipe.recipeId), await staticRecipeRepository.getById(recipe.recipeId));
  }
});

test("re-running the import is idempotent: nothing inserted, no new revision, same digest", async (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const store = openStore(file);
  t.after(() => store.close());
  const first = await store.importSeed(seedBundle());
  assert.deepEqual({ ...first, sourceDigest: undefined }, { commandsInserted: 12, commandsUnchanged: 0, recipesInserted: 3, recipesUnchanged: 0, sourceDigest: undefined });
  const before = tableCounts(file);
  const second = await store.importSeed(seedBundle());
  assert.deepEqual({ ...second, sourceDigest: undefined }, { commandsInserted: 0, commandsUnchanged: 12, recipesInserted: 0, recipesUnchanged: 3, sourceDigest: undefined });
  assert.equal(second.sourceDigest, first.sourceDigest);
  assert.match(first.sourceDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(tableCounts(file), { ...before, import_runs: before.import_runs + 1 });
});

test("a seed that differs from persisted content is refused as a whole and overwrites nothing", async (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const store = openStore(file);
  t.after(() => store.close());
  await store.importSeed(seedBundle());
  const snapshot = rawQuery(file, "SELECT * FROM commands ORDER BY id");
  const recipesBefore = rawQuery(file, "SELECT * FROM recipe_versions ORDER BY recipe_id");
  const counts = tableCounts(file);

  // 1. changed command text, plus a brand-new command in the same seed: neither may land
  const changed = seedBundle();
  changed.catalogue.commands.find((c) => c.id === "mindmap").display.de.name = "Gedankenkarte (geändert)";
  changed.catalogue.commands.push(newCommand("freshidea", null));
  const error = await rejects(store.importSeed(changed), "IMPORT_CONFLICT");
  assert.deepEqual(error.conflicts, [
    "command mindmap: persisted record differs from the seed",
    "command freshidea: not part of the imported seed; the catalogue was bootstrapped from the seed; author new content through the repository",
  ]);

  // 2. same recipe version with different content
  const recipeChanged = seedBundle();
  recipeChanged.recipes.recipes.find((r) => r.recipeId === "35mm-v1").negativeConstraints.push("No new grain.");
  const recipeError = await rejects(store.importSeed(recipeChanged), "IMPORT_CONFLICT");
  assert.deepEqual(recipeError.conflicts, ["recipe 35mm-v1@0.1.0: persisted content differs from the seed"]);

  // 3. seed advanced a recipe version: the database, not the JSON, is now where recipes change
  const advanced = seedBundle();
  advanced.recipes.recipes.find((r) => r.recipeId === "mindmap-v1").version = "0.2.0";
  const advancedError = await rejects(store.importSeed(advanced), "IMPORT_CONFLICT");
  assert.match(advancedError.conflicts.join("\n"), /recipe mindmap-v1@0\.2\.0: not part of the imported seed/);

  assert.deepEqual(rawQuery(file, "SELECT * FROM commands ORDER BY id"), snapshot, "no command row changed");
  assert.deepEqual(rawQuery(file, "SELECT * FROM recipe_versions ORDER BY recipe_id"), recipesBefore, "no recipe row changed");
  assert.deepEqual(tableCounts(file), counts, "nothing inserted, not even an import run");
  assert.equal(await store.commands.getById("freshidea"), null);
});

test("import refuses a seed id an authored command already uses, and an invalid seed", async (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const store = openStore(file);
  t.after(() => store.close());
  await store.authoring.createDraftCommand({ command: newCommand("mindmap", "sticker-v1", { lane: "play" }), recipe: newRecipe() });
  const error = await rejects(store.importSeed(seedBundle()), "IMPORT_CONFLICT");
  assert.match(error.conflicts.join("\n"), /command mindmap: an authored command already uses this id/);
  assert.deepEqual(tableCounts(file).import_runs, 0);
  assert.equal((await store.authoring.listCommands()).length, 1, "only the authored draft exists");

  const invalid = seedBundle();
  invalid.catalogue.commands[0].lane = "dance";
  await rejects(store.importSeed(invalid), "IMPORT_SOURCE_INVALID");
});

test("after the bootstrap the JSON is history: a new seed command is refused, never published", async (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const store = openStore(file);
  t.after(() => store.close());
  await store.importSeed(seedBundle());
  const counts = tableCounts(file);
  const grown = seedBundle();
  grown.catalogue.commands.push(newCommand("freshidea", null));
  const error = await rejects(store.importSeed(grown), "IMPORT_CONFLICT");
  assert.deepEqual(error.conflicts, ["command freshidea: not part of the imported seed; the catalogue was bootstrapped from the seed; author new content through the repository"]);
  const grownRecipe = seedBundle();
  grownRecipe.recipes.recipes.push(newRecipe());
  await rejects(store.importSeed(grownRecipe), "IMPORT_CONFLICT");
  assert.deepEqual(tableCounts(file), counts);
  assert.equal(await store.commands.getById("freshidea"), null);
  assert.equal(await store.authoring.getCommand("freshidea"), null);
});

test("a re-import compares with what the seed imported, so operator edits of imported commands are not conflicts", async (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const store = openStore(file);
  t.after(() => store.close());
  await store.importSeed(seedBundle());
  const testing = await store.authoring.transitionCommand("mindmap", "TESTING", { expectedRevision: 1 });
  const edited = structuredClone(testing.command);
  edited.tags = [...edited.tags, "operator-edit"];
  await store.authoring.updateCommand("mindmap", { command: edited, categoryIds: [], expectedRevision: testing.revision });
  const report = await store.importSeed(seedBundle());
  assert.deepEqual({ ...report, sourceDigest: undefined }, { commandsInserted: 0, commandsUnchanged: 12, recipesInserted: 0, recipesUnchanged: 3, sourceDigest: undefined });
  assert.deepEqual((await store.authoring.getCommand("mindmap")).command, edited, "the operator edit is kept, not overwritten by the seed");
});

test("a first import refuses a seed slash that an authored command with another id owns", async (t) => {
  const { file, cleanup } = migratedDatabase();
  t.after(cleanup);
  const store = openStore(file);
  t.after(() => store.close());
  const sticker = newCommand("sticker", "sticker-v1", { aliases: [{ slash: "/mindmap", kind: "spelling_variant", publicUse: "allowed" }] });
  await store.authoring.createDraftCommand({ command: sticker, recipe: newRecipe() });
  const counts = tableCounts(file);
  const error = await rejects(store.importSeed(seedBundle()), "IMPORT_CONFLICT");
  assert.deepEqual(error.conflicts, ["command mindmap: /mindmap already belongs to sticker"]);
  assert.deepEqual(tableCounts(file), counts, "nothing imported");
});
