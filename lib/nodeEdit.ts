// ─────────────────────────────────────────────────────────────────────────────
// NODE EDIT — the chat edits nodes the user selected on the canvas.
//
//   1. snapshotTargets: selected canvas nodes → plain JSON the model can read
//   2. the model replies with an EditPlan (changes + deletions)
//   3. validateEdit: merged settings are checked with the flow builder rules
//   4. editToStoreOps: the plan becomes one store update (one undo step)
//
// Editing never runs a generation.
// ─────────────────────────────────────────────────────────────────────────────
import type { Node, Edge } from "@xyflow/react";
import type { NodeData } from "./store";
import { validatePlan, type PlanNode, type PlanNodeType, type ValidationResult } from "./flowBuilder";
import { VOICE_MODELS } from "./voiceConfig";
import { edgeStyle } from "./edgeStyles";

export const EDITABLE_NODE_TYPES: Record<string, PlanNodeType> = {
  generateNode: "image_gen",
  videoGeneratorNode: "video_gen",
  voiceNode: "voice",
  promptNode: "text",
  imageInputNode: "image_ref",
};

/** What the model sees for each selected node. */
export interface EditTarget {
  key: string;
  type: PlanNodeType;
  label: string;
  settings: Record<string, unknown>;
  prompt?: string;
  /** Incoming connections, e.g. "IMG 01 → startFrame" */
  inputs: string[];
}

/** Client-side bookkeeping for a target (not sent to the model). */
export interface TargetRef {
  key: string;
  nodeId: string;
  type: PlanNodeType;
  /** Text node feeding this node's prompt, if any */
  promptNodeId?: string;
  promptEdgeId?: string;
  /** That text node also feeds other nodes */
  promptShared?: boolean;
}

export interface EditChange {
  key: string;
  label?: string;
  settings?: Record<string, unknown>;
  prompt?: string;
}

export interface EditPlan {
  message?: string;
  problems?: string[];
  changes?: EditChange[];
  delete?: string[];
}

const defined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

function settingsOf(n: Node<NodeData>): Record<string, unknown> {
  const d = n.data;
  if (n.type === "generateNode") {
    return defined({ model: d.model ?? "nano-banana-2", aspectRatio: d.aspectRatio, quality: d.quality });
  }
  if (n.type === "videoGeneratorNode") {
    return defined({
      model: d.videoModel ?? "kling-3.0",
      aspectRatio: d.aspectRatio,
      duration: d.duration,
      mode: d.klingMode,
      resolution: d.grokResolution,
      sound: d.sound === true,
    });
  }
  if (n.type === "voiceNode") {
    return defined({ model: d.voiceModel ?? VOICE_MODELS[0].id, voice: d.voice, speed: d.speed });
  }
  return {};
}

export function snapshotTargets(
  ids: string[],
  nodes: Node<NodeData>[],
  edges: Edge[],
): { targets: EditTarget[]; refs: TargetRef[] } {
  const targets: EditTarget[] = [];
  const refs: TargetRef[] = [];
  const labelOf = (id: string) => String(nodes.find((n) => n.id === id)?.data.label ?? id);

  ids.forEach((id, i) => {
    const n = nodes.find((x) => x.id === id);
    const type = n?.type ? EDITABLE_NODE_TYPES[n.type] : undefined;
    if (!n || !type) return;
    const key = `n${i + 1}`;
    const incoming = edges.filter((e) => e.target === id);
    const ref: TargetRef = { key, nodeId: id, type };
    let prompt: string | undefined;

    if (type === "text") {
      prompt = String(n.data.prompt ?? "");
    } else if (type !== "image_ref") {
      const pe = incoming.find((e) => nodes.find((x) => x.id === e.source)?.type === "promptNode");
      if (pe) {
        ref.promptNodeId = pe.source;
        ref.promptEdgeId = pe.id;
        ref.promptShared = edges.filter((e) => e.source === pe.source).length > 1;
        prompt = String(nodes.find((x) => x.id === pe.source)?.data.prompt ?? "");
      } else {
        prompt = "";
      }
    }

    targets.push({
      key,
      type,
      label: String(n.data.label ?? id),
      settings: settingsOf(n),
      ...(prompt !== undefined ? { prompt } : {}),
      inputs: incoming
        .filter((e) => e.id !== ref.promptEdgeId)
        .map((e) => `${labelOf(e.source)} → ${e.targetHandle ?? "input"}`),
    });
    refs.push(ref);
  });
  return { targets, refs };
}

