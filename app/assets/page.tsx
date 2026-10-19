"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAssetStore, brandList, matches, CATEGORIES, type Asset } from "@/lib/assets";
import { useWorkflowStore } from "@/lib/store";

const field = "w-full rounded-lg bg-[#1a1a1a] border border-white/10 px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-white/25";
const chip = (on: boolean) =>
  `px-3 h-8 rounded-full text-xs whitespace-nowrap border transition-colors ${on ? "bg-white/10 border-white/25 text-white" : "border-white/10 text-white/55 hover:text-white hover:border-white/20"}`;

/** Brand picker that also allows typing a new brand. */
function BrandInput({ value, onChange, brands }: { value: string; onChange: (v: string) => void; brands: string[] }) {
  return (
    <>
      <input list="asset-brands" className={field} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Brand" />
      <datalist id="asset-brands">{brands.map((b) => <option key={b} value={b} />)}</datalist>
    </>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1116] p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="ml-auto text-white/40 hover:text-white" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Preview({ a, className }: { a: Asset; className?: string }) {
  return (a.mime ?? "").startsWith("video/")
    ? <video src={a.url} muted loop playsInline preload="metadata" className={className} onMouseEnter={(e) => e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
    // eslint-disable-next-line @next/next/no-img-element
    : <img src={a.url} alt={a.name} loading="lazy" className={className} />;
}

export default function AssetsPage() {
  const router = useRouter();
  const { assets, loaded, loading, error, load, upload, update, remove } = useAssetStore();
  const spaces = useWorkflowStore((s) => s.spaces);

  const [brand, setBrand] = useState<string>("All");
  const [category, setCategory] = useState<string>("All");
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<File[] | null>(null);
  const [upMeta, setUpMeta] = useState({ brand: "Nutrizma", category: "Packaging", tags: "" });
  const [progress, setProgress] = useState<{ done: number; total: number; failed: string[] } | null>(null);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [placing, setPlacing] = useState<Asset | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, [load]);

  const brands = useMemo(() => brandList(assets), [assets]);
  const shown = useMemo(
    () => assets.filter((a) => (brand === "All" || a.brand === brand) && (category === "All" || a.category === category) && matches(a, q)),
    [assets, brand, category, q],
  );
  const countFor = (b: string) => assets.filter((a) => a.brand === b).length;

  const pick = (files: FileList | File[] | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!list.length) return;
    setUpMeta((m) => ({ ...m, brand: brand !== "All" ? brand : m.brand, category: category !== "All" ? category : m.category }));
    setPending(list);
  };

  const startUpload = async () => {
    if (!pending) return;
    const files = pending;
    const tags = upMeta.tags.split(",").map((t) => t.trim()).filter(Boolean);
    setPending(null);
    setProgress({ done: 0, total: files.length, failed: [] });
    // Three at a time keeps it quick without flooding the server
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const f = files[i++];
        try { await upload(f, { brand: upMeta.brand.trim() || "Nutrizma", category: upMeta.category, tags }); }
        catch { setProgress((p) => p && { ...p, failed: [...p.failed, f.name] }); }
        setProgress((p) => p && { ...p, done: p.done + 1 });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setTimeout(() => setProgress((p) => (p && !p.failed.length ? null : p)), 2500);
  };

  /** Put the asset on a canvas as a reference-image node and open it. */
  const placeOnCanvas = (a: Asset, spaceId: string) => {
    const st = useWorkflowStore.getState();
    st.switchSpace(spaceId);
    const nodes = useWorkflowStore.getState().nodes;
    let maxX = 0, minY = 0;
    nodes.forEach((n, i) => {
      const w = (n.measured?.width ?? (n.style?.width as number | undefined) ?? 300);
      maxX = i ? Math.max(maxX, n.position.x + w) : n.position.x + w;
      minY = i ? Math.min(minY, n.position.y) : n.position.y;
    });
    const isVideo = (a.mime ?? "").startsWith("video/");
    const type = isVideo ? "videoInputNode" : "imageInputNode";
    useWorkflowStore.getState().addNode({
      id: `${type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      position: nodes.length ? { x: maxX + 120, y: minY } : { x: 0, y: 0 },
      style: { width: 220 },
      data: isVideo
        ? { label: a.name, status: "idle", videoUrl: a.url, r2Url: a.url }
        : { label: a.name, status: "idle", inputImage: a.url, r2Url: a.url, ...(a.width && a.height ? { imageNaturalRatio: `${a.width} / ${a.height}` } : {}) },
    });
    setPlacing(null);
    router.push(`/workflow/${spaceId}`);
  };

  const ownSpaces = spaces.filter((s) => !s.ownerId && s.nodes.length > 0)
    .sort((x, y) => (y.updatedAt ?? y.createdAt) - (x.updatedAt ?? x.createdAt));

  return (
    <div
      className="h-full overflow-y-auto relative"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files); }}
    >
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Assets</h1>
            <p className="text-xs text-white/45 mt-1">
              Packaging, product shots, logos and characters for every brand. Shared with your team, usable on any canvas and by Build with AI.
            </p>
          </div>
          <button onClick={() => fileRef.current?.click()} className="ml-auto h-9 px-4 rounded-lg text-sm font-semibold bg-teal-500/20 text-teal-100 border border-teal-400/40 hover:bg-teal-500/30">
            ＋ Upload
          </button>
          <input ref={fileRef} type="file" multiple accept="image/*,video/*" className="hidden" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        </div>

        {/* Filters */}
        <div className="space-y-2.5">
          <div className="flex gap-2 overflow-x-auto pb-1">
            <button className={chip(brand === "All")} onClick={() => setBrand("All")}>All brands · {assets.length}</button>
            {brands.map((b) => (
              <button key={b} className={chip(brand === b)} onClick={() => setBrand(b)}>{b} · {countFor(b)}</button>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <button className={chip(category === "All")} onClick={() => setCategory("All")}>All types</button>
            {CATEGORIES.map((c) => <button key={c} className={chip(category === c)} onClick={() => setCategory(c)}>{c}</button>)}
            <input className={`${field} max-w-xs ml-auto`} placeholder="Search name or tag, e.g. strawberry pouch" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>

        {progress && (
          <div className="rounded-lg bg-white/5 px-3 py-2 text-xs text-white/70">
            Uploading {progress.done}/{progress.total}…{progress.failed.length ? ` Failed: ${progress.failed.join(", ")}` : ""}
            {progress.done === progress.total && progress.failed.length > 0 && (
              <button className="ml-3 underline" onClick={() => setProgress(null)}>dismiss</button>
            )}
          </div>
        )}
        {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div>}

        {/* Grid */}
        {loaded && assets.length === 0 ? (
          <button onClick={() => fileRef.current?.click()} className="w-full rounded-2xl border border-dashed border-white/15 py-20 text-center text-white/50 hover:border-white/30 hover:text-white/80">
            <div className="text-3xl mb-2">⬆</div>
            Drop packaging, product shots and logos here, or click to upload.
            <div className="text-xs text-white/35 mt-1">Tip: name files like “strawberry-pouch-front.png”. The name becomes the asset name.</div>
          </button>
        ) : (
          <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
            {shown.map((a) => (
              <div key={a.id} className="group rounded-xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                <div className="relative aspect-square bg-[repeating-conic-gradient(#15171c_0%_25%,#101216_0%_50%)] bg-[length:16px_16px]">
                  <Preview a={a} className="absolute inset-0 w-full h-full object-contain p-2" />
                  <div className="absolute inset-x-0 bottom-0 p-1.5 flex gap-1 justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-t from-black/80 to-transparent">
                    <button className="px-2 h-7 rounded-md text-[11px] bg-teal-500/30 text-teal-50 hover:bg-teal-500/45" onClick={() => setPlacing(a)}>Add to canvas</button>
                    <button className="px-2 h-7 rounded-md text-[11px] bg-white/15 hover:bg-white/25" onClick={() => navigator.clipboard.writeText(a.url).then(() => { setCopied(a.id); setTimeout(() => setCopied(null), 1500); })}>{copied === a.id ? "Copied" : "Copy URL"}</button>
                    <button className="px-2 h-7 rounded-md text-[11px] bg-white/15 hover:bg-white/25" onClick={() => setEditing(a)}>Edit</button>
                  </div>
                </div>
                <div className="px-2.5 py-2">
                  <div className="text-xs font-medium truncate" title={a.name}>{a.name}</div>
                  <div className="text-[10px] text-white/40 truncate">{a.brand} · {a.category}{a.width ? ` · ${a.width}×${a.height}` : ""}</div>
                  {a.tags.length > 0 && <div className="text-[10px] text-white/55 truncate mt-0.5">{a.tags.map((t) => `#${t}`).join(" ")}</div>}
                </div>
              </div>
            ))}
            {loaded && shown.length === 0 && <div className="col-span-full text-sm text-white/40 py-10 text-center">No assets match these filters.</div>}
            {loading && !loaded && <div className="col-span-full text-sm text-white/40 py-10 text-center">Loading…</div>}
          </div>
        )}
      </div>

      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-teal-500/10 border-2 border-dashed border-teal-400/60">
          <div className="text-lg font-semibold text-teal-100">Drop to add to Assets</div>
        </div>
      )}

      {pending && (
        <Modal title={`Upload ${pending.length} file${pending.length === 1 ? "" : "s"}`} onClose={() => setPending(null)}>
          <div className="text-xs text-white/50 max-h-20 overflow-y-auto">{pending.map((f) => f.name).join(", ")}</div>
          <label className="block text-xs text-white/60">Brand<BrandInput value={upMeta.brand} onChange={(v) => setUpMeta((m) => ({ ...m, brand: v }))} brands={brands} /></label>
          <label className="block text-xs text-white/60">Type
            <select className={field} value={upMeta.category} onChange={(e) => setUpMeta((m) => ({ ...m, category: e.target.value }))}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="block text-xs text-white/60">Tags (comma separated, for all files)
            <input className={field} placeholder="e.g. creatine, strawberry, front" value={upMeta.tags} onChange={(e) => setUpMeta((m) => ({ ...m, tags: e.target.value }))} />
          </label>
          <p className="text-[11px] text-white/40">Each file is named after its file name; you can rename it after uploading.</p>
          <button onClick={startUpload} className="w-full h-9 rounded-lg text-sm font-semibold bg-teal-500/25 text-teal-50 border border-teal-400/40 hover:bg-teal-500/35">Upload</button>
        </Modal>
      )}

      {editing && <EditModal asset={editing} brands={brands} onClose={() => setEditing(null)} onSave={update} onDelete={remove} />}

      {placing && (
        <Modal title={`Add “${placing.name}” to a canvas`} onClose={() => setPlacing(null)}>
          <p className="text-xs text-white/50">It is added as a reference-image node, ready to connect to image or video nodes.</p>
          <div className="max-h-72 overflow-y-auto space-y-1">
            {ownSpaces.map((s) => (
              <button key={s.id} onClick={() => placeOnCanvas(placing, s.id)} className="w-full text-left px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] text-sm">
                {s.name} <span className="text-[11px] text-white/35">· {s.nodes.length} nodes</span>
              </button>
            ))}
            {ownSpaces.length === 0 && <div className="text-xs text-white/40">No canvases yet: create one under Workflow first.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function EditModal({ asset, brands, onClose, onSave, onDelete }: {
  asset: Asset; brands: string[]; onClose: () => void;
  onSave: (id: string, patch: Partial<Pick<Asset, "name" | "brand" | "category" | "tags" | "notes">>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(asset.name);
  const [brand, setBrand] = useState(asset.brand);
  const [category, setCategory] = useState(asset.category);
  const [tags, setTags] = useState(asset.tags.join(", "));
  const [notes, setNotes] = useState(asset.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await onSave(asset.id, { name, brand, category, notes, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title="Edit asset" onClose={onClose}>
      <div className="h-40 rounded-lg bg-black/40 grid place-items-center overflow-hidden"><Preview a={asset} className="max-h-40 object-contain" /></div>
      <label className="block text-xs text-white/60">Name<input className={field} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-white/60">Brand<BrandInput value={brand} onChange={setBrand} brands={brands} /></label>
        <label className="block text-xs text-white/60">Type
          <select className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
            {[...new Set([...CATEGORIES, category])].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-xs text-white/60">Tags<input className={field} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="creatine, strawberry, front" /></label>
      <label className="block text-xs text-white/60">Notes (also shown to Build with AI)<textarea className={`${field} h-16 resize-none`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. old packaging, do not use for EU" /></label>
      {err && <div className="text-xs text-red-300">{err}</div>}
      <div className="flex gap-2">
        {confirm ? (
          <button disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(asset.id); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); } }}
            className="h-9 px-3 rounded-lg text-sm bg-red-500/25 text-red-100 border border-red-400/40">Really delete</button>
        ) : (
          <button onClick={() => setConfirm(true)} className="h-9 px-3 rounded-lg text-sm text-red-300/80 hover:text-red-200">Delete</button>
        )}
        <button disabled={busy} onClick={save} className="ml-auto h-9 px-4 rounded-lg text-sm font-semibold bg-teal-500/25 text-teal-50 border border-teal-400/40 hover:bg-teal-500/35">Save</button>
      </div>
    </Modal>
  );
}
