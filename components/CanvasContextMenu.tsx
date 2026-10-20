"use client";
/**
 * Right-click menu for the canvas. One component for both cases:
 * on a node (copy, paste, duplicate, layer order, lock, delete…) and on empty
 * canvas (paste, add a node here, select all, fit view, unlock all).
 * Rendered in a portal and kept inside the viewport.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  submenu?: MenuItem[];
}
export type MenuEntry = MenuItem | "divider";

interface Props {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** "⌘C" on Mac, "Ctrl+C" elsewhere. Pass the key part only. */
export function mod(key: string, shift = false): string {
  return isMac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

export default function CanvasContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top = Math.min(y, window.innerHeight - r.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const blockNative = (e: MouseEvent) => { if (ref.current?.contains(e.target as Node)) e.preventDefault(); };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("contextmenu", blockNative);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("contextmenu", blockNative);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 10001 }}>
      <MenuList items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}

function MenuList({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <div
      role="menu"
      className="min-w-[220px] py-1.5 rounded-xl border border-white/[0.08] shadow-2xl"
      style={{ background: "#151922", animation: "ctx-menu-in 100ms ease-out" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <style>{`@keyframes ctx-menu-in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}`}</style>
      {items.map((it, i) => {
        if (it === "divider") return <div key={`d${i}`} className="my-1.5 mx-3 h-px bg-white/[0.07]" />;
        const hasSub = !!it.submenu?.length;
        return (
          <div key={it.label} className="relative" onMouseEnter={() => setOpenSub(hasSub ? i : null)}>
            <button
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                if (hasSub) { setOpenSub(i); return; }
                it.onClick?.();
                onClose();
              }}
              className={`w-[calc(100%-12px)] mx-1.5 flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-left text-[12.5px] transition-colors disabled:opacity-35 disabled:pointer-events-none ${
                it.danger ? "text-red-300 hover:bg-red-500/10" : "text-white/85 hover:bg-white/[0.06]"
              } ${openSub === i ? "bg-white/[0.06]" : ""}`}
            >
              {it.icon && <span className="w-4 shrink-0 flex justify-center text-white/50">{it.icon}</span>}
              <span className="flex-1">{it.label}</span>
              {it.shortcut && (
                <kbd className="text-[10.5px] font-sans text-white/40 px-1.5 py-0.5 rounded-md bg-white/[0.05]">{it.shortcut}</kbd>
              )}
              {hasSub && (
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 1 5.5 4 2.5 7" /></svg>
              )}
            </button>
            {hasSub && openSub === i && <SubMenu items={it.submenu!} onClose={onClose} />}
          </div>
        );
      })}
    </div>
  );
}

/** Flyout to the right, or to the left when there is no room. */
function SubMenu({ items, onClose }: { items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"right" | "left">("right");
  const [shiftY, setShiftY] = useState(0);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    if (r.right > window.innerWidth - 8) setSide("left");
    if (r.bottom > window.innerHeight - 8) setShiftY(window.innerHeight - 8 - r.bottom);
  }, []);
  return (
    <div
      ref={ref}
      className="absolute"
      style={{ top: -6 + shiftY, ...(side === "right" ? { left: "100%", paddingLeft: 4 } : { right: "100%", paddingRight: 4 }) }}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
