import { handleGenerate } from "@/server/generation/handler";
import { runtimeDeps } from "@/server/generation/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleGenerate(request, runtimeDeps);
}
