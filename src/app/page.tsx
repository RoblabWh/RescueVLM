"use client";

import { useState, useRef, useCallback } from "react";
import UploadPhotoView from "@/components/UploadPhotoView";
import FolderAnalysisView from "@/components/FolderAnalysisView";
import { filterImageFiles } from "@/lib/image-files";

export default function Home() {
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>(undefined);
  const [folderFiles, setFolderFiles] = useState<File[] | null>(null);
  const [frameskip, setFrameskip] = useState(30);
  const [extractingVideo, setExtractingVideo] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setInitialPrompt("");
        setUploadedImage(reader.result as string);
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    },
    []
  );

  const handleFolderUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const imgs = filterImageFiles(e.target.files ?? []);
      e.target.value = "";
      if (imgs.length === 0) {
        alert("No images found in that folder.");
        return;
      }
      setFolderFiles(imgs);
    },
    []
  );

  const handleVideoUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setExtractingVideo(true);
      try {
        const form = new FormData();
        form.append("video", file);
        form.append("frameskip", String(frameskip));
        const res = await fetch("/api/extract-frames", { method: "POST", body: form });
        if (!res.ok) throw new Error((await res.text()) || res.statusText);
        const { frames } = (await res.json()) as {
          frames: { name: string; dataUrl: string }[];
        };
        if (!frames || frames.length === 0) {
          alert("No frames could be extracted from that video.");
          return;
        }
        // Turn the extracted frames into image Files and reuse the folder view.
        const imgFiles = await Promise.all(
          frames.map(async (f) => {
            const blob = await (await fetch(f.dataUrl)).blob();
            return new File([blob], f.name, { type: "image/jpeg" });
          })
        );
        setFolderFiles(imgFiles);
      } catch (err) {
        alert(
          `Frame extraction failed: ${err instanceof Error ? err.message : "unknown error"}`
        );
      } finally {
        setExtractingVideo(false);
      }
    },
    [frameskip]
  );

  // ── render ──────────────────────────────────────────────────────────────────

  if (folderFiles) {
    return (
      <FolderAnalysisView files={folderFiles} onBack={() => setFolderFiles(null)} />
    );
  }

  if (uploadedImage) {
    return (
      <UploadPhotoView
        uploadedImage={uploadedImage}
        onBack={() => { setUploadedImage(null); setInitialPrompt(undefined); }}
        onNewImage={(url) => { setUploadedImage(url); setInitialPrompt(undefined); }}
        initialPrompt={initialPrompt}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-200">
      <div className="flex w-full flex-1 flex-col">

        <div className="flex flex-1">
          <div className="flex w-1/3 flex-col items-center pt-2">
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600/10">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 text-emerald-400">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold">Upload Photo</h2>
              <p className="max-w-xs text-center text-sm text-zinc-300">
                Upload an image and ask AI questions about it
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg bg-emerald-600 px-6 py-3 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Choose Image
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileUpload}
                className="hidden"
              />

            </div>
          </div>
          <div className="flex w-1/3 flex-col items-center border-l border-zinc-800 pt-2">
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-600/10">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 text-violet-400">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  <circle cx="10" cy="13" r="1.5" />
                  <path d="m21 17-4-4-7 7" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold">Analyze Folder</h2>
              <p className="max-w-xs text-center text-sm text-zinc-300">
                Select a folder of images and ask one question across all of them
              </p>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="rounded-lg bg-violet-600 px-6 py-3 text-sm font-medium text-white hover:bg-violet-700"
              >
                Choose Folder
              </button>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                onChange={handleFolderUpload}
                className="hidden"
                {...({ webkitdirectory: "" } as object)}
              />
              <p className="max-w-xs text-center text-xs text-zinc-500">
                e.g. &ldquo;Which image shows the most critical scenario?&rdquo;
              </p>
            </div>
          </div>
          <div className="flex w-1/3 flex-col items-center border-l border-zinc-800 pt-2">
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-600/10">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 text-rose-400">
                  <rect x="2" y="4" width="14" height="16" rx="2" />
                  <path d="m22 8-6 4 6 4V8Z" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold">Upload Video</h2>
              <p className="max-w-xs text-center text-sm text-zinc-300">
                Extract frames from a video with ffmpeg and analyze them together
              </p>
              <div className="flex items-center gap-2 text-sm text-zinc-300">
                <label htmlFor="frameskip">Keep 1 of every</label>
                <input
                  id="frameskip"
                  type="number"
                  min={1}
                  max={1000}
                  value={frameskip}
                  onChange={(e) =>
                    setFrameskip(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))
                  }
                  className="w-16 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-center text-zinc-100"
                />
                <span>frames</span>
              </div>
              <button
                onClick={() => videoInputRef.current?.click()}
                disabled={extractingVideo}
                className="rounded-lg bg-rose-600 px-6 py-3 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {extractingVideo ? "Extracting frames…" : "Choose Video"}
              </button>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                onChange={handleVideoUpload}
                className="hidden"
              />
              <p className="max-w-xs text-center text-xs text-zinc-500">
                Higher frameskip = fewer frames. Default 30 ≈ 1 frame/sec for 30 fps video.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
