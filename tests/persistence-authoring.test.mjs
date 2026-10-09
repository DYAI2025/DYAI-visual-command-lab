import assert from "node:assert/strict";
import test from "node:test";

import { category, newCommand, newRecipe, openStore, rawQuery, rejects, seededStore } from "./helpers/persistence.mjs";

// DYAI-39: the operator authoring boundary on a real database file. A new DRAFT Command + versioned
// Recipe + Category is written without touching any JSON file, survives closing and reopening the
// store, stays out of the public repositories until promoted, and archive keeps its history.

async function fixture(t) {
  const seeded = await seededStore();
  let store = seeded.store;
  t.after(() => {
    store.close();
    seeded.cleanup();
  });
  return {
    file: seeded.file,
    get store() {
      return store;
    },
    /** Closes the connection and opens a brand-new store on the same file. */
    reopen() {
      store.close();
      store = openStore(seeded.file);
      return store;
    },
  };
}

test("new DRAFT command + versioned recipe + category persists and reads back unchanged after reopening", async (t) => {
  const f = await fixture(t);
  const portraits = await f.store.authoring.createCategory(category("portraits"));
  const command = newCommand();
  const recipe = newRecipe();
  const created = await f.store.authoring.createDraftCommand({ command, recipe, categoryIds: [portraits.id] });
  assert.equal(created.lifecycle, "DRAFT");
  assert.equal(created.origin, "authored");
  assert.equal(created.revision, 1);
  assert.equal(created.recipeVersion, "0.1.0");
  assert.deepEqual(created.categoryIds, ["portraits"]);
  assert.deepEqual(created.command, command);

  const reopened = f.reopen();
  const readBack = await reopened.authoring.getCommand("sticker");
  assert.deepEqual(readBack, created, "the full authored record survives a new connection");
  assert.deepEqual(await reopened.authoring.getRecipeVersion("sticker-v1", "0.1.0"), recipe);
  assert.deepEqual(await reopened.recipes.getById("sticker-v1"), recipe);
  assert.deepEqual(await reopened.categories.listActive(), [portraits]);
  const [row] = rawQuery(f.file, "SELECT lifecycle, maturity, lane, recipe_id FROM commands WHERE id = 'sticker'");
  assert.deepEqual({ ...row }, { lifecycle: "DRAFT", maturity: "seed", lane: "play", recipe_id: "sticker-v1" });
});

test("a DRAFT or TESTING command is operator-only: public lists, ids and slashes do not resolve it", async (t) => {
  const f = await fixture(t);
  const created = await f.store.authoring.createDraftCommand({ command: newCommand("sticker", "sticker-v1", { aliases: [{ slash: "/aufkleber", kind: "translation", publicUse: "allowed" }] }), recipe: newRecipe() });
  const publicIds = async () => (await f.store.commands.listPublicCommands()).map((command) => command.id);
  for (const lifecycle of ["DRAFT", "TESTING"]) {
    if (lifecycle === "TESTING") await f.store.authoring.transitionCommand("sticker", "TESTING", { expectedRevision: created.revision });
    assert.equal((await publicIds()).includes("sticker"), false, lifecycle);
    assert.equal(await f.store.commands.getById("sticker"), null, lifecycle);
    assert.equal(await f.store.commands.findBySlash("/sticker"), null, lifecycle);
    assert.equal(await f.store.commands.findBySlash("/aufkleber"), null, lifecycle);
    assert.equal((await publicIds()).length, 12);
  }
  const testing = await f.store.authoring.getCommand("sticker");
  const active = await f.store.authoring.transitionCommand("sticker", "ACTIVE", { expectedRevision: testing.revision });
  assert.equal(active.lifecycle, "ACTIVE");
  assert.deepEqual((await f.store.commands.findBySlash("/aufkleber")).id, "sticker");
  assert.equal((await publicIds()).at(-1), "sticker", "promoted command is listed after the VC-01 commands");
});

