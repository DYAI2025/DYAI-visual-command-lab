import assert from "node:assert/strict";
import test from "node:test";

import { handleGenerate } from "../src/server/generation/handler.ts";
import { resolveCommandRef, resolveExecution } from "../src/server/generation/resolve.ts";
import { ContractResolutionError } from "../src/domain/contract/contract.ts";
import { approvedSources, committedSources, deps, formBody, generateRequest, liveBundle, png, sourcesFrom, MODEL_ID } from "./helpers/generation.mjs";

// Command -> Recipe -> Model resolution through the repositories and the model registry
// (src/server/generation/resolve.ts): what the repositories serve is what executes.

const call = async (setup, request = generateRequest()) => {
  const response = await handleGenerate(request, setup.deps);
  return { status: response.status, body: await response.json() };
};

test("the recipe the repository serves is the recipe that executes", async () => {
  const setup = deps({
    sources: approvedSources((bundle) => {
      bundle.recipes.recipes.find((recipe) => recipe.recipeId === "actionfigure-v1").version = "0.9.9";
    }),
  });
  const { status, body } = await call(setup);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.recipe.version, "0.9.9");
  assert.equal(setup.events.at(-1).recipeVersion, "0.9.9");
});

test("one generation reads one command, one recipe and the registry once", async () => {
  const sources = approvedSources();
  const counts = { findBySlash: 0, recipe: 0, load: 0, list: 0 };
  const counted = {
    commands: {
      listPublicCommands: (...a) => (counts.list++, sources.commands.listPublicCommands(...a)),
      getById: (...a) => sources.commands.getById(...a),
      findBySlash: (...a) => (counts.findBySlash++, sources.commands.findBySlash(...a)),
    },
    recipes: { getById: (...a) => (counts.recipe++, sources.recipes.getById(...a)) },
    models: { load: () => (counts.load++, sources.models.load()) },
  };
  const { status } = await call(deps({ sources: counted }));
  assert.equal(status, 200);
  assert.deepEqual(counts, { findBySlash: 1, recipe: 1, load: 1, list: 0 });
});

test("command references: id, canonical slash and public alias resolve; review-gated alias does not", async () => {
  const { commands } = committedSources();
  assert.equal((await resolveCommandRef("actionfigure", commands)).id, "actionfigure");
  assert.equal((await resolveCommandRef("/actionfigure", commands)).id, "actionfigure");
  assert.equal((await resolveCommandRef("/learningcomic", commands)).id, "lerncomic");
  await assert.rejects(resolveCommandRef("/lego", commands), (error) => error instanceof ContractResolutionError && error.code === "COMMAND_NOT_FOUND");
  await assert.rejects(resolveCommandRef("/nope", commands), (error) => error.code === "COMMAND_NOT_FOUND");
});

test("the committed repositories execute nothing: no model is approved yet", async () => {
  const sources = committedSources();
  for (const slash of ["/actionfigure", "/mindmap", "/35mm"]) {
    const command = await resolveCommandRef(slash, sources.commands);
    await assert.rejects(resolveExecution(command, sources), (error) => error.code === "NO_APPROVED_MODEL", slash);
  }
  const candidate = await resolveCommandRef("/manga", sources.commands);
  await assert.rejects(resolveExecution(candidate, sources), (error) => error.code === "RECIPE_NOT_ASSIGNED");
});

test("a deprecated command is not executable (422), not unknown (404)", async () => {
  const setup = deps({
    sources: approvedSources((bundle) => {
      bundle.catalogue.commands.find((command) => command.id === "actionfigure").maturity = "deprecated";
    }),
  });
  const { status, body } = await call(setup);
  assert.equal(status, 422);
  assert.deepEqual([body.error, body.detail], ["command_not_executable", "command_not_executable"]);
  assert.equal(setup.provider.calls.length, 0);
});

test("repository data that breaks a contract invariant fails closed before the provider", async () => {
  // Allowlisted without an approved privacy review: the validator rejects the snapshot.
  const setup = deps({
    sources: approvedSources((bundle) => {
      bundle.models.models.find((model) => model.id === MODEL_ID).policy.privacyReview = "unreviewed";
    }),
  });
  const { status, body } = await call(setup);
  assert.deepEqual([status, body.error], [503, "execution_not_configured"]);
  assert.equal(setup.provider.calls.length, 0);
  assert.equal(setup.events.at(-1).reason, "execution_not_configured");
});

test("an approved adapter on a model that lost reference-image support fails closed (contract invalid)", async () => {
  const setup = deps({
    sources: approvedSources((bundle) => {
      bundle.models.models.find((model) => model.id === MODEL_ID).capabilities.referenceImage = false;
    }),
  });
  const { status, body } = await call(setup);
  assert.deepEqual([status, body.error], [503, "execution_not_configured"]);
  assert.equal(setup.provider.calls.length, 0);
});

