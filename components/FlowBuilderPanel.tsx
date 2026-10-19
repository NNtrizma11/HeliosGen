"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { planToGraph, type FlowPlan, type ValidationResult, type PlanNode } from "@/lib/flowBuilder";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import { VOICES } from "@/lib/voiceConfig";
import { EDITABLE_NODE_TYPES, snapshotTargets, editToStoreOps, addToGraph, type EditPlan, type EditTarget, type TargetRef } from "@/lib/nodeEdit";
import { useCostStore, nodeEstimate } from "@/lib/nodeCost";
import { creditsToUsd, formatUsd } from "@/lib/pricing";
import type { Node } from "@xyflow/react";
import type { NodeData } from "@/lib/store";

interface ChatEntry {
  role: "user" | "assistant";
  /** Text sent back to the model as conversation history */
  content: string;
  /** Extra detail shown only in the panel */
  details?: string[];
  tone?: "ok" | "error";
  /** Part of a node edit, kept out of the builder's history */
  edit?: boolean;
}

const RULES_KEY = "flow-builder-rules";
const TYPE_NAME: Record<string, string> = {
  image_gen: "Image", video_gen: "Video", voice: "Voice", image_ref: "Reference image", text: "Text",
};

function describe(n: PlanNode): string {
  const s = n.settings ?? {};
  const parts: string[] = [TYPE_NAME[n.type] ?? n.type];
  if (n.type === "image_gen") {
    parts.push(IMAGE_MODELS.find((m) => m.id === s.model)?.name ?? String(s.model));
    if (s.aspectRatio) parts.push(String(s.aspectRatio));
    if (s.quality) parts.push(String(s.quality).toUpperCase());
  } else if (n.type === "video_gen") {
    const m = VIDEO_MODELS.find((x) => x.id === s.model);
    parts.push(m?.name ?? String(s.model));
    if (s.mode) parts.push(m?.modes?.find((x) => x.value === s.mode)?.label ?? String(s.mode));
    if (s.resolution) parts.push(String(s.resolution));
    if (s.aspectRatio) parts.push(String(s.aspectRatio));
    if (s.duration) parts.push(`${String(s.duration)}s`);
    parts.push(s.sound ? "sound on" : "sound off");
  } else if (n.type === "voice") {
    parts.push(VOICES.find((v) => v.id === s.voice)?.name ?? "default voice");
  } else if (n.type === "image_ref") {
    parts.push(n.url ? "loaded from URL" : "empty, upload an image");
  }
  return `${n.label ?? n.key} — ${parts.join(" · ")}`;
}


/** Read a builder response; a non-JSON body (proxy timeout, gateway page) becomes a readable error. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const hint = /upstream|timeout|timed out|gateway/i.test(text) || res.status >= 500
      ? "The AI took too long or the connection dropped. Try again, or ask for a smaller part of the workflow at a time."
      : `Unexpected reply from the server (${res.status}).`;
    return { error: hint };
  }
}

const PENDING_KEY = "flow-builder-pending";
const chatKey = (spaceId: string) => `flow-builder-chat:${spaceId}`;

/** A build running on the server, remembered so a refresh can pick it up again. */
interface PendingJob {
  jobId: string;
  spaceId: string;
  kind: "build" | "edit";
  startedAt: number;
  refs?: TargetRef[];
  targets?: EditTarget[];
}

function loadPending(): PendingJob | null {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null"); } catch { return null; }
}
function savePending(p: PendingJob | null) {
  try { if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p)); else localStorage.removeItem(PENDING_KEY); } catch { /* storage unavailable */ }
}

/** Poll a server build job until it finishes. */
type JobProgress = { textChars: number; thinkingChars: number; seconds: number; steps?: string[] };

async function pollJob(jobId: string, token: string, onProgress?: (p: JobProgress) => void): Promise<Record<string, unknown>> {
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, i < 10 ? 2000 : 4000));
    let j: Record<string, unknown>;
    try {
      const res = await fetch(`/api/flow-builder?job=${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${token}` } });
      j = await readJson(res);
    } catch {
      continue; // network blip: keep polling
    }
    if (j.status === "running") { if (j.progress && onProgress) onProgress(j.progress as JobProgress); continue; }
    if (j.status === "missing") return { error: "This build could not be found any more." };
    return (j.result as Record<string, unknown>) ?? { error: String(j.error ?? "The build failed.") };
  }
}

