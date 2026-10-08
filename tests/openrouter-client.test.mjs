import assert from "node:assert/strict";
import test from "node:test";

import { createOpenRouterClient, ProviderError, EXECUTION_PROFILES } from "../src/server/openrouter/client.ts";
import { png } from "./helpers/generation.mjs";

const KEY = `sk-or-v1-${"k".repeat(48)}`;
const SOURCE = png(128, 96);
const OUTPUT = png(64, 64);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

const input = {
  providerModelId: "google/gemini-3.1-flash-image",
  profile: EXECUTION_PROFILES["google/gemini-3.1-flash-image"],
  prompt: "Depict the person as an action figure.",
  sourceImage: { mimeType: "image/png", bytes: SOURCE },
  principalId: "integration:test",
};

function client(respond, options = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return respond(init);
  };
  return { requests, provider: createOpenRouterClient({ apiKey: KEY, baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 5000, maxOutputBytes: 1024 * 1024, fetch, ...options }) };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (extra = {}) => json(200, { created: 1, data: [{ b64_json: b64(OUTPUT), media_type: "image/png" }], usage: { prompt_tokens: 1, completion_tokens: 1290, total_tokens: 1291, cost: 0.0774 }, ...extra });

async function rejects(provider, kind, check = () => {}) {
  await assert.rejects(provider.generate(input), (error) => {
    assert.ok(error instanceof ProviderError, String(error));
    assert.equal(error.kind, kind);
    assert.ok(!error.message.includes(KEY));
    check(error);
    return true;
  });
}