test("recipe/model capability mismatch: no model takes as many reference images as the command -> 422 before the provider", async () => {
  const bundle = liveBundle();
  bundle.catalogue.commands.find((command) => command.id === "actionfigure").inputRequirements.maxSourceImages = 2;
  const setup = deps({ sources: sourcesFrom(bundle) });
  const { status, body } = await call(setup);
  assert.deepEqual([status, body.error, body.detail], [422, "command_not_executable", "no_compatible_model"]);
  assert.equal(setup.provider.calls.length, 0);
});

test("more source images than the model accepts are rejected before the provider", async () => {
  const setup = deps();
  const image = { bytes: png(), type: "image/png" };
  const { status, body } = await call(setup, generateRequest({ form: formBody({ images: [image, image] }) }));
  assert.deepEqual([status, body.error], [400, "too_many_images"]);
  assert.equal(setup.provider.calls.length, 0);
});

test("no model picker: a client-chosen model field is refused", async () => {
  const setup = deps();
  const { status, body } = await call(setup, generateRequest({ form: formBody({ extra: { model: "openai/gpt-5-image-mini" } }) }));
  assert.deepEqual([status, body.error], [400, "unexpected_field"]);
  assert.equal(setup.provider.calls.length, 0);
});

test("a recipe id that resolves to nothing is a data error (503), not a candidate state (422)", async () => {
  const setup = deps({
    sources: approvedSources((bundle) => {
      bundle.catalogue.commands.find((command) => command.id === "actionfigure").recipeId = "ghost-v1";
    }),
  });
  const { status, body } = await call(setup);
  assert.deepEqual([status, body.error], [503, "execution_not_configured"]);
  assert.equal(setup.provider.calls.length, 0);
});

test("a malformed command record from the repository is a data error (503)", async () => {
  for (const mutate of [
    (command) => { command.lane = 42; },
    (command) => { command.recipeId = null; }, // a seed must have a recipe
    (command) => { delete command.recipeId; },
  ]) {
    const setup = deps({ sources: approvedSources((bundle) => mutate(bundle.catalogue.commands.find((c) => c.id === "actionfigure"))) });
    const { status, body } = await call(setup);
    assert.deepEqual([status, body.error], [503, "execution_not_configured"], JSON.stringify(body));
    assert.equal(setup.provider.calls.length, 0);
  }
});

test("qualification targets follow the route: deprecated, candidate and unknown commands are refused", async () => {
  const { qualificationTarget } = await import("../scripts/lib/plan.mjs");
  const target = await qualificationTarget("/actionfigure", MODEL_ID);
  assert.deepEqual([target.command.id, target.recipe.recipeId, target.model.id], ["actionfigure", "actionfigure-v1", MODEL_ID]);
  await assert.rejects(qualificationTarget("/manga", MODEL_ID), (error) => error.code === "RECIPE_NOT_ASSIGNED");
  await assert.rejects(qualificationTarget("/nope", MODEL_ID), (error) => error.code === "COMMAND_NOT_FOUND");
  const { loadExecutionSnapshot } = await import("../src/server/generation/resolve.ts");
  const bundle = liveBundle();
  const deprecated = bundle.catalogue.commands.find((c) => c.id === "actionfigure");
  deprecated.maturity = "deprecated";
  await assert.rejects(loadExecutionSnapshot(deprecated, sourcesFrom(bundle)), (error) => error.code === "COMMAND_NOT_EXECUTABLE");
});

test("an unexpected failure records its error class, never its message", async () => {
  const sources = approvedSources();
  sources.models = { load: async () => { throw new TypeError("db password=hunter2 in message"); } };
  const setup = deps({ sources });
  const { status, body } = await call(setup);
  assert.deepEqual([status, body.error], [500, "generation_boundary_failed"]);
  assert.equal(setup.events.at(-1).errorName, "TypeError");
  assert.ok(!JSON.stringify(setup.events).includes("hunter2"));
  assert.ok(!JSON.stringify(body).includes("hunter2"));
});

test("a recipe with a free-text (string) parameter is not executable: 503 before the provider", async () => {
  const setup = deps({
    sources: approvedSources((bundle) => {
      bundle.recipes.recipes
        .find((recipe) => recipe.recipeId === "actionfigure-v1")
        .parameters.push({ name: "caption", type: "string", required: false, description: "caption text" });
    }),
  });
  const { status, body } = await call(setup);
  assert.deepEqual([status, body.error], [503, "execution_not_configured"]);
  assert.equal(setup.provider.calls.length, 0);
});
