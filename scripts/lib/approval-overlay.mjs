// TEST-ONLY approval overlay: makes /actionfigure executable on the Gemini candidate by editing an
// in-memory copy of the recipe book and model registry. Used by unit tests and by the positive-control
// smoke (on an exported copy of HEAD). It is never applied to the committed documents; a real approval
// is its own commit citing qualification evidence (docs/generation-boundary.md, Qualification).

export const OVERLAY_MODEL_ID = "google/gemini-3.1-flash-image";
export const OVERLAY_RECIPE_ID = "actionfigure-v1";

export function applyTestApproval({ recipes, models }) {
  const model = models.models.find((item) => item.id === OVERLAY_MODEL_ID);
  model.allowlist = "allowed";
  model.benchmarkStatus = "passed";
  model.policy.privacyReview = "approved";
  const recipe = recipes.recipes.find((item) => item.recipeId === OVERLAY_RECIPE_ID);
  if (!recipe.testedModels.some((entry) => entry.modelRef === OVERLAY_MODEL_ID && entry.result === "pass")) {
    recipe.testedModels.push({ modelRef: OVERLAY_MODEL_ID, testedAt: "2026-10-06", result: "pass", fixtureRefs: ["test-fixture"] });
    recipe.lastTestedAt = recipe.testedModels.map((entry) => entry.testedAt).sort().at(-1);
    recipe.evaluationStatus = "fixture_tested";
  }
  if (!recipe.modelAdapters.some((adapter) => adapter.modelRef === OVERLAY_MODEL_ID)) {
    recipe.modelAdapters.push({ modelRef: OVERLAY_MODEL_ID, status: "approved", promptOverrides: [] });
  }
}