test("sends the documented Image API request: model, prompt, one data-URL reference, n=1, pinned provider, hashed user", async () => {
  const { requests, provider } = client(() => ok(), { appUrl: "https://studio.dyai.cloud" });
  await provider.generate(input);
  assert.equal(requests.length, 1);
  const [{ url, init, body }] = requests;
  assert.equal(url, "https://openrouter.ai/api/v1/images");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers["HTTP-Referer"], "https://studio.dyai.cloud");
  assert.equal(init.headers["X-OpenRouter-Title"], "DYAI Visual Command Lab");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(body).sort(), ["input_references", "model", "n", "prompt", "provider", "resolution", "user"]);
  assert.equal(body.model, "google/gemini-3.1-flash-image");
  assert.equal(body.prompt, input.prompt);
  assert.deepEqual(body.input_references, [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(SOURCE)}` } }]);
  assert.equal(body.n, 1);
  assert.equal(body.resolution, "1K");
  assert.deepEqual(body.provider, { only: ["google-vertex/global"], allow_fallbacks: false });
  assert.match(body.user, /^dyai-[0-9a-f]{32}$/);
  assert.ok(!init.body.includes("integration:test"), "principal id is hashed");
});

test("decodes b64_json into a verified image and reports usage.cost", async () => {
  const { provider } = client(() => ok());
  const result = await provider.generate(input);
  assert.deepEqual(result.image, { mimeType: "image/png", width: 64, height: 64, bytes: OUTPUT });
  assert.equal(result.costUsd, 0.0774);
  assert.equal(result.providerStatus, 200);
});

test("missing or invalid usage.cost reports null cost, not zero", async () => {
  for (const usage of [undefined, {}, { cost: null }, { cost: -1 }, { cost: "0.1" }]) {
    const { provider } = client(() => json(200, { created: 1, data: [{ b64_json: b64(OUTPUT) }], usage }));
    assert.equal((await provider.generate(input)).costUsd, null, JSON.stringify(usage));
  }
});

test("the image type is taken from the bytes, not from media_type", async () => {
  const { provider } = client(() => json(200, { created: 1, data: [{ b64_json: b64(OUTPUT), media_type: "image/jpeg" }] }));
  assert.equal((await provider.generate(input)).image.mimeType, "image/png");
});

test("HTTP errors are classified with charge outcome and Retry-After, never the provider message", async () => {
  const cases = [
    [400, {}, "rejected_request"],
    [400, { metadata: { error_type: "image_too_large" } }, "rejected_image"],
    [400, { metadata: { error_type: "unsupported_image_format" } }, "rejected_image"],
    [401, {}, "unavailable"],
    [402, {}, "unavailable"],
    [403, { metadata: { error_type: "content_policy_violation" } }, "content_refused"],
    [403, { metadata: { error_type: "refusal" } }, "content_refused"],
    [403, {}, "unavailable"],
    [404, {}, "rejected_request"],
    [408, {}, "timeout"],
    [413, {}, "rejected_request"],
    [429, {}, "rate_limited"],
    [500, {}, "failed"],
    [502, {}, "failed"],
    [503, {}, "unavailable"],
    [524, {}, "timeout"],
    [529, {}, "failed"],
  ];
  for (const [status, extra, kind] of cases) {
    const { provider } = client(() => json(status, { error: { code: status, message: `upstream says ${KEY} secret-detail`, ...extra } }, status === 429 ? { "retry-after": "12" } : {}));
    await rejects(provider, kind, (error) => {
      assert.equal(error.providerStatus, status);
      assert.deepEqual(error.charge, { kind: "not_charged" }, "failed generations are not billed (all-or-nothing)");
      assert.ok(!error.message.includes("secret-detail"));
      if (status === 429) assert.equal(error.retryAfterSeconds, 12);
    });
  }
});

test("a 200 whose body is only an error object is a provider failure", async () => {
  const { provider } = client(() => json(200, { error: { code: 502, message: "Provider returned error" } }));
  await rejects(provider, "failed");
});

test("malformed 200 responses are invalid_response with unknown charge", async () => {
  const bodies = [
    "not json",
    JSON.stringify({ created: 1, data: [{ b64_json: "!!!notbase64!!" }] }),
    JSON.stringify({ created: 1, data: [{ b64_json: b64(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), media_type: "image/svg+xml" }] }),
    JSON.stringify({ created: 1, data: [{ b64_json: 42 }] }),
  ];
  for (const body of bodies) {
    const { provider } = client(() => new Response(body, { status: 200 }));
    await rejects(provider, "invalid_response", (error) => assert.deepEqual(error.charge, { kind: "unknown" }));
  }
  for (const body of [{ created: 1, data: [] }, { created: 1 }]) {
    const { provider } = client(() => json(200, body));
    await rejects(provider, "no_image");
  }
});

test("responses above the output cap are refused without buffering them", async () => {
  const big = new Uint8Array(2 * 1024 * 1024);
  const { provider } = client(() => json(200, { created: 1, data: [{ b64_json: b64(big) }] }), { maxOutputBytes: 1024 * 1024 });
  await rejects(provider, "invalid_response");
});

test("timeout aborts the request and keeps the charge unknown", async () => {
  const fetch = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const provider = createOpenRouterClient({ apiKey: KEY, baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 1000, maxOutputBytes: 1024, fetch });
  const started = Date.now();
  await rejects(provider, "timeout", (error) => assert.deepEqual(error.charge, { kind: "unknown" }));
  assert.ok(Date.now() - started >= 900);
});

test("network failure is unreachable and does not leak the error text", async () => {
  const { provider } = client(() => { throw new TypeError(`fetch failed for ${KEY}`); });
  await rejects(provider, "unreachable");
});

test("only the Vertex endpoint is profiled for execution", () => {
  assert.deepEqual(Object.keys(EXECUTION_PROFILES), ["google/gemini-3.1-flash-image"]);
  assert.deepEqual(EXECUTION_PROFILES["google/gemini-3.1-flash-image"].only, ["google-vertex/global"]);
});

test("a decoded image above maxOutputBytes is refused even when the response fits the byte cap", async () => {
  const justOver = new Uint8Array(1024 * 1024 + 30_000);
  justOver.set(OUTPUT); // a valid PNG header, so only the size check can refuse it
  const { provider } = client(() => json(200, { created: 1, data: [{ b64_json: b64(justOver) }] }), { maxOutputBytes: 1024 * 1024 });
  await rejects(provider, "invalid_response");
});
