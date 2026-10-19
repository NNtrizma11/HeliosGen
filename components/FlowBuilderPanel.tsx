"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";
import { planToGraph, type FlowPlan, type ValidationResult, type PlanNode } from "@/lib/flowBuilder";
import { IMAGE_MODELS, VIDEO_MODELS } from "@/lib/modelConfig";
import { VOICES } from "@/lib/voiceConfig";
import { EDITABLE_NODE_TYPES, snapshotTargets, editToStoreOps, addToGraph, type EditPlan } from "@/lib/nodeEdit";

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

export default function FlowBuilderPanel() {
  const insertFlow = useWorkflowStore((s) => s.insertFlow);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const applyNodeEdit = useWorkflowStore((s) => s.applyNodeEdit);
  const nodes = useWorkflowStore((s) => s.nodes);
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
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { setRules(localStorage.getItem(RULES_KEY) ?? ""); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(RULES_KEY, rules); } catch { /* storage unavailable */ }
  }, [rules]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat, busy]);

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
    for (const imp of graph.imports) {
      fetch("/api/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: imp.url }),
      })
        .then((r) => r.json())
        .then((j: { cdnUrl?: string }) => {
          if (j.cdnUrl) updateNodeData(imp.nodeId, { r2Url: j.cdnUrl, inputImage: j.cdnUrl });
        })
        .catch(() => { /* keep the original URL */ });
    }
    return graph;
  }, [insertFlow, updateNodeData, fitView]);

  const sendEdit = useCallback(async (text: string, token: string) => {
    const state = useWorkflowStore.getState();
    const ids = attachedNodes.map((n) => n.id);
    const { targets, refs } = snapshotTargets(ids, state.nodes, state.edges);
    const names = targets.map((t) => t.label).join(", ");
    setChat((c) => [...c, { role: "user", edit: true, content: `[Editing ${names}] ${text}` }]);

    const res = await fetch("/api/flow-builder", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mode: "edit", targets, rules, messages: [{ role: "user", content: text }] }),
    });
    const json = (await res.json()) as { edit?: EditPlan; validation?: { errors: string[]; warnings: string[] }; error?: string };
    if (!res.ok || !json.edit) throw new Error(json.error ?? "The edit failed.");

    const { edit, validation } = json;
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
    if (added) {
      setTimeout(() => fitView({ nodes: added.nodes.map((n) => ({ id: n.id })), padding: 0.1, duration: 600 }), 100);
      for (const imp of added.imports) {
        fetch("/api/fetch-url", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ url: imp.url }),
        })
          .then((r) => r.json())
          .then((j: { cdnUrl?: string }) => { if (j.cdnUrl) updateNodeData(imp.nodeId, { r2Url: j.cdnUrl, inputImage: j.cdnUrl }); })
          .catch(() => { /* keep the original URL */ });
      }
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
        ...(validation?.warnings ?? []).map((w) => `Warning: ${w}`),
        "Nothing was generated. Ctrl+Z undoes this edit.",
      ],
    }]);
  }, [attachedNodes, rules, applyNodeEdit, fitView, updateNodeData]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    const { data: authData } = await createClient().auth.getSession();
    if (!authData.session) { setAuthModalOpen(true); return; }
    const token = authData.session.access_token;

    if (editing) {
      setInput("");
      setBusy(true);
      try {
        await sendEdit(text, token);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setChat((c) => [...c, { role: "assistant", tone: "error", edit: true, content: `Error: ${msg}`, details: [msg] }]);
      } finally {
        setBusy(false);
      }
      return;
    }

    const next: ChatEntry[] = [...chat, { role: "user", content: text }];
    setChat(next);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/flow-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: next.filter((m) => !m.content.startsWith("[Editing ") && !m.edit).map(({ role, content }) => ({ role, content })), rules }),
      });
      const json = (await res.json()) as { plan?: FlowPlan; validation?: ValidationResult; error?: string };
      if (!res.ok || !json.plan) throw new Error(json.error ?? "The builder failed.");

      const { plan, validation } = json;
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
      const textCount = graph.nodes.length - plan.nodes.length;
      setChat((c) => [...c, {
        role: "assistant",
        tone: "ok",
        content: `${plan.message ?? "Built the flow."} Created ${plan.nodes.length} nodes and ${graph.edges.length} connections.`,
        details: [
          `${plan.nodes.length} nodes${textCount > 0 ? ` (+${textCount} prompt text nodes)` : ""}, ${graph.edges.length} connections. Nothing was generated.`,
          ...plan.nodes.map((n) => `✓ ${describe(n)}`),
          ...(plan.notes ?? []).map((n) => `Note: ${n}`),
          ...(validation?.warnings ?? []).map((w) => `Warning: ${w}`),
        ],
      }]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setChat((c) => [...c, { role: "assistant", tone: "error", content: `Error: ${msg}`, details: [msg] }]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, chat, rules, build, setAuthModalOpen, editing, sendEdit]);

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
          {busy && <div className="text-xs text-amber-300 animate-pulse">{editing ? "Working on the selected nodes… adding many nodes can take a minute or two." : "Planning the flow… long requests can take a minute or two."}</div>}
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
