// Runtime smoke for POST /api/generate. Starts the production build (`next start`) once per
// environment group and talks to it over real HTTP. The provider is a local stub OpenRouter Image
// API on 127.0.0.1 (OPENROUTER_BASE_URL), so this proves the route/runtime boundary, not the
// external provider (see scripts/qualify-model.mjs for the real OpenRouter call).
//
// Needs `npm run build` first. Exit 0 only if every scenario that ran passed. Scenarios that need an
// executable command run only when the committed repositories and registry resolve one; otherwise they are listed
// as NOT RUN and their requests must fail closed with 422.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";

import { resolvePlan } from "./lib/plan.mjs";
import { encodePng } from "../tests/helpers/png.mjs";
import { startApp } from "./lib/next-app.mjs";

const TOKEN = `smoke-${createHash("sha256").update(String(process.pid)).digest("hex").slice(0, 32)}`;
const KEY_SENTINEL = `sk-or-v1-SMOKE${"0".repeat(50)}`;
const SOURCE = encodePng(256, 256, (x, y) => [x, y, 160]);
const OUTPUT = encodePng(96, 96, (x, y) => [255 - x, y, 40]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

if (!fs.existsSync(".next/BUILD_ID")) {
  console.error("runtime-smoke: no production build (.next/BUILD_ID); run `npm run build` first");
  process.exit(1);
}

let executable = null;
for (const slash of ["/actionfigure", "/mindmap", "/35mm"]) {
  try {
    executable = (await resolvePlan(slash)).plan;
    break;
  } catch {
    // not executable; try the next seed
  }
}

// ---------- stub OpenRouter Image API ----------
const stub = { mode: "ok", calls: 0, lastBody: null };
const stubServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    stub.calls += 1;
    const authorized = req.headers.authorization === `Bearer ${KEY_SENTINEL}`;
    try {
      stub.lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      stub.lastBody = null;
    }
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/api/v1/images" || !authorized) {
      return send(401, { error: { code: 401, message: "stub: unexpected request" } });
    }
    const upstreamLeak = `${KEY_SENTINEL} upstream-detail-SHOULD-NOT-LEAK`;
    switch (stub.mode) {
      case "ok":
        return send(200, { created: 1, data: [{ b64_json: b64(OUTPUT), media_type: "image/png" }], usage: { prompt_tokens: 1, completion_tokens: 1290, total_tokens: 1291, cost: 0.05 } });
      case "500":
        return send(500, { error: { code: 500, message: upstreamLeak } });
      case "400":
        return send(400, { error: { code: 400, message: upstreamLeak, metadata: { error_type: "invalid_prompt" } } });
      case "malformed":
        return send(200, `{"created":1,"data":[{"b64_json":"%%%"}], "detail": "${upstreamLeak}"}`);
      case "slow":
        return setTimeout(() => send(200, { created: 1, data: [] }), 4000);
      default:
        return send(500, { error: { code: 500, message: "stub: unknown mode" } });
    }
  });
});

function form({ command = "/actionfigure", image = SOURCE, type = "image/png", parameters } = {}) {
  const body = new FormData();
  if (command) body.append("command", command);
  if (image) body.append("image", new Blob([image], { type }), "source.png");
  if (parameters) body.append("parameters", JSON.stringify(parameters));
  return body;
}

async function post(app, { token = TOKEN, body = form(), headers = {} } = {}) {
  const response = await fetch(`${app.base}/api/generate`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep raw text for the report
  }
  return { status: response.status, json, text, retryAfter: response.headers.get("retry-after") };
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
}
const notRun = [];

const BASE_ENV = {
  AUTH_PROVIDER: "integration_token",
  AUTH_INTEGRATION_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
  AUTH_INTEGRATION_PRINCIPAL: "integration:smoke",
  RATE_LIMIT_PROVIDER: "memory",
  RATE_LIMIT_BURST_MAX: "50",
  RATE_LIMIT_BURST_WINDOW_SECONDS: "60",
  RATE_LIMIT_QUOTA_MAX: "50",
  RATE_LIMIT_QUOTA_WINDOW_SECONDS: "3600",
  GENERATION_DAILY_BUDGET_USD: "10",
  GENERATION_MAX_COST_PER_REQUEST_USD: "0.06",
  OPENROUTER_API_KEY: KEY_SENTINEL,
};

