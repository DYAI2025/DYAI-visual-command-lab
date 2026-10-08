import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { createMemoryRateLimiter } from "../src/server/rate-limit/memory.ts";
import { createMemorySpendGuard } from "../src/server/budget/memory.ts";
import { createInFlightGuard } from "../src/server/generation/in-flight.ts";
import { createIntegrationTokenAuth } from "../src/server/auth/integration-token.ts";
import { readGenerationConfig, readKillSwitch, readDisabled, GenerationConfigError } from "../src/server/generation/config.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clock = (start = 0) => {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
};

const WIDE = { max: 1000, windowSeconds: 3600 };

test("burst limit allows max attempts per principal per sliding window, then reports retry-after", async () => {
  const time = clock(1_000_000);
  const limiter = createMemoryRateLimiter({ burst: { max: 2, windowSeconds: 60 }, quota: WIDE, now: time.now });
  assert.deepEqual(await limiter.consume("a"), { allowed: true });
  time.advance(10_000);
  assert.deepEqual(await limiter.consume("a"), { allowed: true });
  assert.deepEqual(await limiter.consume("a"), { allowed: false, retryAfterSeconds: 50 });
  assert.deepEqual(await limiter.consume("b"), { allowed: true }, "principals are independent");
  time.advance(49_999);
  assert.deepEqual(await limiter.consume("a"), { allowed: false, retryAfterSeconds: 1 });
  time.advance(1);
  assert.deepEqual(await limiter.consume("a"), { allowed: true }, "the oldest attempt left the window");
  assert.deepEqual(await limiter.consume("a"), { allowed: false, retryAfterSeconds: 10 });
});

test("rejected attempts do not extend the burst window", async () => {
  const time = clock();
  const limiter = createMemoryRateLimiter({ burst: { max: 1, windowSeconds: 10 }, quota: WIDE, now: time.now });
  await limiter.consume("a");
  for (let i = 0; i < 5; i++) {
    time.advance(1_000);
    assert.equal((await limiter.consume("a")).allowed, false);
  }
  time.advance(5_000);
  assert.equal((await limiter.consume("a")).allowed, true);
});

test("generation quota counts committed generations only; released ones are returned", async () => {
  const time = clock();
  const limiter = createMemoryRateLimiter({ burst: WIDE, quota: { max: 2, windowSeconds: 100 }, now: time.now });
  const failed = await limiter.reserve("a");
  failed.reservation.release();
  const ok1 = await limiter.reserve("a");
  ok1.reservation.commit();
  time.advance(10_000);
  const ok2 = await limiter.reserve("a");
  ok2.reservation.commit();
  ok2.reservation.release(); // a settled reservation ignores further calls
  const blocked = await limiter.reserve("a");
  assert.deepEqual(blocked, { allowed: false, retryAfterSeconds: 90 }, "two committed, the failed one did not count");
  time.advance(90_000);
  assert.equal((await limiter.reserve("a")).allowed, true, "the first committed generation left the window");
});

test("pending quota reservations count, so concurrent requests cannot overshoot the quota", async () => {
  const limiter = createMemoryRateLimiter({ burst: WIDE, quota: { max: 1, windowSeconds: 60 }, now: () => 0 });
  const running = await limiter.reserve("a");
  assert.equal(running.allowed, true);
  assert.deepEqual(await limiter.reserve("a"), { allowed: false, retryAfterSeconds: 1 });
  running.reservation.release();
  assert.equal((await limiter.reserve("a")).allowed, true);
});

test("rate limiter bounds the number of tracked principals", async () => {
  const limiter = createMemoryRateLimiter({ burst: { max: 1, windowSeconds: 60 }, quota: WIDE, now: () => 0, maxTrackedPrincipals: 2 });
  await limiter.consume("a");
  await limiter.consume("b");
  await limiter.consume("c"); // evicts the oldest-tracked principal "a"
  assert.equal(limiter.trackedPrincipals(), 2);
  assert.equal((await limiter.consume("c")).allowed, false);
});

