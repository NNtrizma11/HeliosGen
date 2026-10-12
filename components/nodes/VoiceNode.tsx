"use client";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import NodeActionBar from "./NodeActionBar";
import MissingInputWarning from "./MissingInputWarning";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { resolveInputs } from "@/lib/executor";
import { useReadOnly } from "@/lib/readOnlyContext";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";
import { browserNotify, requestNotificationPermission } from "@/lib/browserNotify";
import {
  VOICE_MODELS,
  DEFAULT_VOICE_MODEL,
  VOICES,
  DEFAULT_VOICE,
  VOICE_SETTINGS,
  voicePreviewUrl,
} from "@/lib/voiceConfig";

type VoiceNodeType = Node<NodeData, "voiceNode">;

const stop = (e: SyntheticEvent) => e.stopPropagation();

export default function VoiceNode({ id, data, selected }: NodeProps<VoiceNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const addNode = useWorkflowStore((s) => s.addNode);
  const addToast = useWorkflowStore((s) => s.addToast);
  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const edges = useWorkflowStore((s) => s.edges);
  const readOnly = useReadOnly();

  const cardRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const status = (data.status as string | undefined) ?? "idle";
  const busy = status === "pending" || status === "running";
  useGeneratingBorderAnimation(cardRef, busy);

  const voiceModel = (data.voiceModel as string | undefined) ?? DEFAULT_VOICE_MODEL;
  const voice = (data.voice as string | undefined) ?? DEFAULT_VOICE;
  const speed = (data.speed as number | undefined) ?? VOICE_SETTINGS.speed.default;
  const stability = (data.stability as number | undefined) ?? VOICE_SETTINGS.stability.default;
  const similarityBoost = (data.similarityBoost as number | undefined) ?? VOICE_SETTINGS.similarity_boost.default;
  const style = (data.style as number | undefined) ?? VOICE_SETTINGS.style.default;
  const audioUrl = data.audioUrl as string | undefined;
  const cfg = VOICE_MODELS.find((m) => m.id === voiceModel) ?? VOICE_MODELS[0];

  const promptConnected = edges.some((e) => e.target === id && e.targetHandle === "prompt");
  const sourceConnected = edges.some((e) => e.source === id);

  // ── Submit ────────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    requestNotificationPermission();
    const { data: authData } = await createClient().auth.getSession();
    if (!authData.session) { setAuthModalOpen(true); return; }
    const accessToken = authData.session.access_token;

    const { nodes, edges } = useWorkflowStore.getState();
    const text = (resolveInputs(id, nodes as Node<NodeData>[], edges).prompt ?? "").trim();
    if (!text) {
      updateNodeData(id, { hasError: true });
      addToast("Connect a text node with the voiceover script.", "error");
      return;
    }
    if (text.length > cfg.maxChars) {
      addToast(`The script is ${text.length} characters; the limit is ${cfg.maxChars}.`, "error");
      return;
    }

    updateNodeData(id, { status: "running", errorMsg: undefined, taskId: undefined });
    try {
      const res = await fetch("/api/generate-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ model: voiceModel, voice, text, speed, stability, similarityBoost, style }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Voice generation failed");
      updateNodeData(id, { taskId: json.taskId });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      updateNodeData(id, { status: "error", errorMsg: msg });
    }
  }, [id, cfg.maxChars, voiceModel, voice, speed, stability, similarityBoost, style, updateNodeData, addToast, setAuthModalOpen]);

  // ── Poll for the result ───────────────────────────────────────────────────
  useEffect(() => {
    const taskId = data.taskId as string | undefined;
    if (!taskId || status !== "running") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/job-status?taskId=${taskId}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.status === "done") {
          updateNodeData(id, { status: "done", audioUrl: json.audioUrl, taskId: undefined });
          browserNotify("Voice ready", (data.label as string | undefined) ?? "Voiceover generated");
        } else if (json.status === "error" || json.status === "not_found") {
          const msg = json.error ?? "Job expired or unknown";
          updateNodeData(id, { status: "error", errorMsg: msg, taskId: undefined });
        }
      } catch {
        // network hiccup — keep polling
      }
    };

    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [data.taskId, data.label, status, id, updateNodeData]);

  // ── Pipeline runner trigger ───────────────────────────────────────────────
  const generateRef = useRef(generate);
  useEffect(() => { generateRef.current = generate; }, [generate]);
  useEffect(() => {
    if (!data.pendingGenerate) return;
    updateNodeData(id, { pendingGenerate: false });
    generateRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.pendingGenerate]);

  // ── Voice preview ─────────────────────────────────────────────────────────
  const playPreview = useCallback(() => {
    previewRef.current?.pause();
    const a = new Audio(voicePreviewUrl(voice));
    previewRef.current = a;
    a.play().catch(() => addToast("Could not play the voice preview.", "error"));
  }, [voice, addToast]);

  const handleDelete = useCallback(() => {
    onNodesChange([{ type: "remove", id }]);
  }, [id, onNodesChange]);

  const handleDuplicate = useCallback(() => {
    const src = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    if (!src) return;
    onNodesChange([{ type: "select", id, selected: false }]);
    addNode({
      ...src,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      position: { x: src.position.x + 40, y: src.position.y + 40 },
      selected: true,
      data: { ...src.data, status: "idle", audioUrl: undefined, taskId: undefined, errorMsg: undefined },
    });
  }, [id, onNodesChange, addNode]);

  const slider = (
    label: string,
    key: "speed" | "stability" | "similarityBoost" | "style",
    value: number,
    range: { min: number; max: number; step: number },
  ) => (
    <label className="block">
      <div className="flex justify-between text-[10px] text-gray-400 mb-0.5">
        <span>{label}</span>
        <span>{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        className="nodrag nowheel w-full accent-violet-400"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        disabled={readOnly}
        onMouseDown={stop}
        onChange={(e) => updateNodeData(id, { [key]: Number(e.target.value) })}
      />
    </label>
  );

  return (
    <div
      ref={cardRef}
      className={`node-card w-full${busy ? " node-generating" : ""}${(data.hasError as boolean) ? " node-error-blink" : ""}`}
      style={{ minWidth: 280 }}
      onAnimationEnd={() => updateNodeData(id, { hasError: false })}
    >
      <NodeActionBar
        visible={!!selected && !data.locked && !readOnly}
        hasContent={!!audioUrl}
        onDelete={handleDelete}
        onDuplicate={handleDuplicate}
      />
      <span className="node-above-label">{data.label as string}</span>
      {!promptConnected && !busy && !data.locked && (
        <MissingInputWarning messages={["A text node with the script is required"]} />
      )}

      <Handle
        type="target"
        position={Position.Left}
        id="prompt"
        style={{ top: "50%" }}
        className={`node-handle-icon node-handle-icon-prompt${promptConnected ? " node-handle-connected" : ""}`}
        title="Script (text)"
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="white">
          <path d="M1.5 2h11v2H8.5v8H5.5V4H1.5V2z" />
        </svg>
      </Handle>

      <div className="p-3 space-y-2.5 text-xs text-gray-200" style={{ background: "#141414", borderRadius: 8 }}>
        <div className="flex items-center gap-2">
          <span className="text-violet-300 font-semibold">Voice</span>
          <span className="text-gray-500 truncate">{cfg.name}</span>
          {status === "running" && <span className="ml-auto text-amber-400 animate-pulse">Generating…</span>}
          {status === "done" && <span className="ml-auto text-emerald-400">Ready</span>}
          {status === "error" && <span className="ml-auto text-red-400">Error</span>}
        </div>

        <div className="flex items-center gap-2">
          <select
            className="nodrag nowheel flex-1 bg-[#1f1f1f] border border-white/10 rounded-lg px-2 py-1.5 text-gray-100 focus:outline-none"
            value={voice}
            disabled={readOnly}
            onMouseDown={stop}
            onChange={(e) => updateNodeData(id, { voice: e.target.value })}
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="nodrag shrink-0 px-2 py-1.5 rounded-lg bg-[#1f1f1f] border border-white/10 hover:bg-white/10"
            onMouseDown={stop}
            onClick={(e) => { e.stopPropagation(); playPreview(); }}
            title="Play a short sample of this voice"
          >
            ▶ Sample
          </button>
        </div>

        {slider("Speed", "speed", speed, VOICE_SETTINGS.speed)}

        <button
          type="button"
          className="nodrag text-[10px] text-gray-400 hover:text-gray-200"
          onMouseDown={stop}
          onClick={(e) => { e.stopPropagation(); setShowAdvanced((v) => !v); }}
        >
          {showAdvanced ? "▾" : "▸"} Advanced
        </button>
        {showAdvanced && (
          <div className="space-y-2">
            {slider("Stability", "stability", stability, VOICE_SETTINGS.stability)}
            {slider("Similarity", "similarityBoost", similarityBoost, VOICE_SETTINGS.similarity_boost)}
            {slider("Style", "style", style, VOICE_SETTINGS.style)}
          </div>
        )}

        {audioUrl && (
          <audio className="nodrag w-full" controls src={audioUrl} onMouseDown={stop} />
        )}
        {status === "error" && data.errorMsg && (
          <div className="text-red-400 text-[11px] break-words">{data.errorMsg as string}</div>
        )}

        {!readOnly && (
          <button
            type="button"
            disabled={busy || !!data.locked}
            className="nodrag w-full py-1.5 rounded-lg font-semibold bg-violet-500/20 text-violet-200 border border-violet-400/40 hover:bg-violet-500/30 disabled:opacity-40"
            onMouseDown={stop}
            onClick={(e) => { e.stopPropagation(); generate(); }}
          >
            {busy ? "Generating…" : audioUrl ? "Regenerate" : "Generate voiceover"}
          </button>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="audioRefOut"
        style={{ top: "50%" }}
        className={`node-handle-icon node-handle-icon-out-audio${sourceConnected ? " node-handle-connected" : ""}`}
        title="Audio output"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round">
          <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
        </svg>
      </Handle>
    </div>
  );
}
