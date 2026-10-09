import assert from "node:assert/strict";
import test from "node:test";

import { handleGenerate } from "../src/server/generation/handler.ts";
import { resolveCommandRef, resolveExecution } from "../src/server/generation/resolve.ts";
import { CatalogueStoreError } from "../src/server/persistence/errors.ts";
import { applyTestApproval } from "../scripts/lib/approval-overlay.mjs";
import { deps, generateRequest, formBody, liveBundle, sourcesFrom } from "./helpers/generation.mjs";
import { migratedDatabase, newCommand, newRecipe, openStore, registryPort } from "./helpers/persistence.mjs";

// DYAI-39 regression: the generation boundary resolves through the durable store exactly as it does
// through any other repository implementation, and a broken store fails the route closed.

async function approvedStore(t) {
  const bundle = liveBundle();
  applyTestApproval(bundle);
  const { file, cleanup } = migratedDatabase();
  const models = registryPort(bundle.models);
  const store = openStore(file, { models });
  t.after(() => {
    store.close();
    cleanup();
  });
  await store.importSeed({ catalogue: bundle.catalogue, recipes: bundle.recipes });
  return { bundle, store, sources: { commands: store.commands, recipes: store.recipes, models } };
}

async function outcome(sources, ref) {
  try {
    const command = await resolveCommandRef(ref, sources.commands);
    return { plan: (await resolveExecution(command, sources)).plan };
  } catch (error) {
    return { error: `${error.name}:${error.code ?? ""}` };
  }
}

test("every VC-01 slash resolves to the same plan or the same refusal through the durable store", async (t) => {
  const { bundle, sources } = await approvedStore(t);
  const memory = sourcesFrom(bundle);
  const refs = bundle.catalogue.commands.flatMap((command) => [command.canonicalSlash, command.id, ...command.aliases.map((alias) => alias.slash)]);
  let executable = 0;
  for (const ref of [...refs, "/unknown"]) {
    const [durable, inMemory] = await Promise.all([outcome(sources, ref), outcome(memory, ref)]);
    assert.deepEqual(durable, inMemory, ref);
    if (durable.plan) executable += 1;
  }
  assert.ok(executable >= 2, `the approval overlay makes /actionfigure executable (by slash and id), got ${executable}`);
});

test("the route generates from the durable store, and does not serve a non-ACTIVE command", async (t) => {
  const { store, sources } = await approvedStore(t);
  const ok = await handleGenerate(generateRequest(), deps({ sources }).deps);
  const body = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(body));
  assert.deepEqual(body.recipe, { id: "actionfigure-v1", version: "0.1.0", truthMode: "creative_entertainment" });

  const draft = await store.authoring.createDraftCommand({ command: newCommand(), recipe: newRecipe() });
  await store.authoring.transitionCommand("sticker", "TESTING", { expectedRevision: draft.revision });
  const hidden = await handleGenerate(generateRequest({ form: formBody({ command: "/sticker" }) }), deps({ sources }).deps);
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json()).error, "command_not_found");
});

test("a durable store that cannot serve fails the route closed with 503 catalogue_unavailable", async () => {
  const broken = async () => {
    throw new CatalogueStoreError("DATABASE_MISSING", "configured database file does not exist");
  };
  for (const sources of [
    { commands: { listPublicCommands: broken, getById: broken, findBySlash: broken }, recipes: { getById: broken }, models: { async load() { return liveBundle().models; } } },
    { ...(await (async () => { const b = liveBundle(); applyTestApproval(b); return sourcesFrom(b); })()), recipes: { getById: broken } },
  ]) {
    const setup = deps({ sources });
    const response = await handleGenerate(generateRequest(), setup.deps);
    const body = await response.json();
    assert.equal(response.status, 503, JSON.stringify(body));
    assert.equal(body.error, "catalogue_unavailable");
    assert.equal(setup.provider.calls.length, 0, "provider never called");
  }
});
