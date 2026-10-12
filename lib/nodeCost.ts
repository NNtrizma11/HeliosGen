"use client";
// Cost estimates for canvas nodes, plus a small shared cache of measured prices.
import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import type { NodeData } from "./store";
import { IMAGE_MODELS, VIDEO_MODELS } from "./modelConfig";
import { DEFAULT_VOICE_MODEL } from "./voiceConfig";
import { resolveInputs } from "./executor";
import { createClient } from "./supabase/client";
import {
  imageCostSpec,
  videoCostSpec,
  videoTier,
  audioCostSpec,
  estimate,
  type CostSpec,
  type Estimate,
} from "./pricing";

export const COSTED_NODE_TYPES = new Set(["generateNode", "videoGeneratorNode", "voiceNode"]);

/** The billing spec for the job this node would run with its current settings. */
export function nodeCostSpec(node: Node<NodeData>, nodes: Node<NodeData>[], edges: Edge[]): CostSpec | null {
  const d = node.data;
  if (node.type === "generateNode") {
    const model = (d.model as string | undefined) ?? "nano-banana-2";
    const cfg = IMAGE_MODELS.find((m) => m.id === model);
    return imageCostSpec(model, d.quality as string | undefined, cfg);
  }
  if (node.type === "videoGeneratorNode") {
    const model = (d.videoModel as string | undefined) ?? "kling-3.0";
    const cfg = VIDEO_MODELS.find((m) => m.id === model);
    const mode = (d.klingMode as string | undefined) ?? cfg?.defaultMode;
    const resolution = (d.grokResolution as string | undefined) ?? cfg?.defaultResolution;
    const sound = cfg?.sound ? Boolean(d.sound) : false;
    const duration = (d.duration as number | undefined) ?? cfg?.defaultDuration;
    return videoCostSpec(model, videoTier(cfg, mode, resolution), sound, duration);
  }
  if (node.type === "voiceNode") {
    const text = resolveInputs(node.id, nodes, edges).prompt ?? "";
    return audioCostSpec((d.voiceModel as string | undefined) ?? DEFAULT_VOICE_MODEL, text.length);
  }
  return null;
}

// ── Measured prices cache ────────────────────────────────────────────────────

interface CostStore {
  perUnit: Record<string, number> | null;
  loadedAt: number;
  loading: boolean;
  load: (force?: boolean) => Promise<void>;
}

export const useCostStore = create<CostStore>()((set, get) => ({
  perUnit: null,
  loadedAt: 0,
  loading: false,
  load: async (force = false) => {
    const { loading, loadedAt } = get();
    if (loading || (!force && Date.now() - loadedAt < 60_000)) return;
    set({ loading: true });
    try {
      const { data } = await createClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/costs/estimates", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const json = (await res.json()) as { perUnit?: Record<string, number> };
      set({ perUnit: json.perUnit ?? {}, loadedAt: Date.now() });
    } catch {
      // offline or signed out — keep the previous values
    } finally {
      set({ loading: false });
    }
  },
}));

export function nodeEstimate(node: Node<NodeData>, nodes: Node<NodeData>[], edges: Edge[], perUnit: Record<string, number> | null): Estimate | null {
  const spec = nodeCostSpec(node, nodes, edges);
  return spec ? estimate(spec, perUnit) : null;
}

/** Current Kie balance in credits, or null if it can't be read. */
export async function fetchKieBalance(): Promise<number | null> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch("/api/credit", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    const j = await res.json();
    const v = typeof j?.data === "number" ? j.data : (j?.data?.balance ?? j?.balance ?? null);
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}
