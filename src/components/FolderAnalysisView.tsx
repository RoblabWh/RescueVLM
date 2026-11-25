"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ChatPanel, { MODELS } from "@/components/ChatPanel";
import type { Message, ReasoningEffort } from "@/components/ChatPanel";
import UploadPhotoView from "@/components/UploadPhotoView";
import AnnotationOverlay from "@/components/AnnotationOverlay";
import FolderMap from "@/components/FolderMap";
import type { MapPoint } from "@/components/FolderMap";
import { readSSEStream } from "@/lib/sse";
import { parseFolderResponse } from "@/lib/parse-response";
import type { Annotation, FolderHighlight } from "@/lib/parse-response";
import {
  FOLDER_SYSTEM_PROMPT,
  FOLDER_BLOCK_SYSTEM_PROMPT,
  FOLDER_COMBINE_SYSTEM_PROMPT,
} from "@/lib/prompts";
import { extractGps } from "@/lib/exif-gps";
import type { GpsCoords } from "@/lib/exif-gps";
import { filterImageFiles } from "@/lib/image-files";

const MAX_SIDE = 1024;
/** Larger cap for the single-image drawing board, so annotations stay sharp. */
const MAX_EDIT_SIDE = 2048;
const JPEG_QUALITY = 0.75;
/** Images per VLM request; larger sets are analyzed block-by-block and merged. */
const BLOCK_SIZE = 50;
/** Quick mode analyzes a random sample of images (fits one VLM request). */
const QUICK_LIMIT = 50;

