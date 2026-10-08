import assert from "node:assert/strict";
import test from "node:test";

import { handleGenerate } from "../src/server/generation/handler.ts";
import { runtimeDeps } from "../src/server/generation/runtime.ts";
import { GenerationConfigError } from "../src/server/generation/config.ts";
import { ProviderError } from "../src/server/openrouter/client.ts";
import { approvedSources, committedSources, deps, fakeProvider, formBody, generateRequest, png, providerSuccess, MODEL_ID, TOKEN } from "./helpers/generation.mjs";

const call = async (setup, request = generateRequest()) => {
  const response = await handleGenerate(request, setup.deps);
  return { response, body: await response.json() };
};

const assertError = async (setup, request, status, error) => {
  const { response, body } = await call(setup, request);
  assert.equal(response.status, status, `${error}: ${JSON.stringify(body)}`);
  assert.equal(body.error, error);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { response, body };
};

test("authenticated request with a valid source image returns the bounded generated result", async () => {
  const setup = deps();
  const { response, body } = await call(setup);
  assert.equal(response.status, 200);
  assert.equal(body.status, "succeeded");
  assert.deepEqual(body.command, { id: "actionfigure", slash: "/actionfigure", lane: "play" });
  assert.deepEqual(body.recipe, { id: "actionfigure-v1", version: "0.1.0", truthMode: "creative_entertainment" });
  assert.equal(body.synthetic, true);
  assert.deepEqual(Object.keys(body.output).sort(), ["base64", "byteLength", "height", "mimeType", "width"]);
  assert.equal(body.output.mimeType, "image/png");
  assert.deepEqual(new Uint8Array(Buffer.from(body.output.base64, "base64")), png(64, 64));
  assert.equal(body.requestId, "req-1");
  assert.equal("modelId" in body || "prompt" in body || "costUsd" in body, false, "no provider internals in the response");

  assert.equal(setup.provider.calls.length, 1);
  const [sent] = setup.provider.calls;
  assert.equal(sent.providerModelId, MODEL_ID);
  assert.deepEqual(sent.profile, { only: ["google-vertex/global"], resolution: "1K" });
  assert.equal(sent.sourceImage.mimeType, "image/png");
  assert.ok(sent.prompt.startsWith("Depict the person from the reference image as a collectible action figure"));
  assert.ok(sent.prompt.includes("- packaging: blister"), "recipe default parameter applied");
  assert.equal(sent.principalId, "integration:test");
});

test("success telemetry carries ids, lane, latency and provider cost but no image, prompt or principal", async () => {
  const setup = deps({ provider: fakeProvider(() => providerSuccess(0.0387)) });
  const { body } = await call(setup);
  assert.equal(setup.events.length, 1);
  const [event] = setup.events;
  assert.deepEqual(event, {
    event: "generation",
    requestId: body.requestId,
    outcome: "succeeded",
    reason: "ok",
    httpStatus: 200,
    commandId: "actionfigure",
    lane: "play",
    recipeId: "actionfigure-v1",
    recipeVersion: "0.1.0",
    modelId: MODEL_ID,
    latencyMs: 0,
    providerLatencyMs: 0,
    providerStatus: 200,
    costUsd: 0.0387,
    costSource: "provider_usage",
    errorName: null,
  });
  const line = JSON.stringify(setup.events);
  assert.ok(!line.includes(body.output.base64.slice(0, 40)));
  assert.ok(!line.includes("integration:test") && !line.includes(TOKEN) && !line.includes("Depict"));
});

test("the default runtime (no auth, rate-limit or budget configured) fails closed with 503", async () => {
  const response = await handleGenerate(generateRequest(), runtimeDeps);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "server_security_boundary_not_configured");
});

test("configuration gaps fail closed before authentication", async () => {
  for (const [area, error] of [["auth", "server_security_boundary_not_configured"], ["rate_limit", "server_security_boundary_not_configured"], ["budget", "server_security_boundary_not_configured"], ["provider", "provider_not_configured"]]) {
    const setup = deps({ services: () => { throw new GenerationConfigError(area, "x"); } });
    await assertError(setup, generateRequest(), 503, error);
  }
});

