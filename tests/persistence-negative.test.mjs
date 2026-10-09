import assert from "node:assert/strict";
import test from "node:test";

import { category, committedRegistry, newCommand, newRecipe, openStore, registryPort, rejects, seededStore, tableCounts } from "./helpers/persistence.mjs";

// DYAI-39 required negative tests. Each rejected write must name its reason (CatalogueStoreError
// code) and leave every authoring table exactly as it was.

async function fixture(t, options) {
  const seeded = await seededStore(options);
  t.after(() => {
    seeded.store.close();
    seeded.cleanup();
  });
  await seeded.store.authoring.createCategory(category("portraits"));
  return seeded;
}

async function refusedWithoutTrace(file, promise, code) {
  const before = tableCounts(file);
  const error = await rejects(promise, code);
  assert.deepEqual(tableCounts(file), before, `${code}: no row written`);
  return error;
}

test("duplicate canonical slash and slash collisions are refused", async (t) => {
  const { file, store } = await fixture(t);
  // an existing VC-01 command id/slash
  await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: newCommand("actionfigure", "actionfigure-v1") }), "SLASH_CONFLICT");
  // a canonical slash that is another command's alias (/lego belongs to bricktoy)
  const lego = newCommand("lego", "sticker-v1", { riskFlags: ["synthetic_visualisation", "person_likeness"] });
  await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: lego, recipe: newRecipe() }), "SLASH_CONFLICT");
  // an alias that is another command's canonical slash or alias
  for (const slash of ["/mindmap", "/lego", "/learningcomic"]) {
    const command = newCommand("sticker", "sticker-v1", { aliases: [{ slash, kind: "spelling_variant", publicUse: "allowed" }] });
    await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command, recipe: newRecipe() }), "SLASH_CONFLICT");
  }
  // a second draft with the same canonical slash
  await store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: newCommand() }), "SLASH_CONFLICT");
});

test("invalid lifecycle values and forbidden transitions are refused", async (t) => {
  const { file, store } = await fixture(t);
  const draft = await store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  for (const value of ["PUBLISHED", "draft", "", null, undefined]) {
    await refusedWithoutTrace(file, store.authoring.transitionCommand("sticker", value, { expectedRevision: draft.revision }), "LIFECYCLE_INVALID");
  }
  await rejects(store.authoring.listCommands({ lifecycles: ["ACTIVE", "LIVE"] }), "LIFECYCLE_INVALID");
  await rejects(store.authoring.listCommands({ lifecycles: [] }), "LIFECYCLE_INVALID");
  // DRAFT -> ACTIVE skips TESTING; a DRAFT never becomes executable on its own
  await refusedWithoutTrace(file, store.authoring.transitionCommand("sticker", "ACTIVE", { expectedRevision: draft.revision }), "LIFECYCLE_TRANSITION_FORBIDDEN");
  await refusedWithoutTrace(file, store.authoring.transitionCommand("sticker", "DRAFT", { expectedRevision: draft.revision }), "LIFECYCLE_TRANSITION_FORBIDDEN");
  await refusedWithoutTrace(file, store.authoring.transitionCommand("mindmap", "DRAFT", { expectedRevision: 1 }), "LIFECYCLE_TRANSITION_FORBIDDEN");
  await refusedWithoutTrace(file, store.authoring.transitionCommand("ghost", "TESTING", { expectedRevision: 1 }), "COMMAND_NOT_FOUND");
  await refusedWithoutTrace(file, store.authoring.transitionCommand("sticker", "TESTING", { expectedRevision: 7 }), "REVISION_CONFLICT");
  assert.equal((await store.authoring.getCommand("sticker")).lifecycle, "DRAFT");
});

