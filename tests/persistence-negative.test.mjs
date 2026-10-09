import assert from "node:assert/strict";
import test from "node:test";

import { category, committedRegistry, migratedDatabase, newCommand, newRecipe, openStore, registryPort, rejects, seedBundle, seededStore, tableCounts } from "./helpers/persistence.mjs";

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
    ["an OpenAI project key in a recipe constraint", () => store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.0", { constraints: [`Use sk-proj-${"Q".repeat(24)} for calls.`] }))],
    ["an image data URI as a thumbnail", () => store.authoring.createDraftCommand({ command: newCommand("sticker", "sticker-v1", { thumbnails: [{ fixtureFamily: "person", src: "data:image/png;base64,iVBORw0KGgo", alt: { en: "a", de: "a" } }] }), recipe: newRecipe() })],
    ["raw base64 image bytes in a recipe", () => store.authoring.addRecipeVersion(newRecipe("sticker-v1", "0.1.0", { fixtureRefs: [Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 131 + 7) % 256)).toString("base64")] }))],
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
  // encoded binary has many distinct characters; a fixed byte sequence keeps the test deterministic
  const b64 = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919 + 13) % 256)).toString("base64");
  const values = {
    "data URI with a parameter": `data:image/png;name=x.png;base64,${b64.slice(0, 40)}`,
    "SVG data URI": "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "line-wrapped base64": Array.from({ length: 5 }, () => b64.slice(0, 76)).join("\n"),
    "slash-prefixed base64 (JPEG starts with /9j/)": `/9j/${b64.slice(0, 300)}`,
    "base64 wrapped at 50 with spaces": Array.from({ length: 5 }, (_, i) => b64.slice(i * 50, i * 50 + 50)).join(" "),
    "base64url run": `${"A1b2-C3d4_".repeat(25)}`,
    "Stripe secret key": `sk_live_${"a1B2".repeat(6)}`,
    "PEM private key": "-----BEGIN RSA PRIVATE KEY----- MIIB",
    "AWS access key id": "AKIA0123456789ABCDEF",
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
    `A token at the length limit: ${"x".repeat(63)}.`,
    "Keep metadata: title, author and date. Password: required for the export dialog. Token: 12345678 credits.",
    `Section\n${"-".repeat(60)}\n${"-".repeat(60)}\n${"=".repeat(70)}\nSee [the guide](https://example.com/guides/visual-commands/sticker-workflow/step-by-step) (https://example.com/guides/visual-commands/a-second-rather-long-reference-path).`,
    "Bearer bonds and basic instrumentalisation are period props; see https://example.com/reference/a-rather-long-path/that-keeps-going/and-going/still-a-url",
  ];
  const command = newCommand("sticker", "sticker-v1", {
    display: { en: { name: "Sticker", description: prose[0] }, de: { name: "Sticker", description: prose[1] } },
    job: { en: prose[2], de: prose[1] },
  });
  const recipe = newRecipe("sticker-v1", "0.1.0", { constraints: prose, baseIntent: `${prose[0]} ${"Long but plain description. ".repeat(60)}` });
  const created = await store.authoring.createDraftCommand({ command, recipe });
  assert.deepEqual(created.command, command);
});

test("the update guard scans every field of the command, not only the display text", async (t) => {
  const { file, store } = await fixture(t);
  const draft = await store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  const key = `sk-or-v1-${"c".repeat(40)}`;
  const placements = {
    "job.de": (c) => (c.job.de = `Mach einen Sticker ${key}`),
    "thumbnail alt": (c) => (c.thumbnails = [{ fixtureFamily: "person", src: "/fixtures/a.png", alt: { en: key, de: "Bild" } }]),
    "evidence ref": (c) => (c.evidence = { observation: "proposed", status: "source_linked", refs: [key] }),
    "display.de.name": (c) => (c.display.de.name = key),
  };
  for (const [name, place] of Object.entries(placements)) {
    const command = newCommand();
    place(command);
    await refusedWithoutTrace(file, store.authoring.updateCommand("sticker", { command, categoryIds: [], expectedRevision: draft.revision }), "FORBIDDEN_CONTENT").catch((error) => {
      throw new Error(`${name}: ${error.message}`);
    });
  }
});

