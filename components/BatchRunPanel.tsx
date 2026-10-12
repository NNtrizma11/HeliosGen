"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Panel, type Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useCostStore, fetchKieBalance } from "@/lib/nodeCost";
import { planBatch, type BatchStage, type BatchPlan } from "@/lib/batchPlan";
import { creditsToUsd, formatUsd } from "@/lib/pricing";
import StitchDialog from "@/components/StitchDialog";

/** Jobs submitted to Kie at the same time. */
const CONCURRENCY = 5;
/** A node that has not started this long after being triggered is counted as failed. */
const START_TIMEOUT_MS = 20_000;

const STAGE_LABEL: Record<BatchStage, string> = { images: "images", videos: "videos", voice: "voiceovers" };

interface RunState {
  stage: BatchStage;
  queue: string[];
  /** id → when it was triggered, and whether it has been seen generating */
  active: Record<string, { at: number; started: boolean }>;
  total: number;
  done: number;
  failed: string[];
  stopped: boolean;
}

/** Nodes the user is working on: the selection (and members of selected groups), or the whole canvas. */
function scopeNodes(nodes: Node<NodeData>[]): { list: Node<NodeData>[]; isSelection: boolean } {
  const selected = nodes.filter((n) => n.selected);
  if (!selected.length) return { list: nodes, isSelection: false };
  const ids = new Set<string>();
  for (const n of selected) {
    ids.add(n.id);
    for (const m of (n.data.memberIds as string[] | undefined) ?? []) ids.add(m);
  }
  return { list: nodes.filter((n) => ids.has(n.id)), isSelection: true };
}