/** Start a build on the server and wait for it. onStart receives the job id (to remember it). */
async function runJob(body: object, token: string, onStart: (jobId: string) => void, onProgress?: (p: JobProgress) => void): Promise<Record<string, unknown>> {
  const res = await fetch("/api/flow-builder", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await readJson(res);
  if (typeof json.jobId !== "string") return json; // guest mode or an immediate error
  onStart(json.jobId);
  return pollJob(json.jobId, token, onProgress);
}

/** "Estimated cost if you run everything: …" for newly created nodes. */
function costLine(created: Node<NodeData>[]): string | null {
  const { nodes, edges } = useWorkflowStore.getState();
  const perUnit = useCostStore.getState().perUnit;
  const groups: Record<string, { n: number; credits: number; unknown: number }> = {};
  const name: Record<string, string> = { generateNode: "images", videoGeneratorNode: "videos", voiceNode: "voiceovers" };
  for (const c of created) {
    const live = nodes.find((x) => x.id === c.id) ?? c;
    if (!name[live.type ?? ""]) continue;
    const est = nodeEstimate(live as Node<NodeData>, nodes as Node<NodeData>[], edges, perUnit);
    const g = (groups[live.type!] ??= { n: 0, credits: 0, unknown: 0 });
    g.n++;
    if (est?.credits != null) g.credits += est.credits; else g.unknown++;
  }
  const keys = Object.keys(groups);
  if (!keys.length) return null;
  const fmt = (c: number) => Math.round(c).toLocaleString("en-US");
  const parts = keys.map((k) => `${groups[k].n} ${name[k]} ≈ ${fmt(groups[k].credits)} cr`);
  const total = keys.reduce((a, k) => a + groups[k].credits, 0);
  const unknown = keys.reduce((a, k) => a + groups[k].unknown, 0);
  return `Estimated cost to run everything: ${parts.join(" · ")} · total ≈ ${fmt(total)} cr (${formatUsd(creditsToUsd(total))})`
    + (unknown ? `. ${unknown} node${unknown === 1 ? " has" : "s have"} no known price yet (shown after the first run).` : ".");
}

/** "AI: 3.1s to start, 41s thinking/writing, 4,120 output tokens" from the job's stats. */
function timingLine(json: Record<string, unknown>): string | null {
  const s = json.stats as { model?: string; firstText?: number | null; total?: number; thinkingChars?: number; outputTokens?: number | null } | undefined;
  if (!s?.total) return null;
  return `Timing: ${s.total}s on ${s.model ?? "Claude"}${s.firstText != null ? ` (first text after ${s.firstText}s${s.thinkingChars ? `, after thinking ${s.thinkingChars.toLocaleString("en-US")} chars` : ""})` : ""}${s.outputTokens ? `, ${s.outputTokens.toLocaleString("en-US")} output tokens` : ""}.`;
}

export default function FlowBuilderPanel() {
  const insertFlow = useWorkflowStore((s) => s.insertFlow);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const applyNodeEdit = useWorkflowStore((s) => s.applyNodeEdit);
  const nodes = useWorkflowStore((s) => s.nodes);
  const spaceId = useWorkflowStore((s) => s.activeSpaceId);
  const { fitView } = useReactFlow();

  // Nodes the chat is editing: follows the canvas selection; ✕ detaches one.
  const selectedIds = useMemo(
    () => nodes.filter((n) => n.selected && n.type && EDITABLE_NODE_TYPES[n.type]).map((n) => n.id),
    [nodes],
  );
  const selectionKey = selectedIds.join(",");
  const [attached, setAttached] = useState<string[]>([]);
  useEffect(() => { setAttached(selectionKey ? selectionKey.split(",") : []); }, [selectionKey]);
  const attachedNodes = attached
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => !!n);
  const editing = attachedNodes.length > 0;

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [rules, setRules] = useState("");
  const [showRules, setShowRules] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadedChatFor = useRef<string | null>(null);
  const resumed = useRef(false);

  // The conversation is kept per canvas space, so a refresh doesn't wipe it.
  useEffect(() => {
    if (!spaceId) return;
    try { setChat(JSON.parse(localStorage.getItem(chatKey(spaceId)) ?? "[]")); } catch { setChat([]); }
    loadedChatFor.current = spaceId;
  }, [spaceId]);
  useEffect(() => {
    if (!spaceId || loadedChatFor.current !== spaceId) return;
    try { localStorage.setItem(chatKey(spaceId), JSON.stringify(chat.slice(-40))); } catch { /* storage full */ }
  }, [chat, spaceId]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    try { setRules(localStorage.getItem(RULES_KEY) ?? ""); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(RULES_KEY, rules); } catch { /* storage unavailable */ }
  }, [rules]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat, busy]);

  const importUrls = useCallback((imports: Array<{ nodeId: string; url: string }>, token: string) => {
    for (const imp of imports) {
      fetch("/api/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: imp.url }),
      })
        .then((r) => r.json())
        .then((j: { cdnUrl?: string }) => { if (j.cdnUrl) updateNodeData(imp.nodeId, { r2Url: j.cdnUrl, inputImage: j.cdnUrl }); })
        .catch(() => { /* keep the original URL */ });
    }
  }, [updateNodeData]);

  const build = useCallback(async (plan: FlowPlan, token: string) => {
    const { nodes } = useWorkflowStore.getState();
    // Place the new flow to the right of everything already on the canvas
    let maxX = 0, minY = 0, any = false;
    for (const n of nodes) {
      const w = (n.measured?.width ?? (n.style?.width as number | undefined) ?? 300);
      maxX = any ? Math.max(maxX, n.position.x + w) : n.position.x + w;
      minY = any ? Math.min(minY, n.position.y) : n.position.y;
      any = true;
    }
    const origin = any ? { x: maxX + 400, y: minY } : { x: 0, y: 0 };

    const graph = planToGraph(plan, origin);
    insertFlow(graph.nodes, graph.edges);
    setTimeout(() => fitView({ nodes: graph.nodes.map((n) => ({ id: n.id })), padding: 0.1, duration: 600 }), 100);

    // Import URL images into storage so generation models can always fetch them
    importUrls(graph.imports, token);
    return graph;
  }, [insertFlow, fitView, importUrls]);


  /** Apply a finished edit job to the canvas and report it in the chat. */
  const applyEdit = useCallback(async (json: Record<string, unknown>, token: string, refs: TargetRef[], targets: EditTarget[]) => {
    const { edit, validation, error } = json as { edit?: EditPlan; validation?: { errors: string[]; warnings: string[] }; error?: string };
    if (!edit) throw new Error(error ?? "The edit failed.");
    const problems = [...(edit.problems ?? []), ...(validation?.errors ?? [])];
    const changes = edit.changes ?? [];
    const deletes = edit.delete ?? [];
    const adds = edit.add?.nodes ?? [];

    if (problems.length) {
      setChat((c) => [...c, {
        role: "assistant", tone: "error", edit: true,
        content: `${edit.message ?? "I did not change anything."} Problems: ${problems.join(" ")}`,
        details: [edit.message ?? "Nothing was changed.", ...problems],
      }]);
      return;
    }
    if (!changes.length && !deletes.length && !adds.length) {
      setChat((c) => [...c, { role: "assistant", tone: "ok", edit: true, content: edit.message ?? "No changes needed." }]);
      return;
    }

    const ops = editToStoreOps(edit, refs, useWorkflowStore.getState().nodes);
    // New nodes go next to the selection and are wired to it, in the same undo step
    const added = edit.add && adds.length ? addToGraph(edit.add, refs, useWorkflowStore.getState().nodes) : null;
    if (added) {
      ops.addNodes = [...ops.addNodes, ...added.nodes];
      ops.addEdges = [...ops.addEdges, ...added.edges];
    }
    applyNodeEdit(ops);
    let cost: string | null = null;
    if (added) {
      setTimeout(() => fitView({ nodes: added.nodes.map((n) => ({ id: n.id })), padding: 0.1, duration: 600 }), 100);
      importUrls(added.imports, token);
      await useCostStore.getState().load();
      cost = costLine(added.nodes as Node<NodeData>[]);
    }
    const labelOf = (k: string) => targets.find((t) => t.key === k)?.label ?? k;
    setChat((c) => [...c, {
      role: "assistant", tone: "ok", edit: true,
      content: edit.message ?? "Updated the nodes.",
      details: [
        edit.message ?? "Updated the nodes.",
        ...changes.filter((ch) => !deletes.includes(ch.key)).map((ch) => {
          const parts = [
            ...Object.entries(ch.settings ?? {}).map(([k, v]) => `${k} → ${String(v)}`),
            ...(ch.label ? [`renamed to ${ch.label}`] : []),
            ...(ch.prompt !== undefined ? ["prompt rewritten"] : []),
          ];
          return `✓ ${labelOf(ch.key)}: ${parts.join(", ") || "updated"}`;
        }),
        ...deletes.map((k) => `🗑 Deleted ${labelOf(k)}`),
        ...(adds.length ? [`＋ Added ${adds.length} node${adds.length === 1 ? "" : "s"} (${[...new Set(adds.map((n) => n.type))].join(", ")}) connected to the selection`] : []),
        ...(cost ? [cost] : []),
        ...(validation?.warnings ?? []).map((w) => `Warning: ${w}`),
        "Nothing was generated. Ctrl+Z undoes this edit.",
      ],
    }]);
  }, [applyNodeEdit, fitView, importUrls]);

  /** Apply a finished build job to the canvas and report it in the chat. */
  const applyBuild = useCallback(async (json: Record<string, unknown>, token: string) => {
    const { plan, validation, error } = json as { plan?: FlowPlan; validation?: ValidationResult; error?: string };
    if (!plan) throw new Error(error ?? "The builder failed.");
    const problems = plan.problems ?? [];
    const errors = validation?.errors ?? [];

    if (problems.length || errors.length || plan.nodes.length === 0) {
      setChat((c) => [...c, {
        role: "assistant",
        tone: "error",
        content: `${plan.message ?? "I did not build anything."} Problems: ${[...problems, ...errors].join(" ")}`,
        details: [
          "Nothing was built and nothing was generated.",
          ...problems,
          ...errors,
          ...(plan.nodes.length === 0 && !problems.length && !errors.length ? ["The plan was empty."] : []),
        ],
      }]);
      return;
    }

    const graph = await build(plan, token);
    await useCostStore.getState().load();
    const cost = costLine(graph.nodes);
    const textCount = graph.nodes.length - plan.nodes.length;
    // Long node lists are summarised so the chat stays readable
    const listed = plan.nodes.length > 30
      ? [...plan.nodes.slice(0, 6).map((n) => `✓ ${describe(n)}`), `… and ${plan.nodes.length - 6} more`]
      : plan.nodes.map((n) => `✓ ${describe(n)}`);
    setChat((c) => [...c, {
      role: "assistant",
      tone: "ok",
      content: `${plan.message ?? "Built the flow."} Created ${plan.nodes.length} nodes and ${graph.edges.length} connections.`,
      details: [
        plan.message ?? "Built the flow.",
        `${plan.nodes.length} nodes${textCount > 0 ? ` (+${textCount} prompt text nodes)` : ""}, ${graph.edges.length} connections. Nothing was generated.`,
        ...(cost ? [cost] : []),
        ...(timingLine(json) ? [timingLine(json)!] : []),
        ...listed,
        ...(plan.notes ?? []).map((n) => `Note: ${n}`),
        ...(validation?.warnings ?? []).map((w) => `Warning: ${w}`),
      ],
    }]);
  }, [build]);

  const fail = useCallback((e: unknown, edit: boolean) => {
    const msg = e instanceof Error ? e.message : String(e);
    setChat((c) => [...c, { role: "assistant", tone: "error", edit, content: `Error: ${msg}`, details: [msg] }]);
  }, []);

  // After a refresh: pick up a build that was still running for this canvas space.
  useEffect(() => {
    if (resumed.current || !spaceId) return;
    const p = loadPending();
    if (!p || p.spaceId !== spaceId) return;
    resumed.current = true;
    if (Date.now() - p.startedAt > 30 * 60_000) { savePending(null); return; }
    (async () => {
      const { data } = await createClient().auth.getSession();
      if (!data.session) return;
      const token = data.session.access_token;
      setOpen(true);
      setBusy(true);
      setStartedAt(p.startedAt);
      try {
        const json = await pollJob(p.jobId, token, setProgress);
        savePending(null);
        if (p.kind === "edit") await applyEdit(json, token, p.refs ?? [], p.targets ?? []);
        else await applyBuild(json, token);
      } catch (e) {
        savePending(null);
        fail(e, p.kind === "edit");
      } finally {
        setBusy(false);
        setStartedAt(null);
        setProgress(null);
      }
    })();
  }, [spaceId, applyBuild, applyEdit, fail]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    const { data: authData } = await createClient().auth.getSession();
    if (!authData.session) { setAuthModalOpen(true); return; }
    const token = authData.session.access_token;
    const t0 = Date.now();
    setInput("");
    setBusy(true);
    setStartedAt(t0);

    try {
      if (editing) {
        const state = useWorkflowStore.getState();
        const { targets, refs } = snapshotTargets(attachedNodes.map((n) => n.id), state.nodes, state.edges);
        setChat((c) => [...c, { role: "user", edit: true, content: `[Editing ${targets.map((t) => t.label).join(", ")}] ${text}` }]);
        const json = await runJob(
          { mode: "edit", targets, rules, messages: [{ role: "user", content: text }] },
          token,
          (jobId) => savePending({ jobId, spaceId, kind: "edit", startedAt: t0, refs, targets }),
          setProgress,
        );
        savePending(null);
        await applyEdit(json, token, refs, targets);
      } else {
        const next: ChatEntry[] = [...chat, { role: "user", content: text }];
        setChat(next);
        const json = await runJob(
          { messages: next.filter((m) => !m.content.startsWith("[Editing ") && !m.edit).map(({ role, content }) => ({ role, content })), rules },
          token,
          (jobId) => savePending({ jobId, spaceId, kind: "build", startedAt: t0 }),
          setProgress,
        );
        savePending(null);
        await applyBuild(json, token);
      }
    } catch (e: unknown) {
      savePending(null);
      fail(e, editing);
    } finally {
      setBusy(false);
      setStartedAt(null);
      setProgress(null);
    }
  }, [input, busy, chat, rules, editing, attachedNodes, spaceId, setAuthModalOpen, applyEdit, applyBuild, fail]);

  if (!open) {
    return (
      <Panel position="top-right">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-3 py-2 rounded-full text-sm font-semibold bg-violet-500/20 text-violet-100 border border-violet-400/40 hover:bg-violet-500/30 shadow-lg"
        >
          ✦ Build with AI
        </button>
      </Panel>
    );
  }

  return (
    <Panel position="top-right">
      <div
        className="nodrag nowheel flex flex-col w-[400px] max-w-[90vw] h-[70vh] rounded-2xl border border-white/10 bg-[#111]/95 backdrop-blur shadow-2xl text-sm text-gray-200"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
          <span className="font-semibold text-violet-200">✦ Build with AI</span>
          <span className="text-[11px] text-gray-500">{editing ? "edits, extends and connects selected nodes, never generates" : "builds nodes only, never generates"}</span>
          <button type="button" className="ml-auto text-gray-400 hover:text-white" onClick={() => setOpen(false)}>✕</button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {chat.length === 0 && (
            <p className="text-gray-500 text-xs leading-relaxed">
              Describe the flow you want, e.g. “5 hooks from this script, each a 9:16 Nano Banana 2.1 image, then a 5-second Kling 3.0 video from each”.
              Long instructions with exact prompts work too: text you give is copied unchanged.
            </p>
          )}
          {chat.map((m, i) => (
            <div key={i} className={m.role === "user" ? "ml-8" : "mr-4"}>
              {m.role === "user" ? (
                <div className="rounded-xl bg-white/5 px-3 py-2 whitespace-pre-wrap break-words max-h-48 overflow-y-auto text-xs">{m.content}</div>
              ) : (
                <div className={`rounded-xl px-3 py-2 text-xs space-y-1 ${m.tone === "error" ? "bg-red-500/10 text-red-200" : "bg-violet-500/10"}`}>
                  {(m.details ?? [m.content]).map((d, j) => (
                    <div key={j} className="break-words">{d}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="text-xs text-amber-300 animate-pulse">
              {editing ? "Working on the selected nodes…" : "Planning the flow…"}
              {startedAt ? ` ${Math.max(0, Math.round((now - startedAt) / 1000))}s` : ""}
              {progress && (progress.textChars > 0
                ? ` · writing, ${progress.textChars.toLocaleString("en-US")} characters so far`
                : progress.thinkingChars > 0
                  ? ` · thinking (${progress.thinkingChars.toLocaleString("en-US")} characters)`
                  : " · waiting for the AI to start")}
              <span className="block text-[10px] text-gray-500 mt-0.5">It keeps running on the server — you can refresh or leave and it will appear when done.</span>
            </div>
          )}
          {busy && progress?.steps && progress.steps.length > 0 && (
            <div className="mr-4 rounded-xl bg-white/5 px-3 py-2 text-[11px] text-gray-300 space-y-0.5">
              {progress.steps.slice(-14).map((st, i, arr) => (
                <div key={i} className={`break-words ${i === arr.length - 1 ? "text-amber-200" : ""}`}>{st}</div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-white/10 p-3 space-y-2">
          {editing ? (
            <div className="rounded-lg bg-violet-500/10 border border-violet-400/20 px-2 py-1.5">
              <div className="flex items-center gap-2 text-[11px] text-violet-200 mb-1">
                <span>Chatting with {attachedNodes.length} node{attachedNodes.length === 1 ? "" : "s"}</span>
                <button type="button" className="ml-auto text-gray-400 hover:text-white" onClick={() => setAttached([])} disabled={busy}>
                  Remove all
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {attachedNodes.map((n) => (
                  <span key={n.id} className="inline-flex items-center gap-1 rounded-full bg-white/10 pl-2 pr-1 py-0.5 text-[11px]">
                    <span className="max-w-[140px] truncate">{String(n.data.label ?? n.id)}</span>
                    <button
                      type="button"
                      title="Remove from chat"
                      className="w-4 h-4 rounded-full text-gray-400 hover:text-white hover:bg-white/10 leading-none"
                      onClick={() => setAttached((a) => a.filter((x) => x !== n.id))}
                      disabled={busy}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[10px] text-gray-500">Tip: select nodes on the canvas to chat with them and change them.</div>
          )}
          <button type="button" className="text-[11px] text-gray-400 hover:text-gray-200" onClick={() => setShowRules((v) => !v)}>
            {showRules ? "▾" : "▸"} Standing rules{rules.trim() ? " (active)" : ""}
          </button>
          {showRules && (
            <textarea
              className="w-full h-20 resize-none rounded-lg bg-[#1a1a1a] border border-white/10 px-2 py-1.5 text-xs focus:outline-none"
              placeholder="Rules applied to every request, e.g. “Default to 9:16 and Kling 3.0 at 720p, sound off.”"
              value={rules}
              onChange={(e) => setRules(e.target.value)}
            />
          )}
          <textarea
            className="w-full h-28 resize-none rounded-lg bg-[#1a1a1a] border border-white/10 px-2 py-1.5 text-xs focus:outline-none"
            placeholder={editing ? "What should change or be added? e.g. “make it 10 seconds with sound”, “from these references build 5 image + video nodes”, “delete this node”" : "Describe the flow to build…"}
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }}
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500">Ctrl+Enter to send · Ctrl+Z undoes</span>
            {chat.length > 0 && (
              <button type="button" className="ml-auto text-[11px] text-gray-400 hover:text-white" onClick={() => setChat([])} disabled={busy}>
                New chat
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={busy || !input.trim()}
              className={`${chat.length > 0 ? "" : "ml-auto "}px-3 py-1.5 rounded-lg font-semibold bg-violet-500/30 text-violet-100 border border-violet-400/40 hover:bg-violet-500/40 disabled:opacity-40`}
            >
              {busy ? (editing ? "Editing…" : "Building…") : (editing ? "Apply" : "Build")}
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
