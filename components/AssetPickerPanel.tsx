"use client";
// Canvas asset picker: opened from the left toolbar; a click drops the asset as a
// reference node in the middle of the current view.
import { useEffect, useMemo, useState } from "react";
import { Panel, useReactFlow } from "@xyflow/react";
import { useAssetStore, brandList, matches, CATEGORIES, type Asset } from "@/lib/assets";
import { useWorkflowStore } from "@/lib/store";

export default function AssetPickerPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { assets, loaded, loading, error, load } = useAssetStore();
  const addNode = useWorkflowStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  const [brand, setBrand] = useState("All");
  const [category, setCategory] = useState("All");
  const [q, setQ] = useState("");
  const [count, setCount] = useState(0);

  useEffect(() => { if (open) load(); }, [open, load]);
  const brands = useMemo(() => brandList(assets).filter((b) => assets.some((a) => a.brand === b)), [assets]);
  const shown = useMemo(
    () => assets.filter((a) => (brand === "All" || a.brand === brand) && (category === "All" || a.category === category) && matches(a, q)),
    [assets, brand, category, q],
  );

  if (!open) return null;

  const place = (a: Asset) => {
    const isVideo = (a.mime ?? "").startsWith("video/");
    const type = isVideo ? "videoInputNode" : "imageInputNode";
    // Middle of the screen, nudged so repeated clicks don't stack exactly
    const c = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const offset = (count % 6) * 40;
    setCount((n) => n + 1);
    addNode({
      id: `${type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      position: { x: c.x - 110 + offset, y: c.y - 110 + offset },
      style: { width: 220 },
      data: isVideo
        ? { label: a.name, status: "idle", videoUrl: a.url, r2Url: a.url }
        : { label: a.name, status: "idle", inputImage: a.url, r2Url: a.url, ...(a.width && a.height ? { imageNaturalRatio: `${a.width} / ${a.height}` } : {}) },
    });
  };

  const pill = (on: boolean) => `px-2 h-6 rounded-full text-[10px] whitespace-nowrap border ${on ? "bg-white/10 border-white/25 text-white" : "border-white/10 text-white/50 hover:text-white"}`;

  return (
    <Panel position="top-left" style={{ marginLeft: 70, marginTop: 70 }}>
      <div
        className="nodrag nowheel flex flex-col w-[320px] max-w-[80vw] h-[65vh] rounded-2xl border border-white/10 bg-[#111]/95 backdrop-blur shadow-2xl text-sm text-gray-200"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/10">
          <span className="font-semibold">Assets</span>
          <a href="/assets" target="_blank" className="text-[11px] text-white/40 hover:text-white">manage ↗</a>
          <button type="button" className="ml-auto text-gray-400 hover:text-white" onClick={onClose}>✕</button>
        </div>
        <div className="px-3 py-2 space-y-1.5 border-b border-white/[0.06]">
          <input className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 px-2 py-1 text-xs focus:outline-none" placeholder="Search, e.g. mango pouch" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex gap-1 overflow-x-auto pb-0.5">
            <button className={pill(brand === "All")} onClick={() => setBrand("All")}>All</button>
            {brands.map((b) => <button key={b} className={pill(brand === b)} onClick={() => setBrand(b)}>{b}</button>)}
          </div>
          <div className="flex gap-1 overflow-x-auto pb-0.5">
            <button className={pill(category === "All")} onClick={() => setCategory("All")}>All types</button>
            {CATEGORIES.map((c) => <button key={c} className={pill(category === c)} onClick={() => setCategory(c)}>{c}</button>)}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 grid grid-cols-3 gap-1.5 content-start">
          {shown.map((a) => (
            <button key={a.id} title={`${a.name}: click to add`} onClick={() => place(a)}
              className="group relative aspect-square rounded-lg overflow-hidden bg-black/40 border border-white/[0.06] hover:border-teal-400/60">
              {(a.mime ?? "").startsWith("video/")
                ? <video src={a.url} muted preload="metadata" className="absolute inset-0 w-full h-full object-contain" />
                // eslint-disable-next-line @next/next/no-img-element
                : <img src={a.url} alt={a.name} loading="lazy" className="absolute inset-0 w-full h-full object-contain p-1" />}
              <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-[9px] leading-tight text-left bg-black/70 truncate opacity-0 group-hover:opacity-100">{a.name}</span>
            </button>
          ))}
          {loaded && assets.length === 0 && (
            <div className="col-span-3 text-xs text-white/45 p-3 text-center">No assets yet. Upload packaging and product shots under <a href="/assets" target="_blank" className="underline">Assets</a>.</div>
          )}
          {loaded && assets.length > 0 && shown.length === 0 && <div className="col-span-3 text-xs text-white/40 p-3 text-center">Nothing matches.</div>}
          {loading && !loaded && <div className="col-span-3 text-xs text-white/40 p-3 text-center">Loading…</div>}
          {error && <div className="col-span-3 text-xs text-red-300 p-3">{error}</div>}
        </div>
        <div className="px-3 py-1.5 text-[10px] text-white/35 border-t border-white/[0.06]">Click an asset to add it as a reference node.</div>
      </div>
    </Panel>
  );
}