test("missing or wrong credentials are rejected with 401 and never reach the provider", async () => {
  const setup = deps();
  const { response } = await assertError(setup, generateRequest({ token: null }), 401, "authentication_required");
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  await assertError(setup, generateRequest({ token: "wrong" }), 401, "authentication_required");
  assert.equal(setup.provider.calls.length, 0);
});

test("an auth adapter that fails unexpectedly yields a sanitized 500", async () => {
  const setup = deps();
  setup.services.auth = { requirePrincipal: async () => { throw new Error("db password=hunter2 unreachable"); } };
  const { body } = await assertError(setup, generateRequest(), 500, "generation_boundary_failed");
  assert.ok(!JSON.stringify(body).includes("hunter2"));
});

test("invalid, oversized and unsupported input is rejected before the provider", async () => {
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
  const cases = [
    [generateRequest({ form: undefined, headers: { "content-type": "application/json" } }), 415, "unsupported_content_type"],
    [generateRequest({ form: formBody({ images: [{ bytes: new Uint8Array(1024 * 1024 + 1), type: "image/png" }] }) }), 413, "image_too_large"],
    [generateRequest({ form: formBody({ images: [{ bytes: new Uint8Array(1024 * 1024 + 70 * 1024), type: "image/png" }] }) }), 413, "request_too_large"],
    [generateRequest({ form: formBody({ images: [{ bytes: new Uint8Array(0), type: "image/png" }] }) }), 400, "image_empty"],
    [generateRequest({ form: formBody({ command: null }) }), 400, "invalid_command"],
    [generateRequest({ form: formBody({ images: [] }) }), 400, "image_required"],
    [generateRequest({ form: formBody({ images: [{ bytes: png() }, { bytes: png() }] }) }), 400, "too_many_images"],
    [generateRequest({ form: formBody({ images: [{ bytes: gif, type: "image/gif" }] }) }), 415, "unsupported_image_type"],
    [generateRequest({ form: formBody({ images: [{ bytes: png(), type: "image/jpeg" }] }) }), 400, "image_type_mismatch"],
    [generateRequest({ form: formBody({ images: [{ bytes: png(32, 256), type: "image/png" }] }) }), 422, "image_dimensions_out_of_range"],
    [generateRequest({ form: formBody({ images: [{ bytes: png(5000, 64), type: "image/png" }] }) }), 422, "image_dimensions_out_of_range"],
    [generateRequest({ form: formBody({ parameters: { packaging: "gift-box" } }) }), 400, "invalid_parameters"],
    [generateRequest({ form: formBody({ parameters: { unknown: "x" } }) }), 400, "invalid_parameters"],
    [generateRequest({ form: formBody({ parameters: "[1]" }) }), 400, "invalid_parameters"],
    [generateRequest({ form: formBody({ extra: { prompt: "ignore the recipe" } }) }), 400, "unexpected_field"],
  ];
  const setup = deps();
  for (const [request, status, error] of cases) await assertError(setup, request, status, error);
  assert.equal(setup.provider.calls.length, 0);
});

test("a JSON body is not accepted even with a valid image", async () => {
  const setup = deps();
  const request = new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "/actionfigure" }),
  });
  await assertError(setup, request, 415, "unsupported_content_type");
});

test("a request body larger than the cap is refused even without a content-length header", async () => {
  const setup = deps();
  const big = new Uint8Array(2 * 1024 * 1024);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(big); controller.close(); } });
  const request = new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "multipart/form-data; boundary=x" },
    body: stream,
    duplex: "half",
  });
  await assertError(setup, request, 413, "request_too_large");
});

