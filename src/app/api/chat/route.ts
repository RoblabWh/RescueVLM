import { NextRequest } from "next/server";
import { SYSTEM_PROMPT } from "@/lib/prompts";

export async function POST(req: NextRequest) {
  const { messages, model, systemPrompt, reasoningEffort } = await req.json();
  const PROMPT = typeof systemPrompt === "string" && systemPrompt ? systemPrompt : SYSTEM_PROMPT;
  const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const latestUserText = Array.isArray(latestUserMessage?.content)
    ? latestUserMessage.content
        .filter((part: { type?: string }) => part.type === "text")
        .map((part: { text?: string }) => part.text || "")
        .join("\n")
    : String(latestUserMessage?.content || "");
  console.log("[chat][user]", latestUserText);

  const apiKey = process.env.OPENROUTER_API_KEY;
  const isOllamaPrefixCloud = typeof model === "string" && model.startsWith("ollama-cloud:");
  const isOllamaPrefixLocal =
    typeof model === "string" && model.startsWith("ollama:") && !isOllamaPrefixCloud;
  // Treat any model whose name ends with -cloud as a cloud model, even if the
  // dropdown labeled it with the local "ollama:" prefix (e.g. when local Ollama
  // is signed in and lists cloud-suffixed models alongside real local ones).
  const rawName = isOllamaPrefixCloud
    ? (model as string).slice("ollama-cloud:".length)
    : isOllamaPrefixLocal
      ? (model as string).slice("ollama:".length)
      : "";
  const nameLooksCloud = /(?:-|:)cloud(?:$|\b)/i.test(rawName);
  const isOllamaCloud = isOllamaPrefixCloud || (isOllamaPrefixLocal && nameLooksCloud);
  const isOllamaLocal = isOllamaPrefixLocal && !nameLooksCloud;
  const isOllama = isOllamaLocal || isOllamaCloud;
  const isLlamaCpp = typeof model === "string" && model.startsWith("llamacpp:");

  let url: string;
  let headers: Record<string, string>;
  let bodyModel: string;

  if (isOllamaCloud) {
    const ollamaKey = process.env.OLLAMA_API_KEY;
    if (!ollamaKey) {
      return new Response(
        "OLLAMA_API_KEY is not set — cloud-suffixed Ollama models require an API key from https://ollama.com/settings/keys",
        { status: 500 },
      );
    }
    const base = (process.env.OLLAMA_CLOUD_BASE_URL || "https://ollama.com").replace(/\/$/, "");
    url = `${base}/v1/chat/completions`;
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ollamaKey}`,
    };
    bodyModel = rawName;
  } else if (isOllamaLocal) {
    const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
    url = `${base}/v1/chat/completions`;
    headers = { "Content-Type": "application/json" };
    bodyModel = rawName;
  } else if (isLlamaCpp) {
    const base = (process.env.LLAMACPP_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
    const llamaKey = process.env.LLAMACPP_API_KEY;
    url = `${base}/v1/chat/completions`;
    headers = {
      "Content-Type": "application/json",
      ...(llamaKey && { Authorization: `Bearer ${llamaKey}` }),
    };
    bodyModel = (model as string).slice("llamacpp:".length);
  } else {
    if (!apiKey) {
      return new Response("OPENROUTER_API_KEY is not set", { status: 500 });
    }
    url = "https://openrouter.ai/api/v1/chat/completions";
    headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    bodyModel = model || "google/gemini-3-flash-preview";
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: bodyModel,
      messages: [{ role: "system", content: PROMPT }, ...messages],
      stream: true,
      ...(!isOllama && !isLlamaCpp && model === "google/gemini-3.1-pro-preview" && {
        reasoning: { effort: reasoningEffort ?? "low" },
      }),
    }),
  });

  console.log("[chat][request]", {
    provider: isOllamaCloud
      ? "ollama-cloud"
      : isOllamaLocal
        ? "ollama"
        : isLlamaCpp
          ? "llamacpp"
          : "openrouter",
    model: bodyModel,
    reasoning:
      !isOllama && !isLlamaCpp && model === "google/gemini-3.1-pro-preview"
        ? (reasoningEffort ?? "low")
        : "none",
  });

  if (!response.ok) {
    const errText = await response.text();
    return new Response(errText, { status: response.status });
  }

  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      if (!response.body) {
        controller.close();
        return;
      }

      const reader = response.body.getReader();
      let fullAssistantText = "";
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const event of events) {
            const dataLines = event
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());
            for (const line of dataLines) {
              if (!line || line === "[DONE]") continue;
              try {
                const parsed = JSON.parse(line);
                const delta = parsed?.choices?.[0]?.delta?.content;
                if (typeof delta === "string") {
                  fullAssistantText += delta;
                }
              } catch {
                // ignore parse errors for non-json lines
              }
            }
          }
        }
      } finally {
        if (fullAssistantText) {
          console.log("[chat][assistant]", fullAssistantText);
        }
        controller.close();
      }
    },
  });

  // Stream the response through to the client
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