test("a command that needs a recipe fails closed on a missing or dangling recipe relation", async (t) => {
  const { file, store } = await fixture(t);
  // seed maturity requires a recipe; the referenced id does not exist
  await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: newCommand("sticker", "ghost-v1") }), "RECIPE_NOT_FOUND");
  // seed maturity with no recipe at all (contract COMMAND_RECIPE_REQUIRED)
  const error = await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: newCommand("sticker", null, { maturity: "seed" }) }), "VALIDATION_FAILED");
  assert.ok(error.issues.some((issue) => issue.code === "COMMAND_RECIPE_REQUIRED"));
  // the recipe given with the command is for another recipe id
  await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe("other-v1") }), "VALIDATION_FAILED");
  // lane/truth-mode mismatch: a POLISH command on a creative recipe (contract cross-document rule)
  const polish = newCommand("glossy", "sticker-v1", { lane: "polish", riskFlags: ["synthetic_visualisation", "identity_preservation"] });
  const crossError = await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: polish, recipe: newRecipe() }), "VALIDATION_FAILED");
  assert.ok(crossError.issues.some((issue) => issue.code === "POLISH_NOT_TRUTH_PRESERVING"));
  // unknown or archived category
  await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe(), categoryIds: ["ghost"] }), "CATEGORY_NOT_FOUND");
  await store.authoring.createCategory(category("retired"));
  await store.authoring.archiveCategory("retired");
  await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe(), categoryIds: ["retired"] }), "CATEGORY_ARCHIVED");
});

test("malformed mandatory DE/EN metadata is refused for commands and categories", async (t) => {
  const { file, store } = await fixture(t);
  const variants = {
    "missing de display": (c) => delete c.display.de,
    "empty en name": (c) => (c.display.en.name = ""),
    "whitespace de description": (c) => (c.display.de.description = "   "),
    "missing job.de": (c) => delete c.job.de,
    "blank job.en": (c) => (c.job.en = "\t"),
    "extra locale key": (c) => (c.display.fr = { name: "Autocollant", description: "x" }),
    "number as name": (c) => (c.display.en.name = 42),
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const command = newCommand();
    mutate(command);
    await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command, recipe: newRecipe() }), "VALIDATION_FAILED").catch((error) => {
      throw new Error(`${name}: ${error.message}`);
    });
  }
  for (const broken of [
    category("x1", { display: { en: { name: "X", description: "x" } } }),
    category("x2", { display: { en: { name: " ", description: "x" }, de: { name: "X", description: "x" } } }),
    category("Bad Slug"),
  ]) {
    await refusedWithoutTrace(file, store.authoring.createCategory(broken), "VALIDATION_FAILED");
  }
  await refusedWithoutTrace(file, store.authoring.createCategory(category("portraits")), "CATEGORY_CONFLICT");
});