test("spend guard reserves the per-request ceiling and rejects once the daily budget cannot cover it", () => {
  const time = clock(Date.UTC(2026, 9, 6, 12));
  const guard = createMemorySpendGuard({ dailyBudgetUsd: 0.1, maxCostPerRequestUsd: 0.04, now: time.now });
  const first = guard.reserve();
  const second = guard.reserve();
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  const third = guard.reserve();
  assert.equal(third.allowed, false, "0.04 + 0.04 reserved, another 0.04 would exceed 0.10");
  assert.equal(third.reason, "budget_exhausted");
  assert.equal(third.retryAfterSeconds, 12 * 3600, "until the next UTC day");

  guard.settle(first.reservation, { kind: "cost", usd: 0.01 });
  assert.equal(guard.snapshot().spentUsd, 0.01);
  assert.equal(guard.reserve().allowed, true, "actual cost below the reservation frees budget");
});

test("spend guard keeps the reservation when cost is unknown and releases it when nothing was charged", () => {
  const guard = createMemorySpendGuard({ dailyBudgetUsd: 1, maxCostPerRequestUsd: 0.25, now: () => Date.UTC(2026, 9, 6) });
  const a = guard.reserve();
  const b = guard.reserve();
  guard.settle(a.reservation, { kind: "unknown" });
  guard.settle(b.reservation, { kind: "not_charged" });
  assert.deepEqual(guard.snapshot(), { day: "2026-10-06", spentUsd: 0.25, reservedUsd: 0 });
  guard.settle(a.reservation, { kind: "cost", usd: 5 });
  assert.equal(guard.snapshot().spentUsd, 0.25, "a reservation settles once");
});

test("spend guard records actual cost above the reservation and starts a fresh ledger each UTC day", () => {
  const time = clock(Date.UTC(2026, 9, 6, 23, 59));
  const guard = createMemorySpendGuard({ dailyBudgetUsd: 0.1, maxCostPerRequestUsd: 0.05, now: time.now });
  const r = guard.reserve();
  guard.settle(r.reservation, { kind: "cost", usd: 0.2 });
  assert.equal(guard.reserve().allowed, false);
  time.advance(60_000);
  assert.equal(guard.reserve().allowed, true);
  assert.equal(guard.snapshot().day, "2026-10-07");
});

test("in-flight guard admits one generation per key until released", () => {
  const guard = createInFlightGuard();
  const release = guard.tryAcquire("a");
  assert.equal(typeof release, "function");
  assert.equal(guard.tryAcquire("a"), null);
  assert.equal(typeof guard.tryAcquire("b"), "function");
  release();
  release(); // idempotent
  assert.equal(typeof guard.tryAcquire("a"), "function");
});

test("integration-token auth accepts only the configured bearer token", async () => {
  const auth = createIntegrationTokenAuth({ tokenSha256: sha256("t".repeat(32)), principalId: "integration:qa" });
  const request = (authorization) => new Request("http://local/api/generate", { method: "POST", headers: authorization ? { authorization } : {} });
  assert.deepEqual(await auth.requirePrincipal(request(`Bearer ${"t".repeat(32)}`)), { userId: "integration:qa" });
  for (const header of [undefined, "Bearer", `Bearer ${"t".repeat(31)}`, `Basic ${"t".repeat(32)}`, `Bearer ${"u".repeat(32)}`]) {
    await assert.rejects(auth.requirePrincipal(request(header)), { name: "AuthenticationRequiredError" }, String(header));
  }
});

const FULL_ENV = {
  AUTH_PROVIDER: "integration_token",
  AUTH_INTEGRATION_TOKEN_SHA256: sha256("x".repeat(32)),
  RATE_LIMIT_PROVIDER: "memory",
  RATE_LIMIT_BURST_MAX: "3",
  RATE_LIMIT_BURST_WINDOW_SECONDS: "60",
  RATE_LIMIT_QUOTA_MAX: "5",
  RATE_LIMIT_QUOTA_WINDOW_SECONDS: "86400",
  GENERATION_DAILY_BUDGET_USD: "1",
  GENERATION_MAX_COST_PER_REQUEST_USD: "0.2",
  OPENROUTER_API_KEY: "sk-test",
};

test("generation config reads a complete environment", () => {
  const config = readGenerationConfig(FULL_ENV);
  assert.equal(config.auth.provider, "integration_token");
  assert.equal(config.auth.principalId, "integration");
  assert.deepEqual(config.rateLimit, {
    provider: "memory",
    burst: { max: 3, windowSeconds: 60 },
    quota: { max: 5, windowSeconds: 86400 },
  });
  assert.deepEqual(config.budget, { dailyBudgetUsd: 1, maxCostPerRequestUsd: 0.2 });
  assert.equal(config.provider.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.provider.timeoutMs, 120_000);
  assert.equal(config.provider.appUrl, null);
  assert.deepEqual(config.limits, { maxUploadBytes: 8 * 1024 * 1024, minImageEdgePx: 64, maxImageEdgePx: 4096, maxOutputBytes: 20 * 1024 * 1024 });
});