function leakCheck(group, app, extra = []) {
  const log = app.output.join("");
  const forbidden = [KEY_SENTINEL, TOKEN, "upstream-detail-SHOULD-NOT-LEAK", b64(SOURCE).slice(0, 64), b64(OUTPUT).slice(0, 64), ...extra];
  check(`${group}: server log contains no key, token, provider detail or image base64`, forbidden.every((item) => !log.includes(item)), "");
  const events = log.split("\n").filter((line) => line.startsWith('{"event":"generation"')).map((line) => JSON.parse(line));
  return events;
}

async function group(name, env, run) {
  const app = await startApp(env);
  try {
    await run(app);
  } finally {
    await app.stop();
  }
  return app;
}

await new Promise((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
const STUB_URL = `http://127.0.0.1:${stubServer.address().port}/api/v1`;

try {
  // G0: nothing configured -> fail closed.
  await group("default", {}, async (app) => {
    const response = await post(app);
    check("default runtime: 503 server_security_boundary_not_configured", response.status === 503 && response.json?.error === "server_security_boundary_not_configured", response.text);
    check("default runtime: provider not called", stub.calls === 0, `stub calls ${stub.calls}`);
  });

  // G1: configured boundary, validation and auth paths.
  const g1 = await group("configured", { ...BASE_ENV, OPENROUTER_BASE_URL: STUB_URL }, async (app) => {
    const before = stub.calls;
    const anonymous = await post(app, { token: null });
    check("no credential: 401 authentication_required", anonymous.status === 401 && anonymous.json?.error === "authentication_required", anonymous.text);
    const wrong = await post(app, { token: "wrong-token-value" });
    check("wrong credential: 401", wrong.status === 401, wrong.text);
    const json = await post(app, { body: JSON.stringify({ command: "/actionfigure" }), headers: { "content-type": "application/json" } });
    check("JSON body: 415 unsupported_content_type", json.status === 415 && json.json?.error === "unsupported_content_type", json.text);
    const gif = await post(app, { body: form({ image: Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]), type: "image/gif" }) });
    const gifExpected = executable ? 415 : 422;
    check(`unsupported image: ${gifExpected}`, gif.status === gifExpected, gif.text);
    const big = await post(app, { body: form({ image: new Uint8Array(9 * 1024 * 1024) }) });
    check("oversized upload: 413", big.status === 413, big.text);
    const unknown = await post(app, { body: form({ command: "/does-not-exist" }) });
    check("unknown command: 404 command_not_found", unknown.status === 404 && unknown.json?.error === "command_not_found", unknown.text);
    const candidate = await post(app, { body: form({ command: "/manga" }) });
    check("candidate command: 422 recipe_not_assigned", candidate.status === 422 && candidate.json?.detail === "recipe_not_assigned", candidate.text);
    const unapproved = await post(app, { body: form({ command: "/mindmap" }) });
    const mindmapExecutable = executable?.commandId === "mindmap";
    if (!mindmapExecutable) check("command without approved model: 422 no_approved_model", unapproved.status === 422 && unapproved.json?.detail === "no_approved_model", unapproved.text);
    if (!executable) {
      const seed = await post(app);
      check("no approved execution plan: /actionfigure fails closed 422", seed.status === 422 && seed.json?.detail === "no_approved_model", seed.text);
    }
    check("validation/auth failures: provider not called", stub.calls === before, `stub calls ${stub.calls - before}`);
  });
  leakCheck("configured", g1);

  // G2: burst limit at the HTTP boundary.
  const g2 = await group("burst", { ...BASE_ENV, RATE_LIMIT_BURST_MAX: "3", OPENROUTER_BASE_URL: STUB_URL }, async (app) => {
    const before = stub.calls;
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await post(app, { body: form({ command: "/manga" }) }));
    check("burst limit: attempts 1-3 pass the limiter, 4-5 get 429 rate_limited", statuses.slice(0, 3).every((r) => r.status === 422) && statuses.slice(3).every((r) => r.status === 429 && r.json?.error === "rate_limited"), statuses.map((r) => r.status).join(","));
    check("burst limit: Retry-After header set", Number(statuses[4].retryAfter) > 0, statuses[4].retryAfter);
    check("burst limit: provider not called", stub.calls === before, "");
  });
  const burstEvents = leakCheck("burst", g2);
  check("burst: telemetry records rate_limited rejections", burstEvents.filter((e) => e.reason === "rate_limited" && e.outcome === "rejected").length === 2, JSON.stringify(burstEvents.map((e) => e.reason)));

  // G3: kill switch.
  const g3 = await group("kill-switch", { ...BASE_ENV, GENERATION_KILL_SWITCH: "on", OPENROUTER_BASE_URL: STUB_URL }, async (app) => {
    const before = stub.calls;
    const response = await post(app);
    check("kill switch: 503 generation_disabled", response.status === 503 && response.json?.error === "generation_disabled", response.text);
    check("kill switch: provider not called", stub.calls === before, "");
  });
  check("kill switch: telemetry records generation_disabled", leakCheck("kill-switch", g3).some((e) => e.reason === "generation_disabled"), "");

  const g4env = { ...BASE_ENV, GENERATION_DAILY_BUDGET_USD: "0.1", OPENROUTER_BASE_URL: STUB_URL, OPENROUTER_TIMEOUT_MS: "1500" };
  if (!executable) {
    notRun.push("authenticated success through the route", "budget exhaustion through the route", "provider 5xx/4xx/malformed/timeout through the route", "cost telemetry from provider usage");
  } else {
    const slash = executable.canonicalSlash;
    // G4: success, cost telemetry, then budget exhaustion (0.05 spent + 0.06 reserved > 0.10).
    const g4 = await group("budget", g4env, async (app) => {
      stub.mode = "ok";
      const before = stub.calls;
      const ok = await post(app, { body: form({ command: slash }) });
      const image = ok.json?.output ? Buffer.from(ok.json.output.base64, "base64") : null;
      check(`authenticated ${slash}: 200 succeeded with the provider image`, ok.status === 200 && ok.json?.status === "succeeded" && image?.equals(Buffer.from(OUTPUT)), ok.text.slice(0, 300));
      check("success: synthetic flag and recipe version present", ok.json?.synthetic === true && ok.json?.recipe?.version === executable.recipeVersion, "");
      check("success: provider received one data-URL reference and pinned routing", stub.lastBody?.input_references?.length === 1 && stub.lastBody.input_references[0].image_url.url.startsWith("data:image/png;base64,") && stub.lastBody.provider?.allow_fallbacks === false, JSON.stringify(stub.lastBody?.provider));
      const exhausted = await post(app, { body: form({ command: slash }) });
      check("budget: second request 503 budget_exhausted", exhausted.status === 503 && exhausted.json?.error === "budget_exhausted", exhausted.text);
      check("budget: exhausted request did not reach the provider", stub.calls === before + 1, `stub calls ${stub.calls - before}`);
    });
    const events = leakCheck("budget", g4);
    const success = events.find((e) => e.outcome === "succeeded");
    check("telemetry: success event has command, lane, recipe, model, latency and provider cost", success && success.commandId === executable.commandId && success.lane && success.recipeVersion === executable.recipeVersion && success.modelId === executable.modelId && success.costUsd === 0.05 && success.costSource === "provider_usage" && success.latencyMs >= 0, JSON.stringify(success));
    check("telemetry: budget rejection recorded", events.some((e) => e.reason === "budget_exhausted"), "");

    // G5: provider failure paths, sanitized.
    const g5 = await group("provider-errors", { ...g4env, GENERATION_DAILY_BUDGET_USD: "10" }, async (app) => {
      for (const [mode, status, code] of [["500", 502, "provider_failed"], ["400", 502, "provider_rejected_request"], ["malformed", 502, "provider_invalid_response"], ["slow", 504, "provider_timeout"]]) {
        stub.mode = mode;
        const response = await post(app, { body: form({ command: slash }) });
        check(`provider ${mode}: ${status} ${code}, sanitized`, response.status === status && response.json?.error === code && !response.text.includes("SHOULD-NOT-LEAK") && !response.text.includes(KEY_SENTINEL), response.text);
      }
      stub.mode = "ok";
    });
    leakCheck("provider-errors", g5);
  }
} finally {
  await new Promise((resolve) => stubServer.close(resolve));
}

for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok || !result.detail ? "" : `\n      ${String(result.detail).slice(0, 400)}`}`);
for (const item of notRun) console.log(`NOT RUN  ${item} (no executable command in the committed repositories)`);
const failed = results.filter((result) => !result.ok).length;
console.log(`runtime-smoke: ${results.length - failed}/${results.length} passed, ${failed} failed, ${notRun.length} not run; executable plan: ${executable ? `${executable.canonicalSlash} -> ${executable.modelId}` : "none"}`);
process.exit(failed === 0 ? 0 : 1);
