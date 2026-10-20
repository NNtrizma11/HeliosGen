"use client";
/**
 * Two-column model picker (family list → variants flyout), rendered in a
 * portal so it is never clipped by the node, the canvas zoom or the screen
 * edge. Each variant shows its max resolution, duration range, capability
 * tags and an estimated credit cost, so models can be compared at a glance.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface PickerTag { label: string; title?: string; strong?: boolean }

export interface PickerModel {
  id: string;
  name: string;
  /** Family the model is grouped under in the left column (e.g. "Google", "Kling") */
  family: string;
  /** Short facts shown as chips: "1080p", "4–15s" */
  meta: string[];
  tags?: PickerTag[];
  /** Estimated credits for the current settings; null when unknown */
  credits?: number | null;
  /** True when the credit figure is a starter estimate rather than a measured charge */
  creditsEstimated?: boolean;
  /** Optional warning line under the model (e.g. inputs this model would drop) */
  warning?: string | null;
}

interface Props {
  /** Element the picker opens next to (the model pill) */
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  models: PickerModel[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderIcon?: (family: string) => React.ReactNode;
}

const COL_LEFT = 230;
const COL_RIGHT = 300;
const GAP = 8;
const MARGIN = 8;

export default function ModelPicker({ anchorRef, open, onClose, models, selectedId, onSelect, renderIcon }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const selectedFamily = models.find((m) => m.id === selectedId)?.family ?? models[0]?.family ?? "";
  const [family, setFamily] = useState(selectedFamily);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const families = useMemo(() => {
    const out: { name: string; count: number; meta: string }[] = [];
    for (const m of models) {
      let f = out.find((x) => x.name === m.family);
      if (!f) { f = { name: m.family, count: 0, meta: "" }; out.push(f); }
      f.count++;
    }
    for (const f of out) {
      const res = models.filter((m) => m.family === f.name).flatMap((m) => m.meta.filter((x) => /\d+p$|4k|2k/i.test(x)));
      const best = res.sort((a, b) => resRank(b) - resRank(a))[0];
      f.meta = `${f.count} model${f.count === 1 ? "" : "s"}${best ? ` · up to ${best}` : ""}`;
    }
    return out;
  }, [models]);

  // Reset to the current model's family each time the picker opens
  useEffect(() => {
    if (open) { setFamily(selectedFamily); setQuery(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Position next to the anchor, kept inside the viewport
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const width = Math.min(COL_LEFT + COL_RIGHT + 1, vw - MARGIN * 2);
      const spaceAbove = r.top - MARGIN - GAP;
      const spaceBelow = vh - r.bottom - MARGIN - GAP;
      const wanted = 460;
      const above = spaceAbove >= Math.min(wanted, 320) || spaceAbove >= spaceBelow;
      const maxHeight = Math.max(200, Math.min(wanted, above ? spaceAbove : spaceBelow));
      const left = Math.min(Math.max(MARGIN, r.left), vw - width - MARGIN);
      const top = above ? r.top - GAP - maxHeight : r.bottom + GAP;
      setPos({ left, top, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchorRef]);

  // Close on outside click, Escape, or when the canvas moves under the picker
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onWheel = (e: WheelEvent) => { if (!panelRef.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: true });
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
      clearTimeout(t);
    };
  }, [open, anchorRef, onClose]);

  if (!open || !pos || typeof document === "undefined") return null;

  const q = query.trim().toLowerCase();
  const visible = q
    ? models.filter((m) => `${m.name} ${m.family} ${m.meta.join(" ")} ${(m.tags ?? []).map((t) => t.label).join(" ")}`.toLowerCase().includes(q))
    : models.filter((m) => m.family === family);

  return createPortal(
    <div
      ref={panelRef}
      className="nowheel nodrag model-picker-pop"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        height: pos.maxHeight,
        width: Math.min(COL_LEFT + COL_RIGHT + 1, window.innerWidth - MARGIN * 2),
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        background: "#111622",
        border: "1px solid #232836",
        borderRadius: 14,
        boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
        overflow: "hidden",
        animation: "model-picker-in 120ms ease-out",
      }}
    >
      <style>{`@keyframes model-picker-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`}</style>
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/[0.06]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          className="flex-1 bg-transparent outline-none text-[12px] text-white placeholder:text-white/30"
        />
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Families */}
        {!q && (
          <div className="overflow-y-auto overscroll-contain shrink-0 py-1.5 border-r border-white/[0.06]" style={{ width: COL_LEFT }}>
            {families.map((f) => {
              const active = f.name === family;
              const holdsSelected = models.some((m) => m.family === f.name && m.id === selectedId);
              return (
                <button
                  key={f.name}
                  type="button"
                  onMouseEnter={() => setFamily(f.name)}
                  onClick={() => setFamily(f.name)}
                  className={`w-[calc(100%-12px)] mx-1.5 flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors ${active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}
                >
                  <span className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center bg-white/[0.06] text-white/70" style={{ lineHeight: 0 }}>
                    {renderIcon?.(f.name)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 text-[12px] text-white font-medium">
                      {f.name}
                      {holdsSelected && <span className="w-1.5 h-1.5 rounded-full bg-teal-400" title="Current model" />}
                    </span>
                    <span className="block text-[10px] text-white/40 truncate">{f.meta}</span>
                  </span>
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 1 5.5 4 2.5 7" /></svg>
                </button>
              );
            })}
          </div>
        )}

        {/* Variants */}
        <div className="flex-1 min-w-0 overflow-y-auto overscroll-contain py-1.5">
          {visible.length === 0 && <p className="px-4 py-6 text-[11px] text-white/40">No models match “{query}”.</p>}
          {visible.map((m) => {
            const active = m.id === selectedId;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onSelect(m.id); onClose(); }}
                className={`w-[calc(100%-12px)] mx-1.5 block text-left px-3 py-2 rounded-lg transition-colors ${active ? "bg-teal-500/10 ring-1 ring-teal-400/30" : "hover:bg-white/[0.05]"}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`flex-1 text-[12px] ${active ? "text-white font-semibold" : "text-white/85 font-medium"}`}>
                    {m.name}
                    {q && <span className="ml-1.5 text-[10px] font-normal text-white/35">{m.family}</span>}
                  </span>
                  {m.credits != null && (
                    <span
                      className="shrink-0 text-[10px] tabular-nums text-white/55"
                      title={m.creditsEstimated ? "Starter estimate (no charge recorded yet for these settings)" : "Based on your last real charge for these settings"}
                    >
                      ≈{Math.round(m.credits)} cr{m.creditsEstimated ? "*" : ""}
                    </span>
                  )}
                </span>
                {m.meta.length > 0 && (
                  <span className="flex flex-wrap gap-1 mt-1">
                    {m.meta.map((x) => (
                      <span key={x} className="px-1.5 rounded bg-white/[0.06] text-white/60 text-[10px] leading-[17px] tabular-nums">{x}</span>
                    ))}
                  </span>
                )}
                {!!m.tags?.length && (
                  <span className="flex flex-wrap gap-1 mt-1">
                    {m.tags.map((t) => (
                      <span key={t.label} title={t.title}
                        className={`px-1.5 rounded text-[9px] leading-[15px] ${t.strong ? "bg-teal-500/15 text-teal-200" : "bg-white/[0.04] text-white/45"}`}>
                        {t.label}
                      </span>
                    ))}
                  </span>
                )}
                {m.warning && <span className="block mt-1 text-[9.5px] text-amber-300/90">{m.warning}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function resRank(r: string): number {
  const s = r.toLowerCase();
  if (s === "4k") return 2160;
  if (s === "2k") return 1440;
  return parseInt(s, 10) || 0;
}

/** "4–15s", "8s", or null when the model has no duration choice. */
export function durationRange(durations: number[], fallback?: number): string | null {
  const d = durations.filter((x) => x > 0);
  if (d.length === 0) return fallback && fallback > 0 ? `${fallback}s` : null;
  const min = Math.min(...d), max = Math.max(...d);
  return min === max ? `${min}s` : `${min}–${max}s`;
}

/** Highest resolution in a list ("1080p", "4K"), or null. */
export function maxResolution(resolutions?: string[]): string | null {
  if (!resolutions?.length) return null;
  const best = [...resolutions].sort((a, b) => resRank(b) - resRank(a))[0];
  return best.toLowerCase() === "4k" ? "4K" : best;
}