test("lane and category are independent, separately persisted and queryable dimensions", async (t) => {
  const f = await fixture(t);
  await f.store.authoring.createCategory(category("learning"));
  await f.store.authoring.createCategory(category("portraits"));
  await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe(), categoryIds: ["portraits", "learning"] });
  const explainer = newCommand("flowchart", null, {
    lane: "explain",
    riskFlags: ["synthetic_visualisation", "invented_content_risk"],
    display: { en: { name: "Flowchart", description: "Explains a process as a flowchart." }, de: { name: "Flussdiagramm", description: "Erklärt einen Ablauf als Flussdiagramm." } },
  });
  await f.store.authoring.createDraftCommand({ command: explainer, categoryIds: ["learning"] });

  const ids = async (query) => (await f.store.authoring.listCommands(query)).map((entry) => entry.command.id);
  assert.deepEqual(await ids({ categoryId: "learning" }), ["sticker", "flowchart"]);
  assert.deepEqual(await ids({ categoryId: "portraits" }), ["sticker"]);
  assert.deepEqual(await ids({ lane: "explain", categoryId: "learning" }), ["flowchart"]);
  assert.deepEqual(await ids({ lane: "play", categoryId: "learning" }), ["sticker"]);
  assert.deepEqual(await ids({ lane: "explain", lifecycles: ["DRAFT"] }), ["flowchart"]);
  assert.deepEqual(await ids({ lane: "explain", lifecycles: ["ACTIVE"] }), ["mindmap", "lerncomic", "infographic", "storyboard"]);
  assert.deepEqual(rawQuery(f.file, "SELECT category_id FROM command_categories WHERE command_id = 'sticker' ORDER BY category_id").map((r) => r.category_id), ["learning", "portraits"]);
});

test("archive removes a command from active and default queries and keeps the record and its full history", async (t) => {
  const f = await fixture(t);
  await f.store.authoring.createCategory(category("portraits"));
  const created = await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe(), categoryIds: ["portraits"] });
  const testing = await f.store.authoring.transitionCommand("sticker", "TESTING", { expectedRevision: created.revision });
  const active = await f.store.authoring.transitionCommand("sticker", "ACTIVE", { expectedRevision: testing.revision });
  assert.ok((await f.store.commands.getById("sticker")) !== null);

  const archived = await f.store.authoring.archiveCommand("sticker", { expectedRevision: active.revision });
  assert.equal(archived.lifecycle, "ARCHIVED");
  assert.ok(archived.archivedAt);
  const store = f.reopen();
  assert.equal(await store.commands.getById("sticker"), null);
  assert.equal(await store.commands.findBySlash("/sticker"), null);
  assert.equal((await store.commands.listPublicCommands()).some((c) => c.id === "sticker"), false);
  assert.equal((await store.authoring.listCommands()).some((c) => c.command.id === "sticker"), false, "hidden from the default operator list");
  assert.deepEqual((await store.authoring.listCommands({ lifecycles: ["ARCHIVED"] })).map((c) => c.command.id), ["sticker"]);

  const kept = await store.authoring.getCommand("sticker");
  assert.deepEqual(kept.command, newCommand(), "record kept unchanged");
  assert.deepEqual(kept.categoryIds, ["portraits"]);
  assert.equal(kept.lifecycle, "ARCHIVED");
  const history = await store.authoring.getCommandHistory("sticker");
  assert.deepEqual(history.map((h) => [h.revision, h.lifecycle, h.reason]), [
    [1, "DRAFT", "create"],
    [2, "TESTING", "transition"],
    [3, "ACTIVE", "transition"],
    [4, "ARCHIVED", "transition"],
  ]);
  assert.ok(history.every((h) => h.recipeVersion === "0.1.0" && h.categoryIds[0] === "portraits"));
  assert.deepEqual(await store.recipes.getById("sticker-v1"), newRecipe(), "its recipe stays persisted");

  // the slash stays reserved while archived, and the record can be restored to DRAFT
  await rejects(store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() }), "SLASH_CONFLICT");
  await rejects(store.authoring.updateCommand("sticker", { command: newCommand(), categoryIds: [], expectedRevision: 4 }), "NOT_EDITABLE");
  const restored = await store.authoring.transitionCommand("sticker", "DRAFT", { expectedRevision: 4 });
  assert.equal(restored.lifecycle, "DRAFT");
  assert.equal(restored.archivedAt, null);
});

test("editing is optimistic, limited to DRAFT/TESTING, and every write is one more revision", async (t) => {
  const f = await fixture(t);
  await f.store.authoring.createCategory(category("portraits"));
  const created = await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  const edited = newCommand("sticker", "sticker-v1", { tags: ["play", "sticker", "die-cut"], aliases: [{ slash: "/aufkleber", kind: "translation", publicUse: "allowed" }] });
  const updated = await f.store.authoring.updateCommand("sticker", { command: edited, categoryIds: ["portraits"], expectedRevision: created.revision });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.command, edited);
  assert.deepEqual(updated.categoryIds, ["portraits"]);
  await rejects(f.store.authoring.updateCommand("sticker", { command: edited, categoryIds: [], expectedRevision: 1 }), "REVISION_CONFLICT");
  await rejects(f.store.authoring.updateCommand("sticker", { command: newCommand("other"), categoryIds: [], expectedRevision: 2 }), "VALIDATION_FAILED");
  await rejects(f.store.authoring.updateCommand("mindmap", { command: (await f.store.authoring.getCommand("mindmap")).command, categoryIds: [], expectedRevision: 1 }), "NOT_EDITABLE");
  const history = await f.store.authoring.getCommandHistory("sticker");
  assert.deepEqual(history.map((h) => h.reason), ["create", "update"]);
  assert.deepEqual(history[0].command, newCommand(), "the earlier revision is kept as it was");
  assert.deepEqual(rawQuery(f.file, "SELECT slash FROM command_slashes WHERE command_id = 'sticker' ORDER BY slash").map((r) => r.slash), ["/aufkleber", "/sticker"]);
});

