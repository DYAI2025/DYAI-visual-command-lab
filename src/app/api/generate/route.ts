import { auth } from "@/server/auth/provider";
import { rateLimiter } from "@/server/rate-limit/provider";

export async function POST(request: Request) {
  try {
    const principal = await auth.requirePrincipal(request);
    const rate = await rateLimiter.consume(principal.userId);

    if (!rate.allowed) {
      return Response.json(
        { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds },
        { status: 429 },
      );
    }

    return Response.json(
      { error: "generation_not_implemented_in_foundation" },
      { status: 501 },
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    if (name === "AuthNotConfiguredError" || name === "RateLimitNotConfiguredError") {
      return Response.json({ error: "server_security_boundary_not_configured" }, { status: 503 });
    }
    return Response.json({ error: "generation_boundary_failed" }, { status: 500 });
  }
}