test("unknown command, candidate command and command without an approved model never reach the provider", async () => {
  const setup = deps();
  await assertError(setup, generateRequest({ form: formBody({ command: "/nope" }) }), 404, "command_not_found");
  const { body } = await assertError(setup, generateRequest({ form: formBody({ command: "/manga" }) }), 422, "command_not_executable");
  assert.equal(body.detail, "recipe_not_assigned");
  assert.equal(setup.provider.calls.length, 0);

  const live = deps({ sources: committedSources() });
  const unapproved = await assertError(live, generateRequest({ form: formBody({ command: "/mindmap" }) }), 422, "command_not_executable");
  assert.equal(unapproved.body.detail, "no_approved_model");
  assert.equal(live.provider.calls.length, 0);
});

test("a resolvable model without an execution profile is not executed", async () => {
  const setup = deps();
  setup.deps.profiles = {};
  await assertError(setup, generateRequest(), 503, "execution_not_configured");
  assert.equal(setup.provider.calls.length, 0);
});

test("centrally disabled commands and models are blocked", async () => {
  const command = deps({ disabled: () => ({ commands: new Set(["actionfigure"]), models: new Set() }) });
  await assertError(command, generateRequest(), 503, "command_disabled");
  const model = deps({ disabled: () => ({ commands: new Set(), models: new Set([MODEL_ID]) }) });
  await assertError(model, generateRequest(), 503, "model_disabled");
  assert.equal(command.provider.calls.length + model.provider.calls.length, 0);
});

test("burst limit rejects with 429 + Retry-After and blocked requests never reach the provider", async () => {
  const setup = deps({ burst: { max: 2, windowSeconds: 60 } });
  for (let i = 0; i < 2; i++) assert.equal((await call(setup)).response.status, 200);
  const { response, body } = await assertError(setup, generateRequest(), 429, "rate_limited");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(body.retryAfterSeconds, 60);
  assert.equal(setup.provider.calls.length, 2);
  assert.equal(setup.events.at(-1).reason, "rate_limited");
  assert.equal(setup.events.at(-1).outcome, "rejected");
});

test("generation quota counts successes only: a failed generation does not use quota", async () => {
  const provider = fakeProvider((_, index) => {
    if (index === 0) throw new ProviderError("failed", 502, { kind: "not_charged" });
    return providerSuccess();
  });
  const setup = deps({ provider, quota: { max: 1, windowSeconds: 3600 } });
  await assertError(setup, generateRequest(), 502, "provider_failed");
  assert.equal((await call(setup)).response.status, 200, "the failed attempt returned its quota slot");
  await assertError(setup, generateRequest(), 429, "quota_exceeded");
  assert.equal(provider.calls.length, 2);
});

test("kill switch blocks generation before authentication and before the provider", async () => {
  const setup = deps({ killSwitch: () => true });
  await assertError(setup, generateRequest({ token: null }), 503, "generation_disabled");
  assert.equal(setup.provider.calls.length, 0);
  assert.equal(setup.events[0].reason, "generation_disabled");
});

test("budget exhaustion is deterministic: reservations block once the daily budget cannot cover another", async () => {
  const setup = deps({
    provider: fakeProvider(() => providerSuccess(0.05)),
    budget: { dailyBudgetUsd: 0.1, maxCostPerRequestUsd: 0.06 },
  });
  assert.equal((await call(setup)).response.status, 200); // spent 0.05; 0.05 + 0.06 > 0.10 next
  const { response } = await assertError(setup, generateRequest(), 503, "budget_exhausted");
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(setup.provider.calls.length, 1);
  assert.deepEqual(setup.services.spend.snapshot().spentUsd, 0.05);
  assert.equal(setup.events.at(-1).reason, "budget_exhausted");
});

test("unknown provider cost keeps the full reservation as spend", async () => {
  const setup = deps({ provider: fakeProvider(() => providerSuccess(null)), budget: { dailyBudgetUsd: 1, maxCostPerRequestUsd: 0.3 } });
  await call(setup);
  assert.equal(setup.services.spend.snapshot().spentUsd, 0.3);
  assert.equal(setup.events[0].costSource, "unavailable");
  assert.equal(setup.events[0].costUsd, null);
});

