"use client";
/**
 * Higgsfield-style settings panel for the selected generator node (video or image).
 * Everything here edits the same node data the on-node pills use, and "Generate"
 * asks the node to run exactly as if its own button was clicked.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Panel } from "@xyflow/react";
import type { Node } from "@xyflow/react";
import { useWorkflowStore, type NodeData } from "@/lib/store";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import { videoCaps } from "@/lib/videoCaps";
import { switchImageModel, switchVideoModel, imageQualityOptions, requestGenerate } from "@/lib/nodeModelSwitch";
import { useCostStore, nodeEstimate } from "@/lib/nodeCost";
import { estimate, imageCostSpec, videoCostSpec, videoTier } from "@/lib/pricing";
import ModelPicker, { durationRange, maxResolution, type PickerModel } from "@/components/nodes/ModelPicker";
import { NodeProviderIcon } from "@/components/nodes/VideoGeneratorNode";

const KINDS: Record<string, "video" | "image"> = { videoGeneratorNode: "video", generateNode: "image" };

function Row({ label, value, open, onClick, children }: { label: string; value: ReactNode; open?: boolean; onClick: () => void; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03]">
      <button type="button" onClick={onClick} className="w-full flex items-center px-4 py-2.5 text-left hover:bg-white/[0.03] rounded-2xl">
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] text-white/45">{label}</span>
          <span className="block text-[15px] text-white truncate">{value}</span>
        </span>
        <span className={`text-white/50 transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open && children && <div className="px-3 pb-3 flex flex-wrap gap-1.5">{children}</div>}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-3 h-8 rounded-full text-xs border transition-colors ${active ? "bg-white text-black border-white" : "border-white/10 text-white/70 hover:border-white/30 hover:text-white"}`}>
      {children}
    </button>
  );
}

const durLabel = (d: number) => (d === -1 ? "Auto" : `${d}s`);

export default function NodeInspector() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const builderOpen = useWorkflowStore((s) => s.builderOpen);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const perUnit = useCostStore((s) => s.perUnit);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const modelAnchor = useRef<HTMLDivElement>(null);

  const selected = nodes.filter((n) => n.selected);
  const node = selected.length === 1 && KINDS[selected[0].type ?? ""] ? (selected[0] as Node<NodeData>) : null;
  const kind = node ? KINDS[node.type!] : null;

  // Connected prompt node + media inputs
  const promptEdge = node ? edges.find((e) => e.target === node.id && e.targetHandle === "prompt") : undefined;
  const promptNode = promptEdge ? nodes.find((n) => n.id === promptEdge.source) : undefined;
  const mediaInputs = useMemo(() => {
    if (!node) return [];
    return edges.filter((e) => e.target === node.id && e.targetHandle !== "prompt").map((e) => {
      const src = nodes.find((n) => n.id === e.source);
      const d = (src?.data ?? {}) as Record<string, unknown>;
      const isVideo = e.targetHandle === "referenceVideo" || e.targetHandle === "videoRef"
        || src?.type === "videoInputNode" || src?.type === "videoGeneratorNode";
      const url = (isVideo ? (d.videoUrl ?? d.r2Url) : (d.r2Url ?? d.imageUrl ?? d.inputImage)) as string | undefined;
      return { id: e.id, url, isVideo, label: String(src?.data?.label ?? "") };
    }).filter((x) => x.url);
  }, [node, edges, nodes]);

  const pickerModels: PickerModel[] = useMemo(() => {
    if (!node) return [];
    const d = node.data;
    if (kind === "video") {
      return VIDEO_MODELS.map((m) => {
        const dur = m.defaultDuration > 0 ? m.defaultDuration : (m.apiInput.useGoogleVeo ? 8 : 5);
        const est = estimate(videoCostSpec(m.id, videoTier(m, m.defaultMode, m.defaultResolution), false, dur), perUnit);
        return {
          id: m.id, name: m.name, family: m.provider,
          meta: [maxResolution(m.resolutions ?? (m.modes ? m.modes.map((x) => x.label).filter((l) => /\d+p$|4k/i.test(l)) : undefined)), durationRange(m.durations, m.apiInput.useGoogleVeo ? 8 : m.defaultDuration), m.sound ? "Audio" : null].filter((x): x is string => !!x),
          tags: videoCaps(m), credits: est.credits, creditsEstimated: est.source === "starter",
        };
      });
    }
    const quality = (d.quality as string | undefined) ?? "1k";
    return IMAGE_MODELS.map((m) => {
      const q = imageQualityOptions(m);
      const est = estimate(imageCostSpec(m.id, q.includes(quality) ? quality : (q[0] ?? "1k"), m), perUnit);
      return {
        id: m.id, name: m.name, family: m.provider,
        meta: q.length ? [q.map((x) => x.toUpperCase()).join(" / ")] : [],
        tags: m.supportsImages ? [{ label: `Reference images${m.maxImages ? ` ×${m.maxImages}` : ""}` }] : [{ label: "Text only" }],
        credits: est.credits, creditsEstimated: est.source === "starter",
      };
    });
  }, [node, kind, perUnit]);

  if (!node || builderOpen) return null;
  const d = node.data;
  const status = (d.status as string) ?? "idle";
  const busy = status === "running" || status === "pending";
  const est = nodeEstimate(node, nodes as Node<NodeData>[], edges, perUnit);
  const set = (patch: Partial<NodeData>) => updateNodeData(node.id, patch);
  const toggle = (row: string) => setOpenRow((r) => (r === row ? null : row));
  const close = () => onNodesChange([{ id: node.id, type: "select", selected: false }]);

  // Model-specific settings
  let modelName = "", provider = "";
  const rows: ReactNode[] = [];
  let soundRow: ReactNode = null;

  if (kind === "video") {
    const cfg = VIDEO_MODELS.find((m) => m.id === ((d.videoModel as string | undefined) ?? "kling-3.0")) ?? VIDEO_MODELS[0];
    modelName = cfg.name; provider = cfg.provider;
    const ratio = (d.aspectRatio as string | undefined) ?? cfg.defaultRatio;
    const duration = (d.duration as number | undefined) ?? cfg.defaultDuration;
    if (cfg.modes?.length) {
      const mode = (d.klingMode as string | undefined) ?? cfg.defaultMode ?? cfg.modes[0].value;
      rows.push(
        <Row key="res" label="Resolution" value={cfg.modes.find((x) => x.value === mode)?.label ?? mode} open={openRow === "res"} onClick={() => toggle("res")}>
          {cfg.modes.map((x) => <Chip key={x.value} active={x.value === mode} onClick={() => set({ klingMode: x.value })}>{x.label}</Chip>)}
        </Row>,
      );
    } else if (cfg.resolutions?.length) {
      const res = (d.grokResolution as string | undefined) ?? cfg.defaultResolution ?? cfg.resolutions[0];
      rows.push(
        <Row key="res" label="Resolution" value={res} open={openRow === "res"} onClick={() => toggle("res")}>
          {cfg.resolutions.map((r) => <Chip key={r} active={r === res} onClick={() => set({ grokResolution: r })}>{r}</Chip>)}
        </Row>,
      );
    }
    if (cfg.durations.length > 0) {
      const idx = Math.max(0, cfg.durations.indexOf(duration));
      rows.push(
        <div key="dur" className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 flex items-center gap-4">
          <span className="text-[15px] text-white shrink-0">Duration</span>
          <input type="range" min={0} max={cfg.durations.length - 1} step={1} value={idx}
            onChange={(e) => set({ duration: cfg.durations[Number(e.target.value)] })}
            className="flex-1 accent-white nodrag" />
          <span className="text-[15px] text-white tabular-nums w-12 text-right">{durLabel(cfg.durations[idx])}</span>
        </div>,
      );
    }
    if (cfg.ratios.length > 0) {
      rows.push(
        <Row key="ratio" label="Aspect ratio" value={ratio} open={openRow === "ratio"} onClick={() => toggle("ratio")}>
          {cfg.ratios.map((r) => <Chip key={r} active={r === ratio} onClick={() => set({ aspectRatio: r })}>{r}</Chip>)}
        </Row>,
      );
    }
    if (cfg.sound) {
      const on = d.sound === true;
      soundRow = (
        <button type="button" onClick={() => set({ sound: !on })} className="w-full flex items-center rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
          <span className="flex-1 text-left">
            <span className="block text-[11px] text-white/45">Sound</span>
            <span className="block text-[15px] text-white">{on ? "On" : "Off"}</span>
          </span>
          <span className={`w-9 h-5 rounded-full relative transition-colors ${on ? "bg-teal-400" : "bg-white/15"}`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
          </span>
        </button>
      );
    }
  } else {
    const cfg = IMAGE_MODELS.find((m) => m.id === ((d.model as string | undefined) ?? "nano-banana-2")) ?? IMAGE_MODELS[0];
    modelName = cfg.name; provider = cfg.provider;
    const q = imageQualityOptions(cfg);
    const quality = (d.quality as string | undefined) ?? q[0];
    const ratio = (d.aspectRatio as string | undefined) ?? "9:16";
    if (q.length) {
      rows.push(
        <Row key="q" label="Resolution" value={String(quality).toUpperCase()} open={openRow === "q"} onClick={() => toggle("q")}>
          {q.map((x) => <Chip key={x} active={x === quality} onClick={() => set({ quality: x })}>{x.toUpperCase()}</Chip>)}
        </Row>,
      );
    }
    rows.push(
      <Row key="ratio" label="Aspect ratio" value={ratio} open={openRow === "ratio"} onClick={() => toggle("ratio")}>
        {cfg.ratios.map((r) => <Chip key={r} active={r === ratio} onClick={() => set({ aspectRatio: r })}>{r}</Chip>)}
      </Row>,
    );
  }

  const modelId = kind === "video" ? ((d.videoModel as string | undefined) ?? "kling-3.0") : ((d.model as string | undefined) ?? "nano-banana-2");
  const prompt = promptNode ? String(promptNode.data.prompt ?? "") : "";

  return (
    <Panel position="top-right" style={{ marginTop: 64 }}>
      <div
        className="nodrag nowheel w-[340px] max-w-[85vw] max-h-[calc(100vh-150px)] flex flex-col rounded-3xl border border-white/10 bg-[#16181d]/95 backdrop-blur shadow-2xl text-white"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <span className="text-[17px] font-semibold">{kind === "video" ? "Video Generation" : "Image Generation"}</span>
          <span className="text-[11px] text-white/35 truncate">{String(d.label ?? "")}</span>
          <button type="button" onClick={close} className="ml-auto text-white/50 hover:text-white text-lg leading-none" title="Close">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-3 space-y-2.5">
          {/* Prompt + inputs */}
          <div className="rounded-2xl bg-white/[0.04] p-3 space-y-2">
            {mediaInputs.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {mediaInputs.map((m) => (
                  <div key={m.id} title={m.label} className="w-12 h-12 rounded-xl overflow-hidden bg-black/40 border border-white/10">
                    {m.isVideo
                      ? <video src={`${m.url}#t=0.5`} muted preload="metadata" className="w-full h-full object-cover" />
                      // eslint-disable-next-line @next/next/no-img-element
                      : <img src={m.url} alt="" className="w-full h-full object-cover" />}
                  </div>
                ))}
              </div>
            )}
            {promptNode ? (
              <textarea
                value={prompt}
                onChange={(e) => updateNodeData(promptNode.id, { prompt: e.target.value })}
                placeholder="Describe what you want to create…"
                className="w-full h-28 resize-none bg-transparent text-[13px] text-white/90 placeholder:text-white/30 focus:outline-none"
              />
            ) : (
              <div className="text-[12px] text-white/40 py-2">Connect a text node to write the prompt here.</div>
            )}
          </div>

          {/* Model */}
          <div ref={modelAnchor}>
            <Row label="Model" value={<span className="inline-flex items-center gap-2">{modelName}<span className="text-white/50" style={{ lineHeight: 0 }}><NodeProviderIcon provider={provider} /></span></span>} onClick={() => setPickerOpen((o) => !o)} />
          </div>
          <ModelPicker
            anchorRef={modelAnchor}
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            models={pickerModels}
            selectedId={modelId}
            renderIcon={(family) => <NodeProviderIcon provider={family} />}
            onSelect={(mid) => {
              if (mid === modelId) return;
              if (kind === "video") switchVideoModel(node.id, mid); else switchImageModel(node.id, mid);
              setPickerOpen(false);
            }}
          />

          {rows}

          {soundRow && (
            <>
              <button type="button" onClick={() => setAdvanced((a) => !a)} className="w-full flex items-center gap-2 px-2 py-2 text-[14px] text-white/80">
                <span>⚙︎</span> Advanced settings <span className={`ml-auto transition-transform ${advanced ? "rotate-180" : ""}`}>⌄</span>
              </button>
              {advanced && soundRow}
            </>
          )}
        </div>

        <div className="p-4 pt-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => requestGenerate(node.id)}
            className="w-full h-12 rounded-2xl font-semibold text-[15px] text-black bg-[#e8fb5a] hover:brightness-105 disabled:opacity-50 shadow-[0_4px_0_rgba(170,190,40,0.6)]"
          >
            {busy ? "Generating…" : (d.videoUrl || d.imageUrl) ? "Regenerate" : "Generate"}
            {est?.credits != null && <span className="ml-2">✦ {Math.round(est.credits)}</span>}
          </button>
        </div>
      </div>
    </Panel>
  );
}
