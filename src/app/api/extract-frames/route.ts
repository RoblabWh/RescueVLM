import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import path from "path";

// ffmpeg spawns a real process — needs the Node.js runtime, not edge.
export const runtime = "nodejs";
// Frame extraction can take a while for longer clips.
export const maxDuration = 120;

const execFileAsync = promisify(execFile);

/** Hard cap on frames returned, regardless of frameskip — keeps the payload
 *  (and the downstream folder analysis) bounded. FolderAnalysisView uses at
 *  most 50 images, so 60 leaves a little headroom. */
const MAX_FRAMES = 50;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new NextResponse("Invalid multipart body", { status: 400 });
  }

  const video = form.get("video");
  if (!(video instanceof File)) {
    return new NextResponse("No video file provided", { status: 400 });
  }

  // frameskip = keep 1 of every N frames. Clamp to a sane range.
  const rawSkip = Number(form.get("frameskip"));
  const frameskip = Number.isFinite(rawSkip)
    ? Math.max(1, Math.min(1000, Math.round(rawSkip)))
    : 30;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rescuevlm-frames-"));
  const ext = path.extname(video.name) || ".mp4";
  const inputPath = path.join(tmpDir, `input${ext}`);
  const outputPattern = path.join(tmpDir, "frame_%04d.jpg");

  try {
    const bytes = Buffer.from(await video.arrayBuffer());
    await fs.writeFile(inputPath, bytes);

    // Keep every Nth frame. `\,` escapes the comma so ffmpeg's filtergraph
    // parser doesn't read it as a filter separator. -fps_mode vfr stops ffmpeg
    // from duplicating frames back up to the source rate.
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-i", inputPath,
        "-vf", `select=not(mod(n\\,${frameskip}))`,
        "-fps_mode", "vfr",
        "-frames:v", String(MAX_FRAMES),
        "-q:v", "3",
        outputPattern,
      ],
      { timeout: 110_000, maxBuffer: 10 * 1024 * 1024 }
    );

    const files = (await fs.readdir(tmpDir))
      .filter((f) => /^frame_\d+\.jpg$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const frames = await Promise.all(
      files.map(async (name) => {
        const buf = await fs.readFile(path.join(tmpDir, name));
        return { name, dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}` };
      })
    );

    return NextResponse.json({ frames, frameskip });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Frame extraction failed";
    return new NextResponse(message, { status: 500 });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