test("generation config fails closed on every missing or malformed required value", () => {
  const cases = [
    [{ AUTH_PROVIDER: undefined }, "auth"],
    [{ AUTH_PROVIDER: "unconfigured" }, "auth"],
    [{ AUTH_PROVIDER: "magic" }, "auth"],
    [{ AUTH_INTEGRATION_TOKEN_SHA256: "abc" }, "auth"],
    [{ AUTH_INTEGRATION_PRINCIPAL: "has space" }, "auth"],
    [{ RATE_LIMIT_PROVIDER: undefined }, "rate_limit"],
    [{ RATE_LIMIT_PROVIDER: "redis" }, "rate_limit"],
    [{ RATE_LIMIT_BURST_MAX: undefined }, "rate_limit"],
    [{ RATE_LIMIT_BURST_MAX: "0" }, "rate_limit"],
    [{ RATE_LIMIT_BURST_WINDOW_SECONDS: "1.5" }, "rate_limit"],
    [{ RATE_LIMIT_QUOTA_MAX: undefined }, "rate_limit"],
    [{ RATE_LIMIT_QUOTA_WINDOW_SECONDS: "" }, "rate_limit"],
    [{ GENERATION_DAILY_BUDGET_USD: undefined }, "budget"],
    [{ GENERATION_DAILY_BUDGET_USD: "-1" }, "budget"],
    [{ GENERATION_MAX_COST_PER_REQUEST_USD: undefined }, "budget"],
    [{ GENERATION_MAX_COST_PER_REQUEST_USD: "abc" }, "budget"],
    [{ GENERATION_MAX_COST_PER_REQUEST_USD: "2" }, "budget"],
    [{ OPENROUTER_API_KEY: undefined }, "provider"],
    [{ OPENROUTER_API_KEY: "" }, "provider"],
    [{ OPENROUTER_BASE_URL: "http://example.com/api/v1" }, "provider"],
    [{ OPENROUTER_TIMEOUT_MS: "999999" }, "provider"],
    [{ GENERATION_MAX_UPLOAD_BYTES: "0" }, "limits"],
    [{ GENERATION_MAX_IMAGE_EDGE_PX: "32" }, "limits"],
  ];
  for (const [patch, area] of cases) {
    const env = { ...FULL_ENV, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete env[key];
    assert.throws(() => readGenerationConfig(env), (error) => error instanceof GenerationConfigError && error.area === area, JSON.stringify(patch));
  }
});

test("a loopback http base URL is allowed for local provider stubs", () => {
  for (const host of ["127.0.0.1:4010", "localhost:4010", "[::1]:4010"]) {
    assert.equal(readGenerationConfig({ ...FULL_ENV, OPENROUTER_BASE_URL: `http://${host}/api/v1/` }).provider.baseUrl, `http://${host}/api/v1`);
  }
});

test("config errors never carry configured secret values", () => {
  assert.throws(
    () => readGenerationConfig({ ...FULL_ENV, OPENROUTER_TIMEOUT_MS: "sk-or-v1-secretish" }),
    (error) => error instanceof GenerationConfigError && error.area === "provider" && !String(error.message).includes("secretish"),
  );
});

test("central stop lists parse comma-separated command and model ids", () => {
  const disabled = readDisabled({ GENERATION_DISABLED_COMMANDS: " actionfigure, 35mm ,", GENERATION_DISABLED_MODELS: "google/gemini-3.1-flash-image" });
  assert.deepEqual([...disabled.commands], ["actionfigure", "35mm"]);
  assert.deepEqual([...disabled.models], ["google/gemini-3.1-flash-image"]);
  assert.equal(readDisabled({}).commands.size, 0);
});

test("kill switch: off only when unset or explicitly off; anything unrecognised fails closed", () => {
  for (const value of [undefined, "", "off", "OFF", "0", "false"]) assert.equal(readKillSwitch({ GENERATION_KILL_SWITCH: value }), false, String(value));
  for (const value of ["on", "1", "true", "TRUE", "yes", "maybe"]) assert.equal(readKillSwitch({ GENERATION_KILL_SWITCH: value }), true, value);
});
