"use client";
import { useEffect, useRef } from "react";
import type { Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useCostStore, nodeEstimate } from "@/lib/nodeCost";
import { creditsToUsd, formatCredits, formatUsd } from "@/lib/pricing";

/** Small credit estimate shown under a generator node. */
export default function CostBubble({ id }: { id: string }) {
  const perUnit = useCostStore((s) => s.perUnit);
  const load = useCostStore((s) => s.load);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const node = nodes.find((n) => n.id === id) as Node<NodeData> | undefined;
  const lastCredits = node?.data.lastCredits as number | undefined;

  useEffect(() => { load(); }, [load]);
  // A fresh real charge on this node: refresh the shared estimates right away.
  const seenCredits = useRef(lastCredits);
  useEffect(() => {
    if (lastCredits !== undefined && lastCredits !== seenCredits.current) {
      seenCredits.current = lastCredits;
      load(true);
    }
  }, [lastCredits, load]);

  if (!node) return null;
  const est = nodeEstimate(node, nodes as Node<NodeData>[], edges, perUnit);
  if (!est) return null;

  const label = est.credits === null ? "? cr" : `${est.source === "starter" ? "~" : ""}${formatCredits(est.credits)}`;
  const title = [
    est.credits === null
      ? "No price known yet for these settings. It is recorded after the first run."
      : `${est.source === "measured" ? "Based on the last real charge" : "Starting estimate"}: ${formatCredits(est.credits)} ≈ ${formatUsd(creditsToUsd(est.credits))}`,
    lastCredits !== undefined ? `Last run charged ${formatCredits(lastCredits)} ≈ ${formatUsd(creditsToUsd(lastCredits))}` : "",
  ].filter(Boolean).join("\n");

  return (
    <div
      className="absolute pointer-events-auto select-none text-[10px] leading-none px-1.5 py-1 rounded-full"
      style={{
        bottom: -22,
        right: 4,
        background: "rgba(20,20,20,0.85)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: est.credits === null ? "#888" : "#c4b5fd",
        zIndex: 10,
      }}
      title={title}
    >
      {label}
    </div>
  );
}