test("the content guard stays linear on adversarial input (no catastrophic backtracking)", async () => {
  const { assertNoForbiddenContent, MAX_TEXT_LENGTH } = await import("../src/server/persistence/content-guard.ts");
  const adversarial = [
    "A".repeat(63) + "\n".repeat(MAX_TEXT_LENGTH - 64) + "x",
    ("A".repeat(39) + " \n ").repeat(90),
    ("data:" + "a".repeat(60) + " ").repeat(60),
    ("bearer " + "a".repeat(15) + " ").repeat(170),
    ("http://" + "a".repeat(40) + ":").repeat(80),
    ("eyJ" + "a".repeat(60) + " ").repeat(60),
    (" ").repeat(MAX_TEXT_LENGTH),
  ];
  for (const text of adversarial) {
    assert.ok(text.length <= MAX_TEXT_LENGTH, `${text.length}`);
    const started = performance.now();
    try {
      assertNoForbiddenContent({ text }, "command");
    } catch {
      // refused or accepted: only the time matters here
    }
    const ms = performance.now() - started;
    assert.ok(ms < 50, `${JSON.stringify(text.slice(0, 30))}… took ${ms.toFixed(1)} ms`);
  }
});

test("non-string ids are refused as input errors, not raw driver errors", async (t) => {
  const { store } = await fixture(t);
  for (const id of [undefined, null, 42, { id: "x" }]) {
    await rejects(store.authoring.getCommand(id), "VALIDATION_FAILED");
  }
});

test("this server's own configured secrets are refused in any form, without guessing at prose", async (t) => {
  const { file, store } = await fixture(t);
  const secret = "or-test-0123456789abcdefFEDCBA";
  const before = process.env.OPENROUTER_API_KEY;
  const other = process.env.DYAI39_WEBHOOK_TOKEN;
  process.env.OPENROUTER_API_KEY = secret;
  process.env.DYAI39_WEBHOOK_TOKEN = "hook-9f8e7d6c5b4a3210zz";
  t.after(() => {
    if (before === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = before;
    if (other === undefined) delete process.env.DYAI39_WEBHOOK_TOKEN;
    else process.env.DYAI39_WEBHOOK_TOKEN = other;
  });
  for (const text of [`authorization: bearer ${secret}`, `key=${secret}.`, `Webhook hook-9f8e7d6c5b4a3210zz`]) {
    const command = newCommand();
    command.display.en.description = text;
    await refusedWithoutTrace(file, store.authoring.createDraftCommand({ command, recipe: newRecipe() }), "FORBIDDEN_CONTENT").catch((error) => {
      throw new Error(`${text}: ${error.message}`);
    });
  }
  // a generic bearer value of unknown format is outside the guard's documented mechanisms
  const prose = newCommand();
  prose.display.en.description = "Requires only basic troubleshooting. Digest Wochenzusammenfassung. Bearer bonds.";
  assert.equal((await store.authoring.createDraftCommand({ command: prose, recipe: newRecipe() })).lifecycle, "DRAFT");
});

test("seed import applies the per-document caps, not only the bundle as a whole", async (t) => {
  const { cleanup, file } = migratedDatabase();
  t.after(cleanup);
  const store = openStore(file);
  t.after(() => store.close());
  const seed = seedBundle();
  seed.catalogue.commands[0].tags = Array.from({ length: 3000 }, (_, i) => `tag-${i}`);
  await rejects(store.importSeed(seed), "FORBIDDEN_CONTENT");
  assert.deepEqual(tableCounts(file).commands, 0);
});