/** Random sample of `count` images (Fisher–Yates), re-sorted by name for display. */
function sampleImages(imgs: File[], count: number): File[] {
  if (imgs.length <= count) return imgs;
  const pool = [...imgs];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool
    .slice(0, count)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const SUGGESTIONS = [
  "Are there any hazards or people at risk in these images? Mark the 5 most important images! Do not mark the same event across multiple images!",
  "Which image shows the most critical scenario?",
  "Are there any hazards or people at risk in these images?",
  "Analyze all provided images for hazards and people at risk, giving a one-sentence description of what each image shows along with any specific danger and who is affected. Group images that depict the same event and count each event only once—never mark the same event across multiple images—then rank the 5 most critical images (each a distinct event, or fewer if there aren't 5). Finally, name the single most critical image with a brief justification based on immediacy of harm, number of people affected, and urgency.",
];

interface FolderImage {
  name: string;
  dataUrl: string;
  /** Original file, kept for the drawing board (higher-res re-encode). */
  file: File;
  /** GPS position from EXIF, if the image has one. */
  gps?: GpsCoords;
}

/** 0-based highlight resolved against the loaded image list. */
interface Highlight {
  index: number;
  note?: string;
  /** AI annotations drawn on this image (0-1000 coords). */
  annotations?: Annotation[];
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ApiMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

/** Outcome of one block's VLM pass. start/end are 0-based [start, end). */
interface BlockResult {
  blockNo: number;
  start: number;
  end: number;
  summary: string;
  images: FolderHighlight[];
  failed: boolean;
}

/** POST to /api/chat and drain the SSE stream. Returns the full raw text. */
async function streamChat(
  body: {
    messages: ApiMessage[];
    model: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
  },
  onDelta?: (fullText: string) => void
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  let fullText = "";
  await readSSEStream(res, (delta) => {
    fullText += delta;
    onDelta?.(fullText);
  });
  return fullText;
}

/** First-turn message for one block, labeling images with GLOBAL 1-based indices. */
function buildBlockUserMessage(
  imgs: FolderImage[],
  start: number,
  end: number,
  blockNo: number,
  blockCount: number,
  folderName: string,
  question: string
): ApiMessage {
  const parts: ContentPart[] = [
    {
      type: "text",
      text: `You are given images ${start + 1}–${end} of ${imgs.length}${folderName ? ` from the folder "${folderName}"` : ""} (block ${blockNo} of ${blockCount}). Each image is preceded by its global label.`,
    },
  ];
  for (let i = start; i < end; i++) {
    const img = imgs[i];
    const gpsSuffix = img.gps
      ? ` (GPS: ${img.gps.lat.toFixed(6)}, ${img.gps.lon.toFixed(6)})`
      : "";
    parts.push({ type: "text", text: `Image ${i + 1}: ${img.name}${gpsSuffix}` });
    parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  parts.push({ type: "text", text: `QUESTION: ${question}` });
  return { role: "user", content: parts };
}

/** Text-only combiner input: the question plus every block's findings. */
function buildCombineUserMessage(
  question: string,
  blocks: BlockResult[],
  imgs: FolderImage[]
): ApiMessage {
  const lines: string[] = [
    `QUESTION: ${question}`,
    "",
    `The ${imgs.length} images were analyzed in ${blocks.length} blocks. Findings:`,
  ];
  for (const b of blocks) {
    lines.push("", `BLOCK ${b.blockNo} (Images ${b.start + 1}–${b.end}):`);
    if (b.failed) {
      lines.push("ANALYSIS FAILED — no findings available for these images.");
      continue;
    }
    lines.push(`Summary: ${b.summary}`);
    if (b.images.length === 0) {
      lines.push("Relevant images: none");
      continue;
    }
    lines.push("Relevant images:");
    for (const h of b.images) {
      const img = imgs[h.index - 1];
      const gps = img?.gps
        ? ` (GPS: ${img.gps.lat.toFixed(6)}, ${img.gps.lon.toFixed(6)})`
        : "";
      lines.push(`- Image ${h.index}: ${img?.name ?? "?"}${gps}${h.note ? ` — ${h.note}` : ""}`);
    }
  }
  return { role: "user", content: lines.join("\n") };
}

/** Decode an image file and downscale it to a JPEG data URL for the API. */
async function fileToDownscaledDataUrl(file: File, maxSide: number = MAX_SIDE): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Props {
  files: File[];
  onBack: () => void;
}

export default function FolderAnalysisView({ files, onBack }: Props) {
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // images
  const [images, setImages] = useState<FolderImage[]>([]);
  const [loadingImages, setLoadingImages] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadTotal, setLoadTotal] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  /** How many images the picked folder holds in total (before any limit). */
  const [totalAvailable, setTotalAvailable] = useState(0);
  const [useFullDataset, setUseFullDataset] = useState(false);
  const [folderName, setFolderName] = useState<string>("");
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [mapHeight, setMapHeight] = useState(288); // px; matches the old h-72
  const [mapCollapsed, setMapCollapsed] = useState(false);

  // Drag the handle above the map to resize its height (grow upward as the
  // pointer moves up). Clamped so it never eats the whole grid.
  const startMapResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = mapHeight;
    const onMove = (ev: MouseEvent) => {
      const next = startH + (startY - ev.clientY);
      setMapHeight(Math.max(140, Math.min(next, window.innerHeight - 200)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [mapHeight]);

  // drawing board (single-image editor)
  const [editorImage, setEditorImage] = useState<string | null>(null);
  const [editorAnnotations, setEditorAnnotations] = useState<Annotation[]>([]);
  const [editorLoading, setEditorLoading] = useState(false);

  // results
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  // chat
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(MODELS[0].id);
  const [reasoning, setReasoning] = useState<ReasoningEffort>("medium");

  // Full OpenAI-format history (images attached to the first user turn only;
  // in batched mode the history is text-only: combiner input + answer).
  const historyRef = useRef<ApiMessage[]>([]);
  /** Whether the batched (block + combiner) path ran for this conversation. */
  const batchedRef = useRef(false);
  /** 0-based global image index → annotations carried over from block results. */
  const blockAnnotationsRef = useRef<Map<number, Annotation[]>>(new Map());
  const imagesRef = useRef<FolderImage[]>([]);
  imagesRef.current = images;
  const highlightsRef = useRef<Highlight[]>([]);
  highlightsRef.current = highlights;
  /** All image files of the current folder, so the limit can be changed later. */
  const allFilesRef = useRef<File[]>([]);
  const useFullDatasetRef = useRef(useFullDataset);
  useFullDatasetRef.current = useFullDataset;

  const loadFiles = useCallback(async (fileList: File[], full: boolean) => {
    const imgs = filterImageFiles(fileList);
    allFilesRef.current = imgs;
    setTotalAvailable(imgs.length);
    const chosen = full ? imgs : sampleImages(imgs, QUICK_LIMIT);
    setSkippedCount(imgs.length - chosen.length);
    setFolderName(
      (chosen[0] as File & { webkitRelativePath?: string })?.webkitRelativePath?.split("/")[0] ?? ""
    );
    setLoadingImages(true);
    setLoadTotal(chosen.length);
    setLoadProgress(0);
    setImages([]);
    setMessages([]);
    setHighlights([]);
    setPreviewIdx(null);
    historyRef.current = [];
    batchedRef.current = false;
    blockAnnotationsRef.current = new Map();

    const results: FolderImage[] = [];
    for (const f of chosen) {
      try {
        const [dataUrl, gps] = await Promise.all([
          fileToDownscaledDataUrl(f),
          extractGps(f),
        ]);
        results.push({ name: f.name, dataUrl, file: f, gps: gps ?? undefined });
      } catch {
        // unreadable file — skip it
      }
      setLoadProgress(results.length);
    }
    setImages(results);
    setLoadingImages(false);
  }, []);

  useEffect(() => {
    loadFiles(files, useFullDatasetRef.current);
  }, [files, loadFiles]);

  const handleNewFolder = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = filterImageFiles(e.target.files ?? []);
      e.target.value = "";
      if (picked.length === 0) {
        alert("No images found in that folder.");
        return;
      }
      loadFiles(picked, useFullDatasetRef.current);
    },
    [loadFiles]
  );

  /** Switch between the first-50 subset and the full dataset (reloads images). */
  const chooseDatasetSize = useCallback(
    (full: boolean) => {
      if (full === useFullDatasetRef.current) return;
      setUseFullDataset(full);
      loadFiles(allFilesRef.current, full);
    },
    [loadFiles]
  );

  // ── chat / AI ─────────────────────────────────────────────────────────────
  const sendText = useCallback(
    async (text: string) => {
      const imgs = imagesRef.current;
      if (!text || loading || imgs.length === 0) return;
      setInput("");
      setLoading(true);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: "" },
      ]);
      const startedAt = performance.now();

      const setAssistant = (content: string, durationMs?: number) => {
        setMessages((prev) => {
          const upd = [...prev];
          upd[upd.length - 1] =
            durationMs === undefined
              ? { role: "assistant", content }
              : { role: "assistant", content, durationMs };
          return upd;
        });
      };
      // In batched mode the combiner returns no annotations — re-attach the
      // ones the block passes produced (no-op in single mode, map is empty).
      const toHighlight = (h: FolderHighlight): Highlight => ({
        index: h.index - 1,
        note: h.note,
        annotations: h.annotations ?? blockAnnotationsRef.current.get(h.index - 1),
      });

      try {
        if (historyRef.current.length === 0 && imgs.length > BLOCK_SIZE) {
          // ── batched first turn: one fresh context per block, then combine ──
          const blockCount = Math.ceil(imgs.length / BLOCK_SIZE);
          const status: string[] = [
            `Analyzing ${imgs.length} images in ${blockCount} blocks of up to ${BLOCK_SIZE}…`,
          ];
          blockAnnotationsRef.current = new Map();
          const blocks: BlockResult[] = [];

          for (let b = 0; b < blockCount; b++) {
            const start = b * BLOCK_SIZE;
            const end = Math.min(start + BLOCK_SIZE, imgs.length);
            const range = `Block ${b + 1}/${blockCount} (Images ${start + 1}–${end})`;
            setAssistant([...status, `▶ ${range}…`].join("\n"));
            const blockMsg = buildBlockUserMessage(imgs, start, end, b + 1, blockCount, folderName, text);
            let result: BlockResult | null = null;
            for (let attempt = 0; attempt < 2 && !result; attempt++) {
              try {
                const raw = await streamChat({
                  messages: [blockMsg],
                  model,
                  systemPrompt: FOLDER_BLOCK_SYSTEM_PROMPT,
                  reasoningEffort: reasoning,
                });
                const parsed = parseFolderResponse(raw);
                // Drop hallucinated indices outside this block's range.
                const inRange = parsed.images.filter((h) => h.index > start && h.index <= end);
                for (const h of inRange) {
                  if (h.annotations?.length) blockAnnotationsRef.current.set(h.index - 1, h.annotations);
                }
                result = { blockNo: b + 1, start, end, summary: parsed.answer, images: inRange, failed: false };
              } catch {
                // retry once; a persistent failure skips the block below
              }
            }
            if (result) {
              status.push(`✓ ${range} — ${result.images.length} relevant image${result.images.length === 1 ? "" : "s"}`);
            } else {
              result = { blockNo: b + 1, start, end, summary: "", images: [], failed: true };
              status.push(`⚠ ${range} failed — skipped`);
            }
            blocks.push(result);
          }

          const okBlocks = blocks.filter((bl) => !bl.failed);
          if (okBlocks.length === 0) throw new Error("All image blocks failed to analyze.");
          const failedCount = blockCount - okBlocks.length;
          const failedNote =
            failedCount > 0
              ? `\n⚠ ${failedCount} of ${blockCount} blocks failed — their images were not analyzed.`
              : "";

          const combineMsg = buildCombineUserMessage(text, blocks, imgs);
          setAssistant([...status, `Combining results from ${okBlocks.length} blocks…`].join("\n"));

          let answer: string;
          let picked: FolderHighlight[];
          let rawCombined: string;
          try {
            rawCombined = await streamChat(
              {
                messages: [combineMsg],
                model,
                systemPrompt: FOLDER_COMBINE_SYSTEM_PROMPT,
                reasoningEffort: reasoning,
              },
              (full) => setAssistant(full)
            );
            const parsed = parseFolderResponse(rawCombined);
            answer = parsed.answer;
            picked = parsed.images;
          } catch {
            // Combiner failed — fall back to the raw block findings.
            answer = okBlocks
              .map((bl) => `Block ${bl.blockNo} (Images ${bl.start + 1}–${bl.end}): ${bl.summary}`)
              .join("\n");
            picked = okBlocks.flatMap((bl) => bl.images);
            rawCombined = answer;
          }
          setAssistant(answer + failedNote, performance.now() - startedAt);
          setHighlights(
            picked.map(toHighlight).filter((h) => h.index >= 0 && h.index < imgs.length)
          );
          // Follow-ups run text-only against the combiner conversation.
          historyRef.current = [combineMsg, { role: "assistant", content: rawCombined }];
          batchedRef.current = true;
          return;
        }

        let apiMessages: ApiMessage[];
        if (historyRef.current.length === 0) {
          // First turn: attach all images, each preceded by its label.
          const parts: ContentPart[] = [
            {
              type: "text",
              text: `You are given ${imgs.length} images${folderName ? ` from the folder "${folderName}"` : ""}. Each image is preceded by its label.`,
            },
          ];
          imgs.forEach((img, i) => {
            const gpsSuffix = img.gps
              ? ` (GPS: ${img.gps.lat.toFixed(6)}, ${img.gps.lon.toFixed(6)})`
              : "";
            parts.push({ type: "text", text: `Image ${i + 1}: ${img.name}${gpsSuffix}` });
            parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
          });
          parts.push({ type: "text", text: `QUESTION: ${text}` });
          apiMessages = [{ role: "user", content: parts }];
        } else {
          apiMessages = [...historyRef.current, { role: "user", content: text }];
        }

        const fullText = await streamChat(
          {
            messages: apiMessages,
            model,
            systemPrompt: batchedRef.current ? FOLDER_COMBINE_SYSTEM_PROMPT : FOLDER_SYSTEM_PROMPT,
            reasoningEffort: reasoning,
          },
          (full) => setAssistant(full)
        );

        const parsed = parseFolderResponse(fullText);
        setAssistant(parsed.answer, performance.now() - startedAt);
        setHighlights(
          parsed.images.map(toHighlight).filter((h) => h.index >= 0 && h.index < imgs.length)
        );
        historyRef.current = [...apiMessages, { role: "assistant", content: fullText }];
      } catch (err) {
        setAssistant(`Error: ${err instanceof Error ? err.message : "Something went wrong"}`);
      } finally {
        setLoading(false);
      }
    },
    [loading, model, reasoning, folderName]
  );

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      await sendText(input.trim());
    },
    [input, sendText]
  );

  // ── drawing board ─────────────────────────────────────────────────────────
  const openEditor = useCallback(async (idx: number) => {
    const img = imagesRef.current[idx];
    if (!img) return;
    setEditorLoading(true);
    try {
      setPreviewIdx(null);
      // Carry the AI's annotations for this image into the editor (0-1000
      // coords are resolution-independent, so they land in the right spots).
      setEditorAnnotations(
        highlightsRef.current.find((h) => h.index === idx)?.annotations ?? []
      );
      setEditorImage(await fileToDownscaledDataUrl(img.file, MAX_EDIT_SIDE));
    } catch {
      alert("Could not open this image in the editor.");
    } finally {
      setEditorLoading(false);
    }
  }, []);

  // ── render ────────────────────────────────────────────────────────────────
  // Drawing board mode: the original single-image annotation view
  if (editorImage) {
    return (
      <UploadPhotoView
        uploadedImage={editorImage}
        onBack={() => setEditorImage(null)}
        onNewImage={(url) => setEditorImage(url)}
        initialAnnotations={editorAnnotations}
      />
    );
  }

  const mapPoints: MapPoint[] = images.flatMap((img, i) => {
    if (!img.gps) return [];
    const rank = highlights.findIndex((h) => h.index === i);
    return [{
      index: i,
      name: img.name,
      lat: img.gps.lat,
      lon: img.gps.lon,
      rank,
      note: rank >= 0 ? highlights[rank].note : undefined,
    }];
  });
  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* ── LEFT: image grid ─────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden border-r border-zinc-800">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
          <span className="text-sm font-medium text-zinc-200">
            {folderName || "Selected images"}
          </span>
          <span className="text-xs text-zinc-500">
            {loadingImages
              ? `Loading ${loadProgress}/${loadTotal}…`
              : `${images.length} image${images.length === 1 ? "" : "s"}`}
            {skippedCount > 0 && ` · random ${QUICK_LIMIT} sampled, ${skippedCount} skipped`}
          </span>

          {totalAvailable > QUICK_LIMIT && (
            <div
              title="Switching reloads the images and clears the conversation"
              className="flex overflow-hidden rounded border border-zinc-700"
            >
              <button
                onClick={() => chooseDatasetSize(false)}
                disabled={loadingImages}
                className={`flex h-8 items-center px-2 text-xs transition-colors disabled:opacity-50 ${
                  !useFullDataset
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {QUICK_LIMIT} images
              </button>
              <button
                onClick={() => chooseDatasetSize(true)}
                disabled={loadingImages}
                className={`flex h-8 items-center px-2 text-xs transition-colors disabled:opacity-50 ${
                  useFullDataset
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                Full dataset ({totalAvailable})
              </button>
            </div>
          )}

          {mapPoints.length > 0 && (
            <button
              onClick={() => setShowMap((v) => !v)}
              title={`${mapPoints.length} of ${images.length} images have GPS metadata`}
              className={`flex h-8 items-center gap-1 rounded px-2 text-xs transition-colors ${
                showMap
                  ? "bg-emerald-900/60 text-emerald-300"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14Z" />
                <circle cx="8" cy="6.5" r="1.5" />
              </svg>
              Map ({mapPoints.length})
            </button>
          )}

          <button
            onClick={() => newFolderInputRef.current?.click()}
            title="Choose a different folder (clears conversation)"
            className="ml-auto flex h-8 items-center gap-1 rounded bg-zinc-700 px-2 text-xs text-zinc-300 hover:bg-zinc-600"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M1.5 4.5 A1 1 0 0 1 2.5 3.5 H6 L7.5 5 H13.5 A1 1 0 0 1 14.5 6 V11.5 A1 1 0 0 1 13.5 12.5 H2.5 A1 1 0 0 1 1.5 11.5 Z" />
            </svg>
            New Folder
          </button>
          <input
            ref={newFolderInputRef}
            type="file"
            multiple
            onChange={handleNewFolder}
            className="hidden"
            {...({ webkitdirectory: "" } as object)}
          />

          <button
            onClick={onBack}
            title="Back to home"
            className="flex h-8 items-center gap-1 rounded bg-zinc-800 px-2 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            ← Back
          </button>
        </div>

        {/* Suggested questions */}
        {!loadingImages && messages.length === 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <span className="text-xs text-zinc-500">Try:</span>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setInput(s)}
                className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Grid */}
        <div className="flex-1 overflow-y-auto bg-zinc-950 p-3">
          {loadingImages ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              Loading images… {loadProgress}/{loadTotal}
            </div>
          ) : images.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              No readable images in this folder.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {images.map((img, i) => {
                const rank = highlights.findIndex((h) => h.index === i);
                const h = rank >= 0 ? highlights[rank] : null;
                const isTop = rank === 0;
                return (
                  <div
                    key={i}
                    onClick={() => setPreviewIdx(i)}
                    title={img.name}
                    className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-zinc-900 text-left transition-colors ${
                      h
                        ? isTop
                          ? "border-amber-400 ring-2 ring-amber-400/70"
                          : "border-sky-400 ring-2 ring-sky-400/50"
                        : "border-zinc-800 hover:border-zinc-600"
                    }`}
                  >
                    {h?.annotations?.length ? (
                      // Annotated: show the full (uncropped) image so the
                      // 0-1000 annotation coordinates line up exactly.
                      <AnnotationOverlay
                        screenshot={img.dataUrl}
                        annotations={h.annotations}
                        className="relative block w-full"
                        imgClassName="block w-full"
                        alt={img.name}
                      />
                    ) : (
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        className="aspect-video w-full object-cover"
                      />
                    )}
                    {h && (
                      <span
                        className={`absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                          isTop ? "bg-amber-400 text-black" : "bg-sky-400 text-black"
                        }`}
                      >
                        {rank + 1}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); openEditor(i); }}
                      disabled={editorLoading}
                      title="Open in drawing board (draw rects, arrows … and ask about this image)"
                      className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded bg-zinc-900/80 text-zinc-300 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-white group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                        <path d="M12 20h9" />
                        <path d="m16.5 3.5 4 4L7 21l-4 1 1-4Z" />
                      </svg>
                    </button>
                    <div className="p-1.5">
                      <div className="flex items-center gap-1 truncate text-xs text-zinc-400">
                        <span className="truncate">Image {i + 1} · {img.name}</span>
                        {img.gps && (
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3 flex-shrink-0 text-emerald-400" aria-label="Has GPS position">
                            <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14Z" />
                            <circle cx="8" cy="6.5" r="1.5" />
                          </svg>
                        )}
                      </div>
                      {h?.note && (
                        <div className={`mt-0.5 text-xs ${isTop ? "text-amber-300" : "text-sky-300"}`}>
                          {h.note}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Map of geotagged images — drag the handle to resize, chevron to collapse */}
        {showMap && mapPoints.length > 0 && !loadingImages && (
          <div className="flex-shrink-0 border-t border-zinc-800">
            <div className="flex items-center bg-zinc-900/80">
              {mapCollapsed ? (
                <div className="flex flex-1 items-center gap-1.5 px-3 py-1 text-xs text-zinc-400">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14Z" />
                    <circle cx="8" cy="6.5" r="1.5" />
                  </svg>
                  Map ({mapPoints.length})
                </div>
              ) : (
                <div
                  onMouseDown={startMapResize}
                  title="Drag to resize"
                  className="group flex flex-1 cursor-ns-resize items-center justify-center py-1.5"
                >
                  <div className="h-1 w-10 rounded-full bg-zinc-600 transition-colors group-hover:bg-zinc-400" />
                </div>
              )}
              <button
                onClick={() => setMapCollapsed((v) => !v)}
                title={mapCollapsed ? "Show map" : "Hide map"}
                className="mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`h-3.5 w-3.5 transition-transform ${mapCollapsed ? "" : "rotate-180"}`}
                >
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </button>
            </div>
            {!mapCollapsed && (
              <div style={{ height: mapHeight }}>
                <FolderMap points={mapPoints} onSelect={setPreviewIdx} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── RIGHT: chat panel ────────────────────────────────────────────── */}
      <div className="w-96 flex-shrink-0">
        <ChatPanel
          messages={messages}
          input={input}
          loading={loading || loadingImages}
          model={model}
          reasoning={reasoning}
          onInputChange={setInput}
          onSubmit={handleSend}
          onModelChange={setModel}
          onReasoningChange={setReasoning}
          uploadMode
          placeholder="Ask about these images..."
          emptyHint={'Ask one question across all images — e.g. "Which image shows the most critical scenario?" The relevant images get highlighted in the grid.'}
        />
      </div>

      {/* Lightbox */}
      {previewIdx !== null && images[previewIdx] && (
        <div
          className="fixed inset-0 z-[2000] flex flex-col items-center justify-center gap-2 bg-black/85 p-6"
          onClick={() => setPreviewIdx(null)}
        >
          <AnnotationOverlay
            screenshot={images[previewIdx].dataUrl}
            annotations={highlights.find((h) => h.index === previewIdx)?.annotations ?? []}
            className="relative inline-block max-w-full"
            imgClassName="block max-h-[85vh] max-w-full rounded"
            alt={images[previewIdx].name}
          />
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400">
              Image {previewIdx + 1} · {images[previewIdx].name}
              {images[previewIdx].gps &&
                ` · ${images[previewIdx].gps.lat.toFixed(5)}, ${images[previewIdx].gps.lon.toFixed(5)}`}
              {" — click to close"}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); openEditor(previewIdx); }}
              disabled={editorLoading}
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <path d="M12 20h9" />
                <path d="m16.5 3.5 4 4L7 21l-4 1 1-4Z" />
              </svg>
              {editorLoading ? "Opening…" : "Open drawing board"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
