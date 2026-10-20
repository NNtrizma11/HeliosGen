"use client";
/**
 * Collapsible output-handle stack for nodes with several typed outputs
 * (video nodes: first frame, last frame, picked frame, video, audio).
 *
 * At rest every output sits on one spot at the node's right edge and shows a
 * single generic output bubble, so the node reads like "inputs on the left,
 * one output on the right". Hovering that bubble fans the typed outputs out
 * so the right one can be dragged. Edges keep their typed source handle ids,
 * so nothing about how data flows changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateNodeInternals } from "@xyflow/react";

const CLOSE_DELAY = 350;   // ms after the pointer leaves before the stack folds
const MOVE_MS = 160;       // must match the CSS transition on `top`

export function useOutputStack(nodeId: string) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateNodeInternals = useUpdateNodeInternals();

  const enter = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setOpen(true);
  }, []);
  const leave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  }, []);

  // Handles moved: let React Flow re-measure them so edges follow
  useEffect(() => {
    updateNodeInternals(nodeId);
    const t = setTimeout(() => updateNodeInternals(nodeId), MOVE_MS + 20);
    return () => clearTimeout(t);
  }, [open, nodeId, updateNodeInternals]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** Inline `top` for an output handle: its own slot when open, the shared spot when folded. */
  const top = (offsetPx: number) => `calc(50% + ${open ? offsetPx : 0}px)`;

  return { open, enter, leave, top };
}

/** Generic "output" arrow shown on the folded stack. */
export function OutputStackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#9AA4B8" }}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}
