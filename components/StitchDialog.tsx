"use client";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { orderNodes } from "@/lib/batchPlan";

interface Result { url: string; duration: number; clips: number; warnings: string[] }

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export default function StitchDialog({ scope, onClose }: { scope: Node<NodeData>[]; onClose: () => void }) {
  const allNodes = useWorkflowStore((s) => s.nodes) as Node<NodeData>[];
  const insertFlow = useWorkflowStore((s) => s.insertFlow);
  const addToast = useWorkflowStore((s) => s.addToast);

  const videos = useMemo(
    () => orderNodes(scope.filter((n) => n.type === "videoGeneratorNode" && n.data.videoUrl)),
    [scope],
  );
  const voices = useMemo(
    () => orderNodes(allNodes.filter((n) => n.type === "voiceNode" && n.data.audioUrl)),
    [allNodes],
  );
  const missing = scope.filter((n) => n.type === "videoGeneratorNode" && !n.data.videoUrl).length;

  const [included, setIncluded] = useState<Set<string>>(() => new Set(videos.map((v) => v.id)));
  const [voiceId, setVoiceId] = useState<string>(voices[0]?.id ?? "");
  const [clipAudio, setClipAudio] = useState<"keep" | "mute">("mute");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const chosen = videos.filter((v) => included.has(v.id));
  const voice = voices.find((v) => v.id === voiceId);
  const totalSeconds = chosen.reduce((a, v) => a + (Number(v.data.duration) || 0), 0);

  const stitch = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const { data } = await createClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in first.");
      const res = await fetch("/api/stitch", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          clips: chosen.map((v) => v.data.videoUrl as string),
          audioUrl: voice?.data.audioUrl,
          clipAudio: voice ? clipAudio : "keep",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Stitching failed");
      setResult(json as Result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addToCanvas = () => {
    if (!result) return;
    const maxX = Math.max(0, ...chosen.map((n) => n.position.x + ((n.measured?.width ?? 300) as number)));
    const minY = Math.min(...chosen.map((n) => n.position.y));
    insertFlow([{
      id: `videoInputNode-${uid()}`,
      type: "videoInputNode",
      position: { x: maxX + 200, y: Number.isFinite(minY) ? minY : 0 },
      style: { width: 260 },
      data: { label: "FINAL VIDEO", status: "idle", videoUrl: result.url },
    }], []);
    addToast("Final video added to the canvas.", "success");
  };

  const downloadHref = result
    ? `/api/download?url=${encodeURIComponent(result.url)}&filename=${encodeURIComponent("final-video.mp4")}`
    : "";

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60" onClick={() => !busy && onClose()}>
      <div
        className="w-[520px] max-w-[92vw] max-h-[85vh] flex flex-col rounded-2xl border border-white/10 bg-[#121212] text-sm text-gray-200 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b border-white/10">
          <div className="text-base font-semibold">Stitch video</div>
          <div className="text-xs text-white/50 mt-0.5">
            Joins the clips in order into one MP4. Order follows the node names (VID 01, VID 02 …).
          </div>
        </div>

        <div className="px-5 py-3 space-y-3 overflow-y-auto">
          {videos.length === 0 && <div className="text-xs text-amber-300">No finished videos in {scope.length === allNodes.length ? "this canvas" : "the selection"} yet.</div>}
          {missing > 0 && <div className="text-xs text-white/50">{missing} video node{missing === 1 ? " has" : "s have"} no result yet and {missing === 1 ? "is" : "are"} left out.</div>}

          <div className="space-y-1">
            {videos.map((v, i) => (
              <label key={v.id} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={included.has(v.id)}
                  disabled={busy}
                  onChange={(e) => {
                    const next = new Set(included);
                    if (e.target.checked) next.add(v.id); else next.delete(v.id);
                    setIncluded(next);
                  }}
                />
                <span className="text-white/40 w-5 text-right">{i + 1}.</span>
                <span className="truncate">{String(v.data.label ?? v.id)}</span>
                {v.data.duration ? <span className="ml-auto text-white/40">{String(v.data.duration)}s</span> : null}
              </label>
            ))}
          </div>

          <div className="rounded-lg bg-white/[0.04] p-3 space-y-2">
            <label className="block text-xs text-white/60">
              Voiceover
              <select
                className="mt-1 w-full bg-[#1a1a1a] border border-white/10 rounded-lg px-2 py-1.5 text-xs"
                value={voiceId}
                disabled={busy}
                onChange={(e) => setVoiceId(e.target.value)}
              >
                <option value="">No voiceover</option>
                {voices.map((v) => <option key={v.id} value={v.id}>{String(v.data.label ?? v.id)}</option>)}
              </select>
            </label>
            {voices.length === 0 && <div className="text-[11px] text-white/40">Generate a Voice node first to add a voiceover.</div>}
            {voice && (
              <div className="flex gap-3 text-xs text-white/60">
                <label className="flex items-center gap-1.5"><input type="radio" checked={clipAudio === "mute"} onChange={() => setClipAudio("mute")} disabled={busy} /> Voiceover only</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={clipAudio === "keep"} onChange={() => setClipAudio("keep")} disabled={busy} /> Keep clip sound quietly underneath</label>
              </div>
            )}
          </div>

          {error && <div className="text-xs text-red-400 break-words">{error}</div>}

          {result && (
            <div className="space-y-2">
              <video src={result.url} controls className="w-full max-h-[40vh] rounded-lg bg-black" />
              <div className="text-xs text-white/50">{result.clips} clips · {result.duration.toFixed(1)}s</div>
              {result.warnings.map((w) => <div key={w} className="text-xs text-amber-300">{w}</div>)}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex items-center justify-end gap-2">
          {!result && <span className="mr-auto text-[11px] text-white/40">{chosen.length} clips{totalSeconds ? ` · about ${totalSeconds}s` : ""} · no generation credits used</span>}
          <button className="px-3 py-1.5 rounded-lg text-white/60 hover:text-white disabled:opacity-40" disabled={busy} onClick={onClose}>Close</button>
          {result ? (
            <>
              <button className="px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12]" onClick={addToCanvas}>Add to canvas</button>
              <a className="px-4 py-1.5 rounded-lg font-semibold bg-violet-500/30 text-violet-100 border border-violet-400/40 hover:bg-violet-500/40" href={downloadHref}>
                Download MP4
              </a>
            </>
          ) : (
            <button
              disabled={busy || chosen.length === 0}
              onClick={stitch}
              className="px-4 py-1.5 rounded-lg font-semibold bg-violet-500/30 text-violet-100 border border-violet-400/40 hover:bg-violet-500/40 disabled:opacity-40"
            >
              {busy ? "Stitching… this can take a minute" : `Stitch ${chosen.length} clips`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