export default function BatchRunPanel() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const perUnit = useCostStore((s) => s.perUnit);
  const loadPrices = useCostStore((s) => s.load);

  const [confirm, setConfirm] = useState<BatchStage | null>(null);
  const [redo, setRedo] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [stitchOpen, setStitchOpen] = useState(false);
  const runRef = useRef<RunState | null>(null);
  runRef.current = run;

  const scope = useMemo(() => scopeNodes(nodes as Node<NodeData>[]), [nodes]);
  const counts = useMemo(() => ({
    images: scope.list.filter((n) => n.type === "generateNode").length,
    videos: scope.list.filter((n) => n.type === "videoGeneratorNode").length,
    voice: scope.list.filter((n) => n.type === "voiceNode").length,
  }), [scope]);

  const plan: BatchPlan | null = useMemo(
    () => (confirm ? planBatch(confirm, scope.list, nodes as Node<NodeData>[], edges, perUnit, redo) : null),
    [confirm, scope, nodes, edges, perUnit, redo],
  );

  const openConfirm = useCallback((stage: BatchStage) => {
    setRedo(false);
    setConfirm(stage);
    loadPrices(true);
    setBalance(null);
    fetchKieBalance().then(setBalance);
  }, [loadPrices]);

  const approve = useCallback(() => {
    if (!plan || !confirm || !plan.run.length) return;
    setRun({
      stage: confirm,
      queue: plan.run.map((i) => i.id),
      active: {},
      total: plan.run.length,
      done: 0,
      failed: [],
      stopped: false,
    });
    setConfirm(null);
  }, [plan, confirm]);

  // ── Runner: keep up to CONCURRENCY nodes generating, advance as they finish ──
  useEffect(() => {
    const r = runRef.current;
    if (!r) return;
    const active = { ...r.active };
    let done = r.done;
    const failed = [...r.failed];
    let changed = false;

    for (const [id, a] of Object.entries(active)) {
      const n = nodes.find((x) => x.id === id);
      const status = n?.data.status as string | undefined;
      const generating = status === "pending" || status === "running" || !!n?.data.pendingGenerate;
      if (!n) { delete active[id]; failed.push(id); changed = true; continue; }
      if (!a.started && (status === "pending" || status === "running")) { active[id] = { ...a, started: true }; changed = true; continue; }
      if (a.started && !generating) {
        delete active[id];
        if (status === "error") failed.push(id); else done += 1;
        changed = true;
        continue;
      }
      if (!a.started && !generating && Date.now() - a.at > START_TIMEOUT_MS) {
        delete active[id]; failed.push(id); changed = true;
      }
    }

    const queue = [...r.queue];
    if (!r.stopped) {
      while (Object.keys(active).length < CONCURRENCY && queue.length) {
        const id = queue.shift()!;
        active[id] = { at: Date.now(), started: false };
        updateNodeData(id, { pendingGenerate: true, pipelineQueued: false });
        changed = true;
      }
    }

    if (!changed) return;
    if (!queue.length && !Object.keys(active).length) {
      setRun({ ...r, queue, active, done, failed, stopped: true });
      loadPrices(true);
    } else {
      setRun({ ...r, queue, active, done, failed });
    }
  }, [nodes, run, updateNodeData, loadPrices]);

  // Nodes that never start (e.g. a validation error) are caught by a periodic check
  const pendingWork = !!run && (!run.stopped || Object.keys(run.active).length > 0);
  useEffect(() => {
    if (!pendingWork) return;
    const t = setInterval(() => setRun((r) => (r ? { ...r } : r)), 5000);
    return () => clearInterval(t);
  }, [pendingWork]);

  const finished = run && run.stopped && !Object.keys(run.active).length;
  const runningCount = run ? Object.keys(run.active).length : 0;

  const totalUsd = plan ? creditsToUsd(plan.credits) : 0;
  const after = balance !== null && plan ? balance - plan.credits : null;

  return (
    <>
      <Panel position="top-center">
        <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#111]/90 backdrop-blur px-2 py-1.5 text-xs shadow-lg">
          {run && !finished ? (
            <>
              <span className="px-2 text-amber-300">
                Generating {STAGE_LABEL[run.stage]}: {run.done}/{run.total}
                {runningCount ? ` · ${runningCount} running` : ""}
                {run.failed.length ? ` · ${run.failed.length} failed` : ""}
              </span>
              {!run.stopped && (
                <button
                  className="px-2.5 py-1 rounded-full text-white/70 hover:text-white hover:bg-white/10"
                  onClick={() => setRun({ ...run, queue: [], stopped: true })}
                  title="Stops starting new jobs. Jobs already running finish."
                >
                  Stop
                </button>
              )}
            </>
          ) : (
            <>
              {run && finished && (
                <button className="px-2 text-emerald-300 hover:text-emerald-200" onClick={() => setRun(null)} title="Dismiss">
                  {STAGE_LABEL[run.stage]}: {run.done} done{run.failed.length ? `, ${run.failed.length} failed` : ""} ✕
                </button>
              )}
              <span className="px-1.5 text-white/40">{scope.isSelection ? "Selection" : "Canvas"}:</span>
              <button disabled={!counts.images} onClick={() => openConfirm("images")} className="px-2.5 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30">
                Generate images
              </button>
              <button disabled={!counts.videos} onClick={() => openConfirm("videos")} className="px-2.5 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30">
                Generate videos
              </button>
              {counts.voice > 0 && (
                <button onClick={() => openConfirm("voice")} className="px-2.5 py-1 rounded-full bg-white/[0.06] hover:bg-white/[0.12]">
                  Generate voice
                </button>
              )}
              <button disabled={!counts.videos} onClick={() => setStitchOpen(true)} className="px-2.5 py-1 rounded-full bg-violet-500/20 text-violet-100 hover:bg-violet-500/30 disabled:opacity-30">
                Stitch video
              </button>
            </>
          )}
        </div>
      </Panel>

      {confirm && plan && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60" onClick={() => setConfirm(null)}>
          <div
            className="w-[480px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-2xl border border-white/10 bg-[#121212] text-sm text-gray-200 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-4 pb-3 border-b border-white/10">
              <div className="text-base font-semibold">Generate {STAGE_LABEL[confirm]}</div>
              <div className="text-xs text-white/50 mt-0.5">{scope.isSelection ? "Selected nodes" : "Whole canvas"} · runs {CONCURRENCY} at a time</div>
            </div>

            <div className="px-5 py-3 space-y-3 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-white/[0.04] px-3 py-2">
                  <div className="text-[11px] text-white/50">Estimated cost</div>
                  <div className="text-lg font-semibold">{formatUsd(totalUsd)}</div>
                  <div className="text-[11px] text-white/40">
                    {Math.round(plan.credits)} credits{plan.unknownCount ? ` + ${plan.unknownCount} not yet priced` : ""}
                  </div>
                </div>
                <div className="rounded-lg bg-white/[0.04] px-3 py-2">
                  <div className="text-[11px] text-white/50">Kie balance</div>
                  <div className="text-lg font-semibold">{balance === null ? "…" : formatUsd(creditsToUsd(balance))}</div>
                  <div className={`text-[11px] ${after !== null && after < 0 ? "text-red-400" : "text-white/40"}`}>
                    {after === null ? "" : after < 0 ? "not enough credit" : `≈ ${formatUsd(creditsToUsd(after))} after`}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-xs text-white/50 mb-1">Will run ({plan.run.length})</div>
                {plan.run.length === 0 && <div className="text-xs text-white/40">Nothing to run.</div>}
                <div className="space-y-0.5">
                  {plan.run.map((i) => (
                    <div key={i.id} className="flex justify-between text-xs">
                      <span className="truncate">{i.label}</span>
                      <span className="text-white/50 shrink-0 ml-3">
                        {i.credits === null ? "price unknown" : `${i.measured ? "" : "~"}${Math.round(i.credits * 10) / 10} cr · ${formatUsd(creditsToUsd(i.credits))}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {plan.alreadyDone.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-white/60">
                  <input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} />
                  {plan.alreadyDone.length} already have a result and are skipped. Tick to generate them again.
                </label>
              )}
              {redo && plan.run.some((i) => scope.list.find((n) => n.id === i.id && (n.data.imageUrl || n.data.videoUrl || n.data.audioUrl))) && (
                <div className="text-[11px] text-white/40">Regenerated nodes keep their earlier results in their history.</div>
              )}

              {plan.blocked.length > 0 && (
                <div>
                  <div className="text-xs text-amber-300/80 mb-1">Skipped ({plan.blocked.length})</div>
                  {plan.blocked.map((b) => (
                    <div key={b.id} className="text-xs text-white/50"><span className="text-white/70">{b.label}</span>: {b.reason}</div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
              <button className="px-3 py-1.5 rounded-lg text-white/60 hover:text-white" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                disabled={!plan.run.length || !!run && !finished}
                onClick={approve}
                className="px-4 py-1.5 rounded-lg font-semibold bg-violet-500/30 text-violet-100 border border-violet-400/40 hover:bg-violet-500/40 disabled:opacity-40"
              >
                Approve and run {plan.run.length}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {stitchOpen && <StitchDialog scope={scope.list} onClose={() => setStitchOpen(false)} />}
    </>
  );
}