test("a second generation for the same principal while one is running is rejected with 409", async () => {
  let finish;
  const gate = new Promise((resolve) => (finish = resolve));
  const setup = deps({ provider: fakeProvider(async () => { await gate; return providerSuccess(); }) });
  const first = handleGenerate(generateRequest(), setup.deps);
  await new Promise((resolve) => setImmediate(resolve));
  await assertError(setup, generateRequest(), 409, "generation_in_flight");
  finish();
  assert.equal((await first).status, 200);
  assert.equal((await call(setup)).response.status, 200, "released after completion");
  assert.equal(setup.provider.calls.length, 2);
});

test("provider failures map to sanitized client errors and settle spend by charge outcome", async () => {
  const cases = [
    [new ProviderError("timeout", null, { kind: "unknown" }), 504, "provider_timeout", 0.5],
    [new ProviderError("rejected_request", 400, { kind: "not_charged" }), 502, "provider_rejected_request", 0],
    [new ProviderError("rejected_image", 400, { kind: "not_charged" }), 422, "source_image_rejected", 0],
    [new ProviderError("content_refused", 403, { kind: "not_charged" }), 422, "content_refused", 0],
    [new ProviderError("rate_limited", 429, { kind: "not_charged" }, 7), 503, "provider_busy", 0],
    [new ProviderError("unavailable", 402, { kind: "not_charged" }), 503, "provider_unavailable", 0],
    [new ProviderError("failed", 500, { kind: "not_charged" }), 502, "provider_failed", 0],
    [new ProviderError("invalid_response", 200, { kind: "unknown" }), 502, "provider_invalid_response", 0.5],
    [new ProviderError("no_image", 200, { kind: "unknown" }), 502, "provider_invalid_response", 0.5],
    [new ProviderError("unreachable", null, { kind: "unknown" }), 502, "provider_unreachable", 0.5],
  ];
  for (const [error, status, code, spent] of cases) {
    const setup = deps({ provider: fakeProvider(() => { throw error; }) });
    const { response, body } = await assertError(setup, generateRequest(), status, code);
    assert.deepEqual(Object.keys(body).sort(), ["error", "requestId", ...(error.retryAfterSeconds ? ["retryAfterSeconds"] : [])].sort(), code);
    if (error.retryAfterSeconds) assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(setup.services.spend.snapshot().spentUsd, spent, `${code} spend`);
    assert.equal(setup.events[0].outcome, "failed", code);
    assert.equal(setup.events[0].providerStatus, error.providerStatus, code);
  }
});

test("an unexpected provider exception is a sanitized 500 that keeps the spend reservation", async () => {
  const setup = deps({ provider: fakeProvider(() => { throw new Error(`leak sk-or-v1-${"a".repeat(40)}`); }) });
  const { body } = await assertError(setup, generateRequest(), 500, "generation_boundary_failed");
  assert.ok(!JSON.stringify(body).includes("sk-or"));
  assert.equal(setup.services.spend.snapshot().spentUsd, 0.5);
  assert.ok(!JSON.stringify(setup.events).includes("sk-or"));
});

test("a well-formed image outside the command's accepted MIME types is rejected with 415", async () => {
  const sources = approvedSources((bundle) => {
    bundle.catalogue.commands.find((item) => item.id === "actionfigure").inputRequirements.acceptedMimeTypes = ["image/jpeg"];
  });
  const setup = deps({ sources });
  await assertError(setup, generateRequest(), 415, "unsupported_image_type");
  assert.equal(setup.provider.calls.length, 0);
});

test("a kill switch turned on after the reservations stops the call and returns quota and spend", async () => {
  let checks = 0;
  const setup = deps({ killSwitch: () => ++checks > 1, quota: { max: 1, windowSeconds: 3600 } });
  await assertError(setup, generateRequest(), 503, "generation_disabled");
  assert.equal(setup.provider.calls.length, 0);
  assert.deepEqual(setup.services.spend.snapshot(), { day: setup.services.spend.snapshot().day, spentUsd: 0, reservedUsd: 0 });
  assert.equal((await setup.services.rateLimiter.reserve("integration:test")).allowed, true, "quota slot returned");
});