test("recipe versions are immutable, ordered, and the current version cannot move under an ACTIVE command", async (t) => {
  const f = await fixture(t);
  const created = await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  const v2 = newRecipe("sticker-v1", "0.2.0", { constraints: ["Keep a single white contour border.", "Square canvas."] });

  assert.deepEqual(await f.store.authoring.addRecipeVersion(newRecipe()), { recipeId: "sticker-v1", version: "0.1.0", created: false, current: true });
  assert.deepEqual(await f.store.authoring.addRecipeVersion(v2), { recipeId: "sticker-v1", version: "0.2.0", created: true, current: false });
  assert.deepEqual(await f.store.recipes.getById("sticker-v1"), newRecipe(), "adding a version does not move the current one");
  await rejects(f.store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.5")), "RECIPE_VERSION_NOT_NEWER");
  await rejects(f.store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.2.0", { constraints: ["Round canvas."] })), "RECIPE_VERSION_CONFLICT");

  const moved = await f.store.authoring.setCurrentRecipeVersion("sticker-v1", "0.2.0");
  assert.equal(moved.current, true);
  assert.deepEqual(await f.store.recipes.getById("sticker-v1"), v2);
  const draft = await f.store.authoring.getCommand("sticker");
  assert.equal(draft.recipeVersion, "0.2.0");
  assert.equal(draft.revision, created.revision + 1, "dependent command gets a recipe_version revision");
  assert.deepEqual(await f.store.authoring.listRecipeVersions("sticker-v1"), ["0.1.0", "0.2.0"]);
  assert.deepEqual(await f.store.authoring.getRecipeVersion("sticker-v1", "0.1.0"), newRecipe(), "old version kept");

  // VC-01 recipes are executed by ACTIVE commands: their current version is pinned
  const mindmapV2 = { ...(await f.store.recipes.getById("mindmap-v1")), version: "0.2.0" };
  await rejects(f.store.authoring.addRecipeVersion(mindmapV2, { makeCurrent: true }), "RECIPE_IN_ACTIVE_USE");
  assert.deepEqual(await f.store.authoring.listRecipeVersions("mindmap-v1"), ["0.1.0"], "rolled back with the refused move");
});

test("an archived category stays on commands that already carry it, but cannot be newly assigned", async (t) => {
  const f = await fixture(t);
  await f.store.authoring.createCategory(category("retired"));
  await f.store.authoring.createCategory(category("portraits"));
  const created = await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe(), categoryIds: ["retired"] });
  await f.store.authoring.archiveCategory("retired");
  const edited = newCommand("sticker", "sticker-v1", { tags: ["play", "sticker", "edited"] });
  const updated = await f.store.authoring.updateCommand("sticker", { command: edited, categoryIds: ["retired", "portraits"], expectedRevision: created.revision });
  assert.deepEqual(updated.categoryIds, ["portraits", "retired"]);
  await rejects(f.store.authoring.createDraftCommand({ command: newCommand("other", "sticker-v1"), categoryIds: ["retired"] }), "CATEGORY_ARCHIVED");
});

test("creating a command never moves the recipe version other commands execute", async (t) => {
  const f = await fixture(t);
  await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  const v2 = newRecipe("sticker-v1", "0.2.0", { constraints: ["Square canvas."] });
  await f.store.authoring.addRecipeVersion(v2, { makeCurrent: true });
  const before = await f.store.authoring.getCommand("sticker");
  await rejects(f.store.authoring.createDraftCommand({ command: newCommand("sticker2", "sticker-v1"), recipe: newRecipe() }), "RECIPE_VERSION_NOT_CURRENT");
  await rejects(f.store.authoring.createDraftCommand({ command: newCommand("sticker2", "sticker-v1"), recipe: { ...v2, constraints: ["changed"] } }), "RECIPE_VERSION_CONFLICT");
  assert.deepEqual(await f.store.recipes.getById("sticker-v1"), v2, "current version unchanged");
  assert.deepEqual(await f.store.authoring.getCommand("sticker"), before, "the other command is untouched");
  const second = await f.store.authoring.createDraftCommand({ command: newCommand("sticker2", "sticker-v1"), recipe: v2 });
  assert.equal(second.recipeVersion, "0.2.0");
});

