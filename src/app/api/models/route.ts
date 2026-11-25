import { NextResponse } from "next/server";

interface OllamaTag {
  name: string;
  model?: string;
  details?: { family?: string; families?: string[] };
}

async function fetchTags(url: string, headers?: HeadersInit): Promise<OllamaTag[]> {
  const res = await fetch(url, { cache: "no-store", headers });
  if (!res.ok) return [];
  const data: { models?: OllamaTag[] } = await res.json();
  return data.models || [];
}

// llama-server reports the GGUF path as the model id — show just the file name.
function llamaCppLabel(id: string): string {
  const basename = id.split("/").pop() || id;
  return basename.replace(/\.gguf$/i, "");
}

async function fetchLlamaCppModels(): Promise<
  { id: string; label: string; provider: string }[]
> {
  const base = (process.env.LLAMACPP_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
  const key = process.env.LLAMACPP_API_KEY;
  try {
    const res = await fetch(`${base}/v1/models`, {
      cache: "no-store",
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    });
    if (!res.ok) return [];
    const data: { data?: { id?: string }[] } = await res.json();
    return (data.data || [])
      .filter((m): m is { id: string } => typeof m.id === "string")
      .map((m) => ({
        id: `llamacpp:${m.id}`,
        label: llamaCppLabel(m.id),
        provider: "llamacpp",
      }));
  } catch {
    return [];
  }
}

export async function GET() {
  const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
  let models: {
    id: string;
    label: string;
    provider: string;
    family?: string;
    families?: string[];
  }[] = [];

  const llamaCppPromise = fetchLlamaCppModels();

  try {
    models = (await fetchTags(`${base}/api/tags`)).map((m) => ({
      id: `ollama:${m.name}`,
      label: m.name,
      provider: "ollama",
      family: m.details?.family,
      families: m.details?.families,
    }));
  } catch {
    models = [];
  }

  // Local daemon unreachable — fall back to the Ollama cloud catalog so the
  // configured cloud models are still available.
  const key = process.env.OLLAMA_API_KEY;
  if (models.length === 0 && key) {
    const cloudBase = (process.env.OLLAMA_CLOUD_BASE_URL || "https://ollama.com").replace(
      /\/$/,
      "",
    );
    try {
      models = (
        await fetchTags(`${cloudBase}/api/tags`, { Authorization: `Bearer ${key}` })
      ).map((m) => ({
        id: `ollama-cloud:${m.name}`,
        label: m.name,
        provider: "ollama-cloud",
        family: m.details?.family,
        families: m.details?.families,
      }));
    } catch {
      // keep empty — dropdown falls back to the built-in OpenRouter models
    }
  }

  // llama.cpp runs independently of Ollama — always merge its models in.
  models = [...models, ...(await llamaCppPromise)];

  return NextResponse.json({ models });
}
