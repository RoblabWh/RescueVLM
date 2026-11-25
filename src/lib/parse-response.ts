export interface Annotation {
  type: "circle" | "rect" | "text" | "arrow" | "number" | "path" | "polygon";
  color?: string;
  strokeWidth?: number;
  fill?: string;
  // circle
  cx?: number;
  cy?: number;
  r?: number;
  // rect
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // text
  content?: string;
  fontSize?: number;
  // arrow
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  // number
  value?: number;
  // path
  d?: string;
  // polygon: array of [x, y] pairs in 0-1000 space
  points?: number[][];
}

export interface ParsedResponse {
  answer: string;
  annotations: Annotation[];
}

/**
 * Robustly parse the model's JSON response, handling markdown fences,
 * preamble text, and nested JSON.
 */
export function parseModelResponse(raw: string): ParsedResponse {
  if (!raw) return { answer: "", annotations: [] };

  // Strategy 1: Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      const data = JSON.parse(fenceMatch[1]);
      if (data.answer !== undefined || data.annotations !== undefined) {
        return {
          answer: data.answer ?? "",
          annotations: data.annotations ?? [],
        };
      }
    } catch {
      // try next strategy
    }
  }

  // Strategy 2: Find outermost JSON object via brace matching
  const start = raw.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try {
              const data = JSON.parse(raw.slice(start, i + 1));
              if (data.answer !== undefined || data.annotations !== undefined) {
                return {
                  answer: data.answer ?? "",
                  annotations: data.annotations ?? [],
                };
              }
            } catch {
              // fall through
            }
            break;
          }
        }
      }
    }
  }

  // Strategy 3: Try entire string as JSON
  try {
    const data = JSON.parse(raw.trim());
    return {
      answer: data.answer ?? raw,
      annotations: data.annotations ?? [],
    };
  } catch {
    // not JSON at all
  }

  // Fallback: treat entire response as plain text
  return { answer: raw, annotations: [] };
}

// ─── folder mode ──────────────────────────────────────────────────────────────

export interface FolderHighlight {
  /** 1-based image number as used in the "Image N: filename" labels. */
  index: number;
  note?: string;
  /** SVG annotations drawn on that image (0-1000 coords relative to the image). */
  annotations?: Annotation[];
}

export interface ParsedFolderResponse {
  answer: string;
  images: FolderHighlight[];
}

/**
 * Extract the first parseable JSON object from a raw model response,
 * handling markdown fences and preamble text. Returns null if none found.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      const data = JSON.parse(fenceMatch[1]);
      if (data && typeof data === "object") return data;
    } catch {
      // try next strategy
    }
  }

  const start = raw.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try {
              const data = JSON.parse(raw.slice(start, i + 1));
              if (data && typeof data === "object") return data;
            } catch {
              // fall through
            }
            break;
          }
        }
      }
    }
  }

  try {
    const data = JSON.parse(raw.trim());
    if (data && typeof data === "object") return data;
  } catch {
    // not JSON at all
  }
  return null;
}

/**
 * Parse a folder-mode response: { "answer": string, "images": [{index, note}] }.
 * Tolerates images given as plain numbers or with an "image" key instead of "index".
 */
export function parseFolderResponse(raw: string): ParsedFolderResponse {
  if (!raw) return { answer: "", images: [] };
  const data = extractJsonObject(raw);
  if (!data) return { answer: raw, images: [] };

  // Block-mode responses use "summary" instead of "answer".
  const answer =
    typeof data.answer === "string" ? data.answer :
    typeof data.summary === "string" ? data.summary : raw;
  const rawImages = Array.isArray(data.images) ? data.images : [];
  const images: FolderHighlight[] = [];
  for (const entry of rawImages) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      images.push({ index: entry });
    } else if (entry && typeof entry === "object") {
      const o = entry as Record<string, unknown>;
      const idx =
        typeof o.index === "number" ? o.index :
        typeof o.image === "number" ? o.image : null;
      if (idx !== null && Number.isFinite(idx)) {
        const annotations = Array.isArray(o.annotations)
          ? (o.annotations.filter(
              (a) => a && typeof a === "object" && typeof (a as Annotation).type === "string"
            ) as Annotation[])
          : undefined;
        images.push({
          index: idx,
          note: typeof o.note === "string" ? o.note : undefined,
          annotations: annotations && annotations.length > 0 ? annotations : undefined,
        });
      }
    }
  }
  return { answer, images };
}

/**
 * Extract complete annotation objects from a partial JSON stream.
 * Locates the "annotations" array and uses brace-depth tracking
 * (respecting strings) to find each complete {...} object.
 */
export function extractStreamingAnnotations(partialText: string): Annotation[] {
  // Find the "annotations" key followed by an opening bracket
  const keyMatch = partialText.match(/"annotations"\s*:\s*\[/);
  if (!keyMatch || keyMatch.index === undefined) return [];

  const arrayStart = keyMatch.index + keyMatch[0].length;
  const annotations: Annotation[] = [];

  let i = arrayStart;
  while (i < partialText.length) {
    // Skip whitespace and commas between objects
    while (i < partialText.length && /[\s,]/.test(partialText[i])) i++;
    if (i >= partialText.length || partialText[i] !== "{") break;

    // Track brace depth to find the end of this object
    const objStart = i;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (; i < partialText.length; i++) {
      const ch = partialText[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            i++; // move past closing brace
            try {
              const obj = JSON.parse(partialText.slice(objStart, i));
              if (obj.type) annotations.push(obj as Annotation);
            } catch {
              // incomplete or malformed — skip
            }
            break;
          }
        }
      }
    }

    // If we never closed the object, stop scanning
    if (depth !== 0) break;
  }

  return annotations;
}
