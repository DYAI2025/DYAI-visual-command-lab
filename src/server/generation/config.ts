// Server-only generation settings, read from the environment. Every required value fails closed:
// a missing or malformed setting throws GenerationConfigError and no generation runs. Error messages
// name the variable, never its value.

export type ConfigArea = "auth" | "rate_limit" | "budget" | "provider" | "limits";

export class GenerationConfigError extends Error {
  readonly area: ConfigArea;

  constructor(area: ConfigArea, message: string) {
    super(message);
    this.name = "GenerationConfigError";
    this.area = area;
  }
}

export interface GenerationConfig {
  auth: { provider: "integration_token"; tokenSha256: string; principalId: string };
  rateLimit: {
    provider: "memory";
    burst: { max: number; windowSeconds: number };
    quota: { max: number; windowSeconds: number };
  };
  budget: { dailyBudgetUsd: number; maxCostPerRequestUsd: number };
  provider: { apiKey: string; baseUrl: string; timeoutMs: number; appUrl: string | null };
  limits: { maxUploadBytes: number; minImageEdgePx: number; maxImageEdgePx: number; maxOutputBytes: number };
}

type Env = Record<string, string | undefined>;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function integer(env: Env, name: string, area: ConfigArea, min: number, max: number, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new GenerationConfigError(area, `${name} is required`);
  }
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new GenerationConfigError(area, `${name} must be an integer from ${min} to ${max}`);
  }
  return Number(raw);
}

function usd(env: Env, name: string): number {
  const raw = env[name];
  if (raw === undefined || raw === "") throw new GenerationConfigError("budget", `${name} is required`);
  if (!/^\d+(\.\d{1,6})?$/.test(raw) || Number(raw) <= 0) {
    throw new GenerationConfigError("budget", `${name} must be a positive USD amount`);
  }
  return Number(raw);
}

function baseUrl(env: Env): string {
  const raw = env.OPENROUTER_BASE_URL;
  if (raw === undefined || raw === "") return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GenerationConfigError("provider", "OPENROUTER_BASE_URL is not a URL");
  }
  // The API key travels to this URL: TLS everywhere except a loopback stub on this machine.
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!allowed || url.username || url.password || url.search || url.hash) {
    throw new GenerationConfigError("provider", "OPENROUTER_BASE_URL must be https (or http on loopback) without credentials or query");
  }
  return url.href.replace(/\/+$/, "");
}

export function readGenerationConfig(env: Env = process.env): GenerationConfig {
  const authProvider = env.AUTH_PROVIDER;
  if (authProvider !== "integration_token") {
    throw new GenerationConfigError("auth", "AUTH_PROVIDER is not configured with a supported adapter");
  }
  const tokenSha256 = env.AUTH_INTEGRATION_TOKEN_SHA256 ?? "";
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) {
    throw new GenerationConfigError("auth", "AUTH_INTEGRATION_TOKEN_SHA256 must be a lowercase hex SHA-256");
  }
  const principalId = env.AUTH_INTEGRATION_PRINCIPAL || "integration";
  if (!/^[a-z0-9:_-]{1,64}$/.test(principalId)) {
    throw new GenerationConfigError("auth", "AUTH_INTEGRATION_PRINCIPAL must match [a-z0-9:_-]{1,64}");
  }

  if (env.RATE_LIMIT_PROVIDER !== "memory") {
    throw new GenerationConfigError("rate_limit", "RATE_LIMIT_PROVIDER is not configured with a supported adapter");
  }
  const maxWindow = 31 * 24 * 3600;
  const rateLimit = {
    provider: "memory" as const,
    burst: {
      max: integer(env, "RATE_LIMIT_BURST_MAX", "rate_limit", 1, 1_000_000),
      windowSeconds: integer(env, "RATE_LIMIT_BURST_WINDOW_SECONDS", "rate_limit", 1, maxWindow),
    },
    quota: {
      max: integer(env, "RATE_LIMIT_QUOTA_MAX", "rate_limit", 1, 1_000_000),
      windowSeconds: integer(env, "RATE_LIMIT_QUOTA_WINDOW_SECONDS", "rate_limit", 1, maxWindow),
    },
  };

  const budget = {
    dailyBudgetUsd: usd(env, "GENERATION_DAILY_BUDGET_USD"),
    maxCostPerRequestUsd: usd(env, "GENERATION_MAX_COST_PER_REQUEST_USD"),
  };
  if (budget.maxCostPerRequestUsd > budget.dailyBudgetUsd) {
    throw new GenerationConfigError("budget", "GENERATION_MAX_COST_PER_REQUEST_USD exceeds GENERATION_DAILY_BUDGET_USD");
  }

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new GenerationConfigError("provider", "OPENROUTER_API_KEY is required");
  const provider = {
    apiKey,
    baseUrl: baseUrl(env),
    timeoutMs: integer(env, "OPENROUTER_TIMEOUT_MS", "provider", 1_000, 300_000, 120_000),
    appUrl: /^https?:\/\/[^\s]{1,200}$/.test(env.NEXT_PUBLIC_APP_URL ?? "") ? (env.NEXT_PUBLIC_APP_URL as string) : null,
  };

  const limits = {
    maxUploadBytes: integer(env, "GENERATION_MAX_UPLOAD_BYTES", "limits", 1, 20 * 1024 * 1024, 8 * 1024 * 1024),
    minImageEdgePx: integer(env, "GENERATION_MIN_IMAGE_EDGE_PX", "limits", 1, 4096, 64),
    maxImageEdgePx: integer(env, "GENERATION_MAX_IMAGE_EDGE_PX", "limits", 64, 8192, 4096),
    maxOutputBytes: integer(env, "GENERATION_MAX_OUTPUT_BYTES", "limits", 1024, 50 * 1024 * 1024, 20 * 1024 * 1024),
  };
  if (limits.minImageEdgePx > limits.maxImageEdgePx) {
    throw new GenerationConfigError("limits", "GENERATION_MIN_IMAGE_EDGE_PX exceeds GENERATION_MAX_IMAGE_EDGE_PX");
  }

  return { auth: { provider: "integration_token", tokenSha256, principalId }, rateLimit, budget, provider, limits };
}

/** Emergency stop. Off only when unset, empty, "off", "0" or "false"; any other value stops generation. */
export function readKillSwitch(env: Env = process.env): boolean {
  const raw = (env.GENERATION_KILL_SWITCH ?? "").trim().toLowerCase();
  return !["", "off", "0", "false"].includes(raw);
}

const list = (raw: string | undefined) =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

/** Central per-command and per-model stop lists (comma-separated command ids / model ids). */
export function readDisabled(env: Env = process.env): { commands: ReadonlySet<string>; models: ReadonlySet<string> } {
  return { commands: list(env.GENERATION_DISABLED_COMMANDS), models: list(env.GENERATION_DISABLED_MODELS) };
}
