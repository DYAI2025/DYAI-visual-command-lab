import { createHash } from "node:crypto";

import { matchCommandSlash } from "../../src/domain/contract/contract.ts";
import { commandRepository, recipeRepository } from "../../src/server/catalogue/index.ts";
import { modelRegistry } from "../../src/server/models/index.ts";
import { createIntegrationTokenAuth } from "../../src/server/auth/integration-token.ts";
import { createMemoryRateLimiter } from "../../src/server/rate-limit/memory.ts";
import { createMemorySpendGuard } from "../../src/server/budget/memory.ts";
import { createInFlightGuard } from "../../src/server/generation/in-flight.ts";
import { encodePng } from "./png.mjs";
import { applyTestApproval, OVERLAY_MODEL_ID } from "../../scripts/lib/approval-overlay.mjs";

export const TOKEN = "integration-test-token-0123456789abcdef";
export const MODEL_ID = OVERLAY_MODEL_ID;
export const PROFILES = { [MODEL_ID]: { only: ["google-vertex/global"], resolution: "1K" } };

// The committed state, read through the same repositories and registry the route uses.
const committedCommands = await commandRepository.listPublicCommands();
const committedRecipes = (
  await Promise.all(committedCommands.filter((c) => c.recipeId !== null).map((c) => recipeRepository.getById(c.recipeId)))
).filter(Boolean);
const committedRegistry = await modelRegistry.load();

/** A mutable deep copy of the committed command, recipe and model documents. */
export function liveBundle() {
  return structuredClone({
    catalogue: { schemaVersion: "1.0.0", commands: [...committedCommands] },
    recipes: { schemaVersion: "1.0.0", recipes: committedRecipes },
    models: committedRegistry,
  });
}

/** In-memory repositories and registry over a bundle: what a durable adapter would serve. */
export function sourcesFrom(bundle) {
  const commands = bundle.catalogue.commands;
  return {
    commands: {
      async listPublicCommands() { return commands.filter((c) => c.maturity !== "deprecated"); },
      async getById(id) { return commands.find((c) => c.id === id) ?? null; },
      async findBySlash(slash, options) { return matchCommandSlash(commands, slash, options) ?? null; },
    },
    recipes: { async getById(recipeId) { return bundle.recipes.recipes.find((r) => r.recipeId === recipeId) ?? null; } },
    models: { async load() { return bundle.models; } },
  };
}

/** The route's own sources (committed state, unmodified). */
export const committedSources = () => ({ commands: commandRepository, recipes: recipeRepository, models: modelRegistry });

/**
 * Sources in which /actionfigure is executable on MODEL_ID: allowlisted model, passing fixture test
 * and approved adapter (the shared test-only overlay). The committed documents carry their own evidence.
 */
export function approvedSources(mutate = () => {}) {
  const bundle = liveBundle();
  applyTestApproval(bundle);
  mutate(bundle);
  return sourcesFrom(bundle);
}

export const png = (width = 256, height = 256) => encodePng(width, height, (x, y) => [x % 256, y % 256, 128]);

export function formBody({ command = "/actionfigure", images = [{ bytes: png(), type: "image/png" }], parameters, extra = {} } = {}) {
  const form = new FormData();
  if (command !== null) form.append("command", command);
  for (const image of images) form.append("image", new Blob([image.bytes], { type: image.type ?? "" }), "source");
  if (parameters !== undefined) form.append("parameters", typeof parameters === "string" ? parameters : JSON.stringify(parameters));
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

export function generateRequest({ token = TOKEN, form = formBody(), headers = {} } = {}) {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: form,
  });
}

/** Fake provider that records every call and answers with `respond(input, callIndex)`. */
export function fakeProvider(respond) {
  const calls = [];
  return {
    calls,
    async generate(input) {
      calls.push(input);
      return respond(input, calls.length - 1);
    },
  };
}

export const providerSuccess = (costUsd = 0.04, image = png(64, 64)) => ({
  image: { mimeType: "image/png", width: 64, height: 64, bytes: image },
  costUsd,
  providerStatus: 200,
});

export function deps({
  provider = fakeProvider(() => providerSuccess()),
  sources = approvedSources(),
  burst = { max: 100, windowSeconds: 60 },
  quota = { max: 100, windowSeconds: 3600 },
  budget = { dailyBudgetUsd: 10, maxCostPerRequestUsd: 0.5 },
  limits = { maxUploadBytes: 1024 * 1024, minImageEdgePx: 64, maxImageEdgePx: 4096, maxOutputBytes: 20 * 1024 * 1024 },
  killSwitch = () => false,
  disabled = () => ({ commands: new Set(), models: new Set() }),
  services,
} = {}) {
  const events = [];
  let id = 0;
  const built = services ?? {
    auth: createIntegrationTokenAuth({ tokenSha256: createHash("sha256").update(TOKEN).digest("hex"), principalId: "integration:test" }),
    rateLimiter: createMemoryRateLimiter({ burst, quota }),
    spend: createMemorySpendGuard(budget),
    inFlight: createInFlightGuard(),
    provider,
    limits,
  };
  return {
    events,
    provider,
    services: built,
    deps: {
      killSwitch,
      disabled,
      services: typeof built === "function" ? built : () => built,
      sources,
      profiles: PROFILES,
      telemetry: (event) => events.push(event),
      now: () => 0,
      newRequestId: () => `req-${++id}`,
    },
  };
}