test("Model Capability documents, provider credentials and image bytes cannot enter through the authoring boundary", async (t) => {
  const { file, store } = await fixture(t);
  const model = committedRegistry.models[0];
  const cases = [
    ["a whole Model Capability as a recipe", () => store.authoring.addRecipeVersion(structuredClone(model))],
    ["Model Capability facts inside a recipe", () => store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.0", { allowlist: "allowed" }))],
    ["capabilities nested in a recipe adapter", () => store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.0", { modelAdapters: [{ modelRef: model.id, status: "untested", promptOverrides: [], providerModelId: model.providerModelId }] }))],
    ["an apiKey field on a command", () => store.authoring.createDraftCommand({ command: { ...newCommand(), apiKey: "x" }, recipe: newRecipe() })],
    ["an OpenRouter key in command text", () => store.authoring.createDraftCommand({ command: newCommand("sticker", "sticker-v1", { tags: ["play", `sk-or-v1-${"a".repeat(40)}`] }), recipe: newRecipe() })],
    ["a bearer token in a recipe constraint", () => store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.0", { constraints: ["Bearer abcdefghijklmnopqrstuvwxyz012345"] }))],
    ["an image data URI as a thumbnail", () => store.authoring.createDraftCommand({ command: newCommand("sticker", "sticker-v1", { thumbnails: [{ fixtureFamily: "person", src: "data:image/png;base64,iVBORw0KGgo", alt: { en: "a", de: "a" } }] }), recipe: newRecipe() })],
    ["raw base64 image bytes in a recipe", () => store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.0", { fixtureRefs: ["A".repeat(400)] }))],
    ["a secret on a category", () => store.authoring.createCategory({ ...category("vault"), secret: "s3cr3t" })],
  ];
  for (const [name, write] of cases) {
    await refusedWithoutTrace(file, Promise.resolve().then(write), "FORBIDDEN_CONTENT").catch((error) => {
      throw new Error(`${name}: ${error.message}`);
    });
  }
  // provider/model names in command metadata are refused by the contract's provider scan
  const named = newCommand("sticker", "sticker-v1", { display: { en: { name: "Sticker", description: `Made with ${model.id.split("/")[1]}.` }, de: { name: "Sticker", description: "Aufkleber." } } });
  const error = await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command: named, recipe: newRecipe() }), "VALIDATION_FAILED");
  assert.ok(error.issues.some((issue) => issue.code === "PROVIDER_TERM_FORBIDDEN"));
  // recipe model references must resolve in the separate registry, which is never written
  await refusedWithoutTrace(file, store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.0", { modelAdapters: [{ modelRef: "acme/unlisted-image", status: "untested", promptOverrides: [] }] })), "VALIDATION_FAILED");
});

test("promotion to ACTIVE re-validates against the live registry and fails closed when the record no longer holds", async (t) => {
  const { file, store } = await fixture(t);
  const model = committedRegistry.models[0];
  const recipe = newRecipe("sticker-v1", "0.1.0", { modelAdapters: [{ modelRef: model.id, status: "untested", promptOverrides: [] }] });
  const draft = await store.authoring.createDraftCommand({ command: newCommand(), recipe });
  const testing = await store.authoring.transitionCommand("sticker", "TESTING", { expectedRevision: draft.revision });
  store.close();
  // the registry (separate runtime source) dropped the model the recipe's adapter names
  const shrunk = { ...committedRegistry, models: committedRegistry.models.filter((m) => m.id !== model.id) };
  const reopened = openStore(file, { models: registryPort(shrunk) });
  t.after(() => reopened.close());
  const error = await refusedWithoutTrace(file, reopened.authoring.transitionCommand("sticker", "ACTIVE", { expectedRevision: testing.revision }), "VALIDATION_FAILED");
  assert.ok(error.issues.some((issue) => issue.code === "ADAPTER_MODEL_UNRESOLVED"));
  assert.equal(await reopened.commands.getById("sticker"), null);
});

test("credential and payload shapes a first guard missed are refused on every write path, including updateCommand", async (t) => {
  const { file, store } = await fixture(t);
  const draft = await store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  const b64 = Buffer.from("x".repeat(300)).toString("base64");
  const values = {
    "data URI with a parameter": `data:image/png;name=x.png;base64,${b64.slice(0, 40)}`,
    "SVG data URI": "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "line-wrapped base64": Array.from({ length: 5 }, () => b64.slice(0, 76)).join("\n"),
    "base64url run": `${"A1b2-C3d4_".repeat(25)}`,
    "lowercase bearer": "authorization: bearer abcdef0123456789xyz",
    "basic auth": "Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==",
    "google api key": `AIza${"B".repeat(35)}`,
    "slack token": "xoxb-1234567890-abcdefghij",
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "url with credentials": "https://user:s3cret@example.com/x",
    "oversized text": "a ".repeat(2100),
  };
  for (const [name, value] of Object.entries(values)) {
    const command = newCommand();
    command.display.en.description = `Turns your photo into a sticker. ${value}`;
    await refusedWithoutTrace(file, store.authoring.updateCommand("sticker", { command, categoryIds: [], expectedRevision: draft.revision }), "FORBIDDEN_CONTENT").catch((error) => {
      throw new Error(`update / ${name}: ${error.message}`);
    });
    await refusedWithoutTrace(file, store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.9.0", { baseIntent: value })), "FORBIDDEN_CONTENT").catch((error) => {
      throw new Error(`recipe / ${name}: ${error.message}`);
    });
  }
});

test("positive controls: ordinary authoring prose passes the content guard", async (t) => {
  const { store } = await fixture(t);
  const prose = [
    "Keep a basic understanding of the bearer of the badge; token-free layout.",
    "Die Grundidee bleibt erhalten: klare Linien, keine erfundenen Logos, sichtbare Mängel bleiben.",
    "Model the scene like a miniature diorama (tilt-shift), not a photo of a real place.",
    "Secret ingredient: patience. Password-style captions are not used.",
    "x".repeat(150),
  ];
  const command = newCommand("sticker", "sticker-v1", {
    display: { en: { name: "Sticker", description: prose[0] }, de: { name: "Sticker", description: prose[1] } },
    job: { en: prose[2], de: prose[1] },
  });
  const recipe = newRecipe("sticker-v1", "0.1.0", { constraints: prose, baseIntent: `${prose[0]} ${"Long but plain description. ".repeat(60)}` });
  const created = await store.authoring.createDraftCommand({ command, recipe });
  assert.deepEqual(created.command, command);
});