test("an archived command keeps reporting the recipe version it was archived with; restoring re-validates", async (t) => {
  const f = await fixture(t);
  const created = await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  const archived = await f.store.authoring.archiveCommand("sticker", { expectedRevision: created.revision });
  assert.equal(archived.recipeVersion, "0.1.0");
  // a later version that would break this PLAY command (truth-preserving recipes belong to POLISH)
  const polishOnly = newRecipe("sticker-v1", "0.2.0", {
    truthMode: "truth_preserving_edit",
    preserve: ["subject_identity", "people", "object_identity", "geometry", "logos_text", "visible_defects", "material_characteristics"],
    mayChange: ["tonal_treatment"],
  });
  await f.store.authoring.addRecipeVersion(polishOnly, { makeCurrent: true });
  const still = await f.store.authoring.getCommand("sticker");
  assert.equal(still.recipeVersion, "0.1.0", "frozen at archive time");
  assert.equal(still.revision, archived.revision, "no revision added while archived");
  const error = await rejects(f.store.authoring.transitionCommand("sticker", "DRAFT", { expectedRevision: archived.revision }), "VALIDATION_FAILED");
  assert.ok(error.issues.some((issue) => issue.code === "NON_POLISH_TRUTH_PRESERVING"));
  assert.equal((await f.store.authoring.getCommand("sticker")).lifecycle, "ARCHIVED");
});

test("operator reads are one snapshot even when another process commits between their statements", async (t) => {
  const f = await fixture(t);
  await f.store.authoring.createCategory(category("cat-a"));
  await f.store.authoring.createCategory(category("cat-b"));
  await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe(), categoryIds: ["cat-a"] });
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(f.file);
  t.after(() => other.close());
  // Another process commits a new revision with other categories exactly when the reader prepares its
  // category query, i.e. between the reader's command-row read and its category read.
  const original = DatabaseSync.prototype.prepare;
  let armed = true;
  DatabaseSync.prototype.prepare = function (sql) {
    if (armed && this !== other && sql.startsWith("SELECT category_id FROM command_categories")) {
      armed = false;
      other.exec("BEGIN IMMEDIATE");
      other.prepare("UPDATE commands SET revision = revision + 1, updated_at = 'x' WHERE id = 'sticker'").run();
      other.prepare("DELETE FROM command_categories WHERE command_id = 'sticker'").run();
      other.prepare("INSERT INTO command_categories VALUES ('sticker', 'cat-b')").run();
      other.exec("COMMIT");
    }
    return original.call(this, sql);
  };
  let seen;
  try {
    seen = await f.store.authoring.getCommand("sticker");
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  assert.equal(armed, false, "the interleaved write happened");
  assert.deepEqual([seen.revision, seen.categoryIds], [1, ["cat-a"]], "revision and categories from the same snapshot");
  const after = await f.store.authoring.getCommand("sticker");
  assert.deepEqual([after.revision, after.categoryIds], [2, ["cat-b"]], "the other process's commit is visible afterwards");
});

test("a write refused by a database rule is CONSTRAINT_VIOLATION; lock contention is DATABASE_BUSY", async (t) => {
  const f = await fixture(t);
  const created = await f.store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(f.file);
  t.after(() => other.close());
  // revision 2 already exists in the history (written behind the repository's back)
  other.exec("INSERT INTO command_revisions SELECT command_id, 2, lifecycle, document, category_ids, recipe_version, reason, recorded_at FROM command_revisions WHERE command_id = 'sticker'");
  const violation = await rejects(f.store.authoring.transitionCommand("sticker", "TESTING", { expectedRevision: created.revision }), "CONSTRAINT_VIOLATION");
  assert.equal(violation.unavailable, false);
  assert.equal((await f.store.authoring.getCommand("sticker")).lifecycle, "DRAFT", "rolled back");

  const busyStore = openStore(f.file, { busyTimeoutMs: 20 });
  t.after(() => busyStore.close());
  other.exec("BEGIN IMMEDIATE");
  try {
    const busy = await rejects(busyStore.authoring.createCategory(category("later")), "DATABASE_BUSY");
    assert.equal(busy.transient, true);
  } finally {
    other.exec("ROLLBACK");
  }
  assert.equal((await busyStore.authoring.createCategory(category("later"))).id, "later", "succeeds once the lock is gone");
});
