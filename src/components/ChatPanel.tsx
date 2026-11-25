"use client";

import { useRef, useEffect, useState } from "react";
import AnnotationOverlay from "./AnnotationOverlay";
import type { Annotation } from "@/lib/parse-response";

const MODELS = [
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3.0 Flash" },
];

export interface Message {
  role: "user" | "assistant";
  content: string;
  screenshot?: string;
  annotations?: Annotation[];
  /** Wall-clock time the AI took to produce this answer, in milliseconds. */
  durationMs?: number;
}

/** Human-readable elapsed time, e.g. "820ms", "2.4s", "1m 05s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export type ReasoningEffort = "low" | "medium" | "high";

interface ChatPanelProps {
  messages: Message[];
  input: string;
  loading: boolean;
  model: string;
  reasoning: ReasoningEffort;
  onInputChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onModelChange: (value: string) => void;
  onReasoningChange: (value: ReasoningEffort) => void;
  /** When true, renders colored <span> tags in assistant messages (color grounding). */
  uploadMode?: boolean;
  /** Override the input placeholder text. */
  placeholder?: string;
  /** Override the empty-state hint shown before the first message. */
  emptyHint?: string;
}

export { MODELS };

/**
 * Parse text that may contain <span style='color:#RRGGBB'>...</span> tags
 * (from AI color grounding) and return React nodes with inline color styles.
 * Only allows color spans — everything else is treated as plain text.
 */
function formatAssistantHTML(text: string): string {
  // Convert **bold** markdown to <strong>
  let html = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Sanitize: strip tags that aren't in our allowlist
  const allowed = ["br", "strong", "b", "em", "i", "ol", "ul", "li", "p", "span", "code", "pre"];
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, name) => {
    return allowed.includes(name.toLowerCase()) ? tag : "";
  });
  return html;
}

const isPro = (model: string) => model.includes("pro");

const isCloudModel = (m: { id: string; label: string; provider?: string }) =>
  m.provider === "ollama-cloud" ||
  m.id.startsWith("ollama-cloud:") ||
  /(?:-|:)cloud(?:$|\b)/i.test(m.label);

export default function ChatPanel({
  messages,
  input,
  loading,
  model,
  reasoning,
  onInputChange,
  onSubmit,
  onModelChange,
  onReasoningChange,
  uploadMode = false,
  placeholder,
  emptyHint,
}: ChatPanelProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [ollamaModels, setOllamaModels] = useState<
    { id: string; label: string; provider?: string }[]
  >([]);
  const ollamaFetchedRef = useRef(false);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const loadOllamaModels = () => {
    if (ollamaFetchedRef.current) return;
    ollamaFetchedRef.current = true;
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((data: { models?: { id: string; label: string; provider?: string }[] }) => {
        setOllamaModels(data.models || []);
      })
      .catch(() => {
        setOllamaModels([]);
      });
  };

  // Populate the Ollama list on mount so it's ready in the dropdown.
  useEffect(() => {
    loadOllamaModels();
  }, []);

  // Default to Ollama: once the model list arrives, prefer the first local
  // model, then the first cloud model. The built-in OpenRouter default only
  // stays selected when no Ollama models are available. Runs once and never
  // overrides a selection the user already made.
  const autoDefaultedRef = useRef(false);
  useEffect(() => {
    if (autoDefaultedRef.current || ollamaModels.length === 0) return;
    autoDefaultedRef.current = true;
    if (model !== MODELS[0].id) return;
    const pick = ollamaModels.find((m) => !isCloudModel(m)) ?? ollamaModels[0];
    onModelChange(pick.id);
  }, [ollamaModels, model, onModelChange]);

  const llamaCppModels = ollamaModels.filter((m) => m.provider === "llamacpp");
  const localOllamaModels = ollamaModels.filter(
    (m) => m.provider !== "llamacpp" && !isCloudModel(m),
  );
  const cloudOllamaModels = ollamaModels.filter(
    (m) => m.provider !== "llamacpp" && isCloudModel(m),
  );

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h1 className="text-sm font-semibold">RescueVLM</h1>
        <div className="flex items-center gap-2">
          {!uploadMode && (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400" />
              Live
            </span>
          )}
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            onMouseDown={loadOllamaModels}
            onFocus={loadOllamaModels}
            className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none"
          >
            <optgroup label="OpenRouter">
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
            {localOllamaModels.length > 0 && (
              <optgroup label="Ollama (local)">
                {localOllamaModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            )}
            {cloudOllamaModels.length > 0 && (
              <optgroup label="Ollama (cloud)">
                {cloudOllamaModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            )}
            {llamaCppModels.length > 0 && (
              <optgroup label="llama.cpp">
                {llamaCppModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {isPro(model) && (
            <select
              value={reasoning}
              onChange={(e) => onReasoningChange(e.target.value as ReasoningEffort)}
              className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none"
              title="Reasoning effort"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-xs text-zinc-500">
              {emptyHint ??
                (uploadMode
                  ? "Ask about the image — annotations will appear live on the left"
                  : "Ask a question")}
            </p>
          </div>
        )}

        {messages.map((m, i, arr) => (
          <div key={i} className="mb-2">
            <div className="mb-0.5 text-xs font-medium text-zinc-500">
              {m.role === "user" ? "You" : "AI"}
            </div>

            {/* Screenshot with annotation overlay (screen-share mode only) */}
            {!uploadMode && m.role === "assistant" && m.screenshot && m.annotations && m.annotations.length > 0 && (
              <div className="mb-1.5">
                <AnnotationOverlay screenshot={m.screenshot} annotations={m.annotations} />
              </div>
            )}

            {!uploadMode && m.role === "user" && m.screenshot && (
              <div className="mb-1.5">
                <img
                  src={m.screenshot}
                  alt="Annotated screenshot"
                  className="max-h-48 w-full rounded border border-zinc-800 object-contain"
                />
              </div>
            )}

            {m.role === "assistant" ? (
              m.content === "" && loading && i === messages.length - 1 ? (
                <div className="rounded-lg px-3 py-2 text-sm bg-zinc-900 text-zinc-300">
                  <span className="text-zinc-500 italic">
                    Thinking{" "}
                    {[0, 200, 400].map((delay) => (
                      <span
                        key={delay}
                        className="inline-block animate-bounce"
                        style={{ animationDelay: `${delay}ms` }}
                      >.</span>
                    ))}
                  </span>
                </div>
              ) : (
                <>
                  <div
                    className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-zinc-900 text-zinc-300"
                    dangerouslySetInnerHTML={{ __html: formatAssistantHTML(m.content) }}
                  />
                  {m.durationMs !== undefined && (
                    <div className="mt-0.5 text-[11px] text-zinc-600">
                      Answered in {formatDuration(m.durationMs)}
                    </div>
                  )}
                </>
              )
            ) : (
              <div className="rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-zinc-800 text-zinc-200">
                {m.content}
              </div>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          disabled={loading}
          placeholder={placeholder ?? (uploadMode ? "Ask about the image..." : "Ask a question...")}
          className="flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 outline-none"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
