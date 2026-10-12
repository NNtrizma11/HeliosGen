// Planning for staged mass generation: which nodes run, which are skipped and why, and the cost.
import type { Node, Edge } from "@xyflow/react";
import type { NodeData } from "./store";
import { VIDEO_MODELS } from "./modelConfig";
import { resolveInputs } from "./executor";
import { nodeEstimate } from "./nodeCost";

export type BatchStage = "images" | "videos" | "voice";

export const STAGE_NODE_TYPE: Record<BatchStage, string> = {
  images: "generateNode",
  videos: "videoGeneratorNode",
  voice: "voiceNode",
};

export interface BatchItem {
  id: string;
  label: string;
  credits: number | null;
  measured: boolean;
}

export interface BatchPlan {
  run: BatchItem[];
  alreadyDone: BatchItem[];
  blocked: Array<{ id: string; label: string; reason: string }>;
  /** Sum of known estimates for the nodes that will run */
  credits: number;
  unknownCount: number;
}

function hasOutput(n: Node<NodeData>): boolean {
  return !!(n.data.imageUrl || n.data.videoUrl || n.data.audioUrl);
}

function sortKey(n: Node<NodeData>): string {
  // Natural order by label number when present (IMG 02 before IMG 10), then by position
  const label = String(n.data.label ?? "");
  return label.replace(/\d+/g, (d) => d.padStart(6, "0"));
}

export function orderNodes(list: Node<NodeData>[]): Node<NodeData>[] {
  return [...list].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.position.y - b.position.y || a.position.x - b.position.x;
  });
}

export function planBatch(
  stage: BatchStage,
  scope: Node<NodeData>[],
  allNodes: Node<NodeData>[],
  edges: Edge[],
  perUnit: Record<string, number> | null,
  redo: boolean,
): BatchPlan {
  const type = STAGE_NODE_TYPE[stage];
  const candidates = orderNodes(scope.filter((n) => n.type === type && !n.data.locked));
  const plan: BatchPlan = { run: [], alreadyDone: [], blocked: [], credits: 0, unknownCount: 0 };

  for (const n of candidates) {
    const label = String(n.data.label ?? n.id);
    const status = n.data.status as string | undefined;
    if (status === "pending" || status === "running") {
      plan.blocked.push({ id: n.id, label, reason: "already generating" });
      continue;
    }

    const inputs = resolveInputs(n.id, allNodes, edges);
    const incoming = edges.filter((e) => e.target === n.id);
    let reason = "";

    if (stage === "videos") {
      const cfg = VIDEO_MODELS.find((m) => m.id === ((n.data.videoModel as string | undefined) ?? "kling-3.0"));
      if (!cfg?.promptOptional && !inputs.prompt?.trim()) reason = "no prompt";
      else if (incoming.some((e) => e.targetHandle === "startFrame") && !inputs.startFrameUrl) reason = "start frame image not generated yet";
      else if (incoming.some((e) => e.targetHandle === "endFrame") && !inputs.endFrameUrl) reason = "end frame image not generated yet";
      else if (cfg?.requiredHandles?.some((h) => !incoming.some((e) => e.targetHandle === h))) reason = "a required input is not connected";
    } else if (stage === "images") {
      if (!inputs.prompt?.trim()) reason = "no prompt";
      else if (incoming.filter((e) => e.targetHandle === "image").length > inputs.imageUrls.length) reason = "a reference image is still empty";
    } else if (!inputs.prompt?.trim()) {
      reason = "no script";
    }

    if (reason) { plan.blocked.push({ id: n.id, label, reason }); continue; }

    const est = nodeEstimate(n, allNodes, edges, perUnit);
    const item: BatchItem = { id: n.id, label, credits: est?.credits ?? null, measured: est?.source === "measured" };
    if (hasOutput(n) && !redo) { plan.alreadyDone.push(item); continue; }

    plan.run.push(item);
    if (item.credits === null) plan.unknownCount += 1;
    else plan.credits += item.credits;
  }
  return plan;
}
