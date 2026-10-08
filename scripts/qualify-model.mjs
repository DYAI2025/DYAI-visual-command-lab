// Narrow technical qualification: ONE real OpenRouter Image API call for one command recipe on one
// model, with the committed synthetic fixture, through the same adapter the route uses
// (src/server/openrouter/client.ts). It records what happened in docs/evidence/dyai-37/; it is a
// wiring/capability check, not a quality benchmark.
//
//   node scripts/qualify-model.mjs                         # offline: prints the plan, 0 calls
//   OPENROUTER_API_KEY=... node scripts/qualify-model.mjs --live [--save <dir outside the repo>]
//
// The key is read from the environment and used only in the Authorization header. It is never
// printed or written. No re-roll: one call per plan and code state, whatever the outcome.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { EVIDENCE_DIR, evidenceRecords, gitState, outsideRepository, qualificationTarget, sameCodeAs, writeEvidence } from "./lib/plan.mjs";
import { composePrompt, resolveParameters } from "../src/server/generation/prompt.ts";
import { inspectImage } from "../src/server/generation/image.ts";
import { createOpenRouterClient, EXECUTION_PROFILES, ProviderError } from "../src/server/openrouter/client.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const COMMAND = option("--command", "/actionfigure");
const MODEL = option("--model", "google/gemini-3.1-flash-image");
const FIXTURE = "tests/fixtures/qualification/synthetic-figure-01.png";
const LIMITS = { minEdge: 64, maxEdge: 4096, maxOutputBytes: 20 * 1024 * 1024 };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let target;
try {
  target = await qualificationTarget(COMMAND, MODEL);
} catch (error) {
  console.error(`qualify-model: ${COMMAND} cannot be qualified: ${error.code ?? error.name}: ${error.message.split("\n")[0]}`);
  process.exit(2);
}
const { command, recipe, model } = target;
const profile = EXECUTION_PROFILES[MODEL];
if (!recipe || !model || !profile) {
  console.error(`qualify-model: ${MODEL} is not a compatible model with an execution profile for ${COMMAND}`);
  process.exit(2);
}
const fixture = new Uint8Array(fs.readFileSync(FIXTURE));
const fixtureInfo = inspectImage(fixture);
const adapter = recipe.modelAdapters.find((item) => item.modelRef === MODEL);
const prompt = composePrompt(recipe, adapter?.promptOverrides ?? [], resolveParameters(recipe, {}));

const plan = {
  command: command.canonicalSlash,
  recipe: `${recipe.recipeId}@${recipe.version}`,
  model: MODEL,
  providerModelId: model.providerModelId,
  profile,
  fixture: { path: FIXTURE, sha256: sha256(fixture), ...fixtureInfo, byteLength: fixture.byteLength },
  promptSha256: sha256(prompt),
};

if (!flag("--live")) {
  console.log(JSON.stringify({ mode: "offline", calls: 0, plan }, null, 2));
  process.exit(0);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("qualify-model: --live needs OPENROUTER_API_KEY in the environment");
  process.exit(2);
}
const repo = gitState();
// No re-roll. A passing record for the same model, fixture and prompt already is the evidence; any
// record for that plan made on the same code (incomplete, failed or passed) is this candidate's one
// call. Only a code change (outside docs/evidence) earns a new attempt after a failure.
const previous = evidenceRecords("qualification-").find(
  (item) => item.plan?.model === plan.model && item.plan?.fixture?.sha256 === plan.fixture.sha256 &&
    item.plan?.promptSha256 === plan.promptSha256 &&
    (item.result?.outcome === "technical_pass" || sameCodeAs(item.candidate?.gitSha)),
);
if (previous) {
  console.error(`qualify-model: ${previous.file} already records a call (${previous.result?.outcome ?? "unknown"}) for this plan; refusing a second call`);
  process.exit(2);
}

const saveDir = option("--save", null);
if (saveDir && !outsideRepository(saveDir)) {
  console.error("qualify-model: --save must point outside the repository (generated images are not stored in it)");
  process.exit(2);
}

const client = createOpenRouterClient({
  apiKey,
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 180_000,
  maxOutputBytes: LIMITS.maxOutputBytes,
});

const startedAt = new Date().toISOString();
const outFile = path.join(EVIDENCE_DIR, `qualification-${MODEL.replace(/\W+/g, "-")}-${startedAt.replace(/[:.]/g, "-")}.json`);
const evidence = {
  kind: "dyai-37-technical-qualification",
  scope: "One real OpenRouter Image API call with a synthetic, non-personal fixture. Proves the reference-image request/response path for this recipe on this model; not a quality, likeness or user-value benchmark.",
  startedAt,
  candidate: { gitSha: repo.sha, cleanTree: repo.clean },
  calls: 1,
  plan,
  // Recorded before the call: a run that dies mid-call still counts as this plan's one call.
  result: { outcome: "incomplete" },
};
writeEvidence(outFile, evidence, [apiKey]);
const started = performance.now();
let record;
try {
  const result = await client.generate({
    providerModelId: model.providerModelId,
    profile,
    prompt,
    sourceImage: { mimeType: fixtureInfo.mimeType, bytes: fixture },
    principalId: "integration:qualification",
  });
  const latencyMs = Math.round(performance.now() - started);
  const { image } = result;
  const criteria = {
    http200: result.providerStatus === 200,
    decodedImage: ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType),
    dimensionsWithinLimits: Math.min(image.width, image.height) >= LIMITS.minEdge && Math.max(image.width, image.height) <= LIMITS.maxEdge,
    bytesWithinLimit: image.bytes.byteLength <= LIMITS.maxOutputBytes,
    outputDiffersFromSource: sha256(image.bytes) !== sha256(fixture),
    costReported: result.costUsd !== null,
  };
  record = {
    outcome: Object.values(criteria).every(Boolean) ? "technical_pass" : "technical_fail",
    criteria,
    providerStatus: result.providerStatus,
    latencyMs,
    costUsd: result.costUsd,
    output: { mimeType: image.mimeType, width: image.width, height: image.height, byteLength: image.bytes.byteLength, sha256: sha256(image.bytes) },
  };
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    const file = path.join(saveDir, `qualification-${MODEL.replace(/\W+/g, "-")}.${image.mimeType.split("/")[1]}`);
    fs.writeFileSync(file, image.bytes);
    console.error(`saved output for inspection: ${file}`);
  }
} catch (error) {
  record = {
    outcome: "technical_fail",
    error: error instanceof ProviderError ? { kind: error.kind, providerStatus: error.providerStatus } : { kind: "unexpected", name: error?.name },
    latencyMs: Math.round(performance.now() - started),
  };
}

const serialized = writeEvidence(outFile, { ...evidence, result: record }, [apiKey]);
console.log(serialized);
console.error(`evidence written: ${outFile}`);
process.exit(record.outcome === "technical_pass" ? 0 : 1);
