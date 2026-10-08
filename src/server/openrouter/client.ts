import { requireServerEnv } from "@/server/config/env";

export interface ImageReference {
  type: "image_url";
  image_url: { url: string };
}

export interface ImageGenerationInput {
  model: string;
  prompt: string;
  inputReferences?: ImageReference[];
}

export async function generateImage(input: ImageGenerationInput) {
  const apiKey = requireServerEnv("OPENROUTER_API_KEY");
  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      input_references: input.inputReferences,
    }),
    signal: AbortSignal.timeout(120_000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Image provider request failed with status ${response.status}`);
  }

  return response.json();
}
