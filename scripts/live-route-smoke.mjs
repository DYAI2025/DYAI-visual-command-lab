// Real-boundary smoke: the production build (`next start`) with the real OpenRouter key, called
// over HTTP as the integration principal. Exactly ONE authenticated generation reaches OpenRouter;
// the other requests are fail-closed checks that must not. Records metadata (never image contents)
// in docs/evidence/dyai-37/.
//
//   npm run build
//   OPENROUTER_API_KEY=... node scripts/live-route-smoke.mjs --live [--save <dir outside the repo>]
//
// No re-roll: one run, the outcome is recorded whatever it is.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildSource, gitState, resolvePlan } from "./lib/plan.mjs";
import { inspectImage } from "../src/server/generation/image.ts";
import { generationEvents, startApp } from "./lib/next-app.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const COMMAND = option("--command", "/actionfigure");
const FIXTURE = "tests/fixtures/qualification/synthetic-figure-01.png";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (!args.includes("--live")) {
  console.log("live-route-smoke: offline, 0 calls. Pass --live with OPENROUTER_API_KEY set to run one real generation.");
  process.exit(0);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("live-route-smoke: --live needs OPENROUTER_API_KEY in the environment");
  process.exit(2);
}
if (!fs.existsSync(".next/BUILD_ID")) {
  console.error("live-route-smoke: run `npm run build` first");
  process.exit(2);
}
const saveDir = option("--save", null);
if (saveDir && !path.relative(process.cwd(), path.resolve(saveDir)).startsWith("..")) {
  console.error("live-route-smoke: --save must point outside the repository");
  process.exit(2);
}
// The evidence must belong to one exact candidate: a clean checkout whose HEAD is the commit the
// production build was made from.
const candidate = gitState();
const built = buildSource();
if (!candidate.clean || !built?.clean || built.sha !== candidate.sha) {
  console.error(`live-route-smoke: build ${built?.sha ?? "unknown"} (clean ${built?.clean ?? false}) is not the clean HEAD ${candidate.sha} (clean ${candidate.clean}); commit, then npm run build`);
  process.exit(2);
}
const { plan } = await resolvePlan(COMMAND); // throws if the committed repositories cannot execute it

const token = randomBytes(24).toString("hex");
const fixture = fs.readFileSync(FIXTURE);
const app = await startApp({
  AUTH_PROVIDER: "integration_token",
  AUTH_INTEGRATION_TOKEN_SHA256: sha256(token),
  AUTH_INTEGRATION_PRINCIPAL: "integration:live-smoke",
  RATE_LIMIT_PROVIDER: "memory",
  RATE_LIMIT_BURST_MAX: "5",
  RATE_LIMIT_BURST_WINDOW_SECONDS: "60",
  RATE_LIMIT_QUOTA_MAX: "1",
  RATE_LIMIT_QUOTA_WINDOW_SECONDS: "3600",
  GENERATION_DAILY_BUDGET_USD: "0.5",
  GENERATION_MAX_COST_PER_REQUEST_USD: "0.25",
  OPENROUTER_API_KEY: apiKey,
  OPENROUTER_TIMEOUT_MS: "180000",
});

const form = () => {
  const body = new FormData();
  body.append("command", COMMAND);
  body.append("image", new Blob([fixture], { type: "image/png" }), "synthetic-figure-01.png");
  return body;
};
const post = async (withToken) => {
  const started = performance.now();
  const response = await fetch(`${app.base}/api/generate`, {
    method: "POST",
    headers: withToken ? { authorization: `Bearer ${token}` } : {},
    body: form(),
  });
  const text = await response.text();
  return { status: response.status, text, latencyMs: Math.round(performance.now() - started) };
};

const checks = {};
let output = null;
let success;
try {
  const anonymous = await post(false);
  checks.unauthenticated401 = anonymous.status === 401;
  success = await post(true);
  const body = success.status === 200 ? JSON.parse(success.text) : null;
  if (body) {
    const bytes = new Uint8Array(Buffer.from(body.output.base64, "base64"));
    const info = inspectImage(bytes);
    output = { ...info, byteLength: bytes.byteLength, sha256: sha256(bytes) };
    checks.validImage = Boolean(info) && info.width === body.output.width && info.height === body.output.height;
    checks.synthetic = body.synthetic === true;
    if (saveDir) {
      fs.mkdirSync(saveDir, { recursive: true });
      const file = path.join(saveDir, `live-route-${plan.commandId}.${info.mimeType.split("/")[1]}`);
      fs.writeFileSync(file, bytes);
      console.error(`saved output for inspection: ${file}`);
    }
  }
  checks.authenticated200 = success.status === 200;
  // Only after a success is the quota (1) used up, so this request is refused before the provider.
  // After a failure the slot was returned and this request would be a second real call: skip it.
  if (success.status === 200) {
    const quota = await post(true);
    checks.quotaExceeded429AfterOneSuccess = quota.status === 429 && JSON.parse(quota.text).error === "quota_exceeded";
  }
} finally {
  await app.stop();
}

const log = app.output.join("");
const events = generationEvents(app.output);
const providerEvents = events.filter((event) => event.providerStatus !== null || event.providerLatencyMs !== null);
checks.exactlyOneProviderCall = providerEvents.length === 1;
const forbidden = [apiKey, token, fixture.toString("base64").slice(0, 64)];
if (success?.status === 200) forbidden.push(JSON.parse(success.text).output.base64.slice(0, 64));
checks.serverLogHasNoKeyTokenOrImage = !forbidden.some((item) => log.includes(item));
checks.responsesHaveNoKey = !(success?.text ?? "").includes(apiKey);

const startedAt = new Date().toISOString();
const evidence = {
  kind: "dyai-37-live-route-smoke",
  scope: "Production build (next start, local loopback), real OpenRouter Image API, integration principal, synthetic non-personal fixture. Proves the authenticated route path end to end once; not a deployment, quality or user-value claim.",
  recordedAt: startedAt,
  candidate: { gitSha: candidate.sha, cleanTree: candidate.clean, buildSha: built.sha },
  plan,
  fixture: { path: FIXTURE, sha256: sha256(fixture) },
  request: { status: success?.status ?? null, latencyMs: success?.latencyMs ?? null, error: success?.status === 200 ? null : (() => { try { return JSON.parse(success.text).error; } catch { return "unparseable"; } })() },
  output,
  telemetry: events,
  checks,
  outcome: Object.values(checks).every(Boolean) ? "pass" : "fail",
};
const serialized = JSON.stringify(evidence, null, 2);
if (serialized.includes(apiKey) || serialized.includes(token)) throw new Error("refusing to write evidence containing a credential");
fs.mkdirSync("docs/evidence/dyai-37", { recursive: true });
const outFile = `docs/evidence/dyai-37/live-route-${plan.commandId}-${startedAt.replace(/[:.]/g, "-")}.json`;
fs.writeFileSync(outFile, `${serialized}\n`);
console.log(serialized);
console.error(`evidence written: ${outFile}`);
process.exit(evidence.outcome === "pass" ? 0 : 1);