export const NODE_EDIT_RULES = `You edit EXISTING nodes on a visual canvas for AI image, video and voice generation. You never run anything.

You receive the nodes the user selected as JSON: key, type, label, settings, prompt (the full current prompt text) and inputs (connections, read-only).

Reply with ONE JSON object and nothing else (no markdown fences):
{
  "message": "one or two sentences telling the user what you changed (or answering their question)",
  "problems": [],
  "changes": [ { "key": "n1", "label": "optional new name", "settings": { "duration": 10 }, "prompt": "optional full new prompt" } ],
  "delete": []
}

Rules:
- Only include nodes you change, and only the fields you change. "settings" values use the names and values from the CATALOG.
- "prompt" REPLACES the whole prompt. When you edit a prompt, keep every part the user did not ask to change word for word, including its language.
- When you switch a model, also change any setting that the new model does not support to the closest valid value.
- Put a key in "delete" ONLY when the user clearly asks to delete or remove that node.
- Reference image nodes (type image_ref) can only be renamed or deleted.
- You cannot add nodes or connections here. If asked, put that in "problems" and suggest deselecting all nodes to use the builder.
- If the user only asks a question about the nodes, answer in "message" and return no changes.
- If the request is unclear or impossible, return no changes and explain in "problems".`;

export function validateEdit(targets: EditTarget[], plan: EditPlan): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map(targets.map((t) => [t.key, t]));

  for (const k of plan.delete ?? []) {
    if (!byKey.has(k)) errors.push(`Cannot delete "${k}": it is not one of the selected nodes.`);
  }

  const merged: PlanNode[] = [];
  for (const c of plan.changes ?? []) {
    const t = byKey.get(c.key);
    if (!t) { errors.push(`Change refers to "${c.key}", which is not one of the selected nodes.`); continue; }
    if (t.type === "image_ref" && (c.settings || c.prompt !== undefined)) {
      errors.push(`${t.label}: reference images can only be renamed or deleted.`);
      continue;
    }
    merged.push({
      key: t.key,
      type: t.type,
      label: c.label ?? t.label,
      settings: { ...t.settings, ...(c.settings ?? {}) },
      ...(t.type !== "image_ref" ? { prompt: [c.prompt ?? t.prompt ?? ""] } : {}),
    });
  }

  const v = validatePlan({ nodes: merged, edges: [] });
  return { errors: [...errors, ...v.errors], warnings: [...warnings, ...v.warnings] };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function settingsToData(type: PlanNodeType, s: Record<string, unknown>): Partial<NodeData> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(s, k);
  if (type === "image_gen") {
    if (has("model")) out.model = String(s.model);
    if (has("aspectRatio")) out.aspectRatio = String(s.aspectRatio);
    if (has("quality")) out.quality = String(s.quality);
  } else if (type === "video_gen") {
    if (has("model")) out.videoModel = String(s.model);
    if (has("aspectRatio")) out.aspectRatio = String(s.aspectRatio);
    if (has("duration")) out.duration = Number(s.duration);
    if (has("mode")) out.klingMode = String(s.mode);
    if (has("resolution")) out.grokResolution = String(s.resolution);
    if (has("sound")) out.sound = s.sound === true;
  } else if (type === "voice") {
    if (has("model")) out.voiceModel = String(s.model);
    if (has("voice")) out.voice = String(s.voice);
    if (has("speed")) out.speed = Number(s.speed);
  }
  return out as Partial<NodeData>;
}

/** Turn a validated plan into one store edit. */
export function editToStoreOps(plan: EditPlan, refs: TargetRef[], nodes: Node<NodeData>[]) {
  const updates: Array<{ id: string; data: Partial<NodeData> }> = [];
  const addNodes: Node<NodeData>[] = [];
  const addEdges: Edge[] = [];
  const removeEdgeIds: string[] = [];
  const byKey = new Map(refs.map((r) => [r.key, r]));
  const removeNodeIds = (plan.delete ?? []).map((k) => byKey.get(k)?.nodeId).filter((x): x is string => !!x);
  const changed: string[] = [];

  for (const c of plan.changes ?? []) {
    const r = byKey.get(c.key);
    if (!r || removeNodeIds.includes(r.nodeId)) continue;
    const data: Partial<NodeData> = { ...settingsToData(r.type, c.settings ?? {}) };
    if (c.label) data.label = c.label;

    if (c.prompt !== undefined && r.type !== "image_ref") {
      if (r.type === "text") {
        data.prompt = c.prompt;
      } else if (r.promptNodeId && !r.promptShared) {
        updates.push({ id: r.promptNodeId, data: { prompt: c.prompt } });
      } else {
        // No prompt node yet, or one shared with other nodes: give this node its own.
        const node = nodes.find((n) => n.id === r.nodeId);
        const label = String(c.label ?? node?.data.label ?? "NODE");
        const tid = `promptNode-${uid()}`;
        addNodes.push({
          id: tid,
          type: "promptNode",
          position: { x: (node?.position.x ?? 0) - 470, y: node?.position.y ?? 0 },
          style: { width: 420, height: 240 },
          data: { label: `${label} PROMPT`, status: "idle", prompt: c.prompt },
        });
        if (r.promptEdgeId) removeEdgeIds.push(r.promptEdgeId);
        addEdges.push({
          id: `e-${uid()}`, source: tid, target: r.nodeId, sourceHandle: null, targetHandle: "prompt",
          animated: false, style: edgeStyle("prompt"),
        });
      }
    }
    if (Object.keys(data).length) updates.push({ id: r.nodeId, data });
    changed.push(r.nodeId);
  }

  return { updates, removeNodeIds, removeEdgeIds, addNodes, addEdges, changedIds: changed };
}
