"use client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { useWorkflowStore } from "@/lib/store";

/* ── Types ─────────────────────────────────────────────────────────────────── */
interface Competitor { page_id: string; name: string; market: string | null; kind: string | null }
interface Concept {
  concept: string; page: string; ads: number; active: number; reach: number; share: number;
  malePct: number | null; age25to44Pct: number; topAge: string | null; longest: number;
  lastStart: string | null; status: string; formats: string[]; sampleId: string;
}
interface Ad {
  ad_archive_id: string; page_id: string; page: string; concept: string; collation_id: string | null;
  display_format: string | null; body: string | null; title: string | null; cta_text: string | null; link_url: string | null;
  video_urls: string[] | null; image_urls: string[] | null; start_date: string | null; end_date: string | null;
  is_active: boolean | null; days_running: number | null; eu_total_reach: number | null;
  reach_male: number | null; reach_female: number | null; reach_by_age: Record<string, number> | null;
  archived_media: { kind: string; url: string }[] | null; platforms: string[] | null;
  target_locations: { name: string; excluded?: boolean }[] | null; ended_detected: boolean | null;
}
interface Summary {
  competitors: Competitor[];
  lastRun: { finished_at: string | null; status: string | null; ads_returned: number | null } | null;
  concepts: Concept[]; ads: Ad[];
}

type Tab = "overview" | "ads" | "concepts" | "copies" | "headlines" | "landing" | "timeline" | "hooks";
type Sort = "top" | "reach" | "duplicated" | "newest" | "longest";
type Launched = "all" | "week" | "7d" | "30d";

/* ── Helpers ───────────────────────────────────────────────────────────────── */
const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const today = () => new Date().toISOString().slice(0, 10);

/** Performance score: EU reach when Meta publishes it, otherwise days running (US-only ads). */
const score = (a: Ad) => a.eu_total_reach ?? (a.days_running ?? 0);

function cleanUrl(u: string | null): string {
  if (!u) return "—";
  try {
    const x = new URL(u);
    return decodeURIComponent(`${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`);
  } catch { return u; }
}
const firstLine = (t: string | null) => (t || "").split("\n")[0].trim();
const isTemplate = (t: string | null) => !!t && t.includes("{{");

function mediaOf(ad: Ad) {
  const video = ad.archived_media?.find((m) => m.kind === "video")?.url ?? ad.video_urls?.[0];
  const image = ad.archived_media?.find((m) => m.kind === "image")?.url ?? ad.image_urls?.[0];
  return { video, image };
}

/** Group ads by a text key and summarise each group the way the tables show it. */
function groupBy(ads: Ad[], key: (a: Ad) => string | null) {
  const m = new Map<string, Ad[]>();
  for (const a of ads) {
    const k = key(a);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(a);
  }
  return [...m.entries()].map(([k, list]) => {
    const reach = list.reduce((s, a) => s + (a.eu_total_reach ?? 0), 0);
    return {
      key: k, ads: list,
      count: list.length,
      active: list.filter((a) => a.is_active).length,
      longest: Math.max(...list.map((a) => a.days_running ?? 0)),
      totalDays: list.reduce((s, a) => s + (a.days_running ?? 0), 0),
      reach,
      score: list.reduce((s, a) => s + score(a), 0),
    };
  }).sort((a, b) => b.score - a.score);
}

const STATUS_STYLE: Record<string, string> = {
  winner: "bg-emerald-500/15 text-emerald-300",
  "burned winner": "bg-amber-500/15 text-amber-300",
  "low-spend runner": "bg-white/[0.06] text-white/60",
  "killed fast": "bg-red-500/15 text-red-300",
  test: "bg-sky-500/15 text-sky-300",
};

/* ── Small components ─────────────────────────────────────────────────────── */
function Card({ label, value, sub, children }: { label: string; value?: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <div className="text-xs text-white/50">{label}</div>
      {value && <div className="text-2xl font-semibold mt-1">{value}</div>}
      {sub && <div className="text-[11px] text-white/40 mt-0.5">{sub}</div>}
      {children}
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <div className="space-y-1.5 mt-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-16 text-white/60 truncate">{r.label}</span>
          <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full bg-sky-400/80" style={{ width: `${(r.value / total) * 100}%` }} />
          </div>
          <span className="w-9 text-right text-white/60">{Math.round((r.value / total) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

function GenderBar({ male }: { male: number | null }) {
  if (male == null) return <span className="text-white/30">—</span>;
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-pink-400/60">
        <div className="bg-sky-400" style={{ width: `${male * 100}%` }} />
      </div>
      <span className="text-xs text-white/60">{Math.round(male * 100)}% M</span>
    </div>
  );
}

function ScoreBar({ value, max }: { value: number; max: number }) {
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="h-1.5 w-20 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full bg-sky-400" style={{ width: `${max ? Math.max(3, (value / max) * 100) : 0}%` }} />
      </div>
      <span className="text-xs text-white/70 w-12 text-right">{fmt(value)}</span>
    </div>
  );
}

function AdCard({ ad, onOpen }: { ad: Ad; onOpen: (a: Ad) => void }) {
  const { video, image } = mediaOf(ad);
  const total = (ad.reach_male ?? 0) + (ad.reach_female ?? 0);
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden flex flex-col">
      <div className="aspect-[4/5] bg-black/40">
        {video ? (
          <video src={video} poster={image} controls preload="none" className="h-full w-full object-cover" />
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full grid place-items-center text-xs text-white/30 px-3 text-center">Media not stored</div>
        )}
      </div>
      <button onClick={() => onOpen(ad)} className="p-3 space-y-1.5 text-xs text-left hover:bg-white/[0.03]">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 rounded ${ad.is_active ? "bg-emerald-500/15 text-emerald-300" : "bg-white/[0.06] text-white/50"}`}>
            {ad.is_active ? "Active" : "Stopped"}
          </span>
          <span className="text-white/50 truncate">{ad.days_running ?? "?"}d · {ad.display_format} · {ad.page}</span>
        </div>
        <div className="text-white/80 line-clamp-3 whitespace-pre-line">{isTemplate(ad.body) ? "Catalog / dynamic ad" : ad.body || "—"}</div>
        <div className="flex justify-between text-white/50">
          <span>Reach {fmt(ad.eu_total_reach)}</span>
          <span>{total ? `${Math.round(((ad.reach_male ?? 0) / total) * 100)}% men` : ""}</span>
        </div>
      </button>
    </div>
  );
}

function AdDrawer({ ad, onClose }: { ad: Ad; onClose: () => void }) {
  const { video, image } = mediaOf(ad);
  const ages = Object.entries(ad.reach_by_age ?? {}).filter(([k]) => k !== "Unknown").sort();
  const total = (ad.reach_male ?? 0) + (ad.reach_female ?? 0);
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-3xl h-full overflow-y-auto bg-[#111] border-l border-white/[0.08] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="text-sm font-medium">{ad.page}</div>
          <a href={`https://www.facebook.com/ads/library/?id=${ad.ad_archive_id}`} target="_blank" rel="noreferrer" className="text-xs text-sky-300 hover:underline">View on Meta</a>
          <button onClick={onClose} className="ml-auto text-white/50 hover:text-white text-sm">Close ✕</button>
        </div>
        <div className="grid md:grid-cols-2 gap-5">
          <div className="space-y-3">
            <div className="rounded-xl overflow-hidden bg-black/40 aspect-[4/5]">
              {video ? <video src={video} poster={image} controls className="h-full w-full object-contain" />
                // eslint-disable-next-line @next/next/no-img-element
                : image ? <img src={image} alt="" className="h-full w-full object-contain" />
                : <div className="h-full grid place-items-center text-xs text-white/30">Media not stored</div>}
            </div>
            <div className="text-xs text-white/70 whitespace-pre-line">{ad.body || "—"}</div>
          </div>
          <div className="space-y-3 text-sm">
            <Card label="Status" value={ad.is_active ? "Active" : "Stopped"} sub={`${ad.start_date} → ${ad.is_active ? "now" : ad.end_date}${ad.ended_detected ? " (end detected by weekly scan)" : ""} · ${ad.days_running ?? "?"} days`} />
            <Card label="EU reach" value={fmt(ad.eu_total_reach)} sub={ad.eu_total_reach ? "actual delivery, published by Meta" : "not published (ad did not run in the EU)"} />
            {total > 0 && (
              <Card label="Who it reached">
                <Bars rows={[{ label: "Men", value: ad.reach_male ?? 0 }, { label: "Women", value: ad.reach_female ?? 0 }]} />
                {ages.length > 0 && <Bars rows={ages.map(([k, v]) => ({ label: k, value: v }))} />}
              </Card>
            )}
            <Card label="Details">
              <div className="text-xs text-white/70 space-y-1 mt-1">
                <div>Format: {ad.display_format}</div>
                {ad.title && <div>Headline: {ad.title}</div>}
                {ad.cta_text && <div>CTA: {ad.cta_text}</div>}
                <div>Landing page: {ad.link_url ? <a href={ad.link_url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline break-all">{cleanUrl(ad.link_url)}</a> : "—"}</div>
                <div>Platforms: {(ad.platforms ?? []).join(", ").toLowerCase() || "—"}</div>
                <div>Locations: {(ad.target_locations ?? []).filter((l) => !l.excluded).map((l) => l.name).join(", ") || "—"}</div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupTable({ title, rows, label, onView, compact = false }: {
  title: string; label: string;
  rows: ReturnType<typeof groupBy>;
  onView: (key: string) => void;
  compact?: boolean;
}) {
  const [page, setPage] = useState(0);
  const max = rows[0]?.score ?? 0;
  const slice = rows.slice(page * 15, page * 15 + 15);
  return (
    <div className={`rounded-xl border border-white/[0.08] ${compact ? "overflow-hidden" : "overflow-x-auto"}`}>
      <div className="px-4 py-2 text-xs text-white/50 bg-white/[0.02] flex">
        <span>{title}</span><span className="ml-auto">{rows.length} items</span>
      </div>
      <table className={`w-full text-sm ${compact ? "table-fixed" : "min-w-[820px]"}`}>
        <thead>
          <tr className="text-left text-xs text-white/40">
            <th className="px-4 py-2 font-normal">{label}</th>
            <th className={`px-4 py-2 font-normal text-right ${compact ? "w-16" : ""}`}>Ads</th>
            <th className={`px-4 py-2 font-normal text-right ${compact ? "w-24" : ""}`}>Longest</th>
            {!compact && <th className="px-4 py-2 font-normal text-right">Total running</th>}
            <th className={`px-4 py-2 font-normal text-right ${compact ? "w-20" : ""}`}>Reach</th>
            {!compact && <th className="px-4 py-2 font-normal text-right">Score</th>}
          </tr>
        </thead>
        <tbody>
          {slice.map((r) => (
            <tr key={r.key} className="border-t border-white/[0.05] hover:bg-white/[0.02] cursor-pointer" onClick={() => onView(r.key)}>
              <td className="px-4 py-2 max-w-[460px]"><div className={`${compact ? "line-clamp-2 break-words" : "line-clamp-3"} whitespace-pre-line text-white/85`}>{r.key}</div></td>
              <td className="px-4 py-2 text-right text-white/70">{r.count}{r.active && !compact ? <span className="text-emerald-300/80"> · {r.active} live</span> : null}</td>
              <td className="px-4 py-2 text-right text-white/70 whitespace-nowrap">{r.longest} days</td>
              {!compact && <td className="px-4 py-2 text-right text-white/50">{r.totalDays.toLocaleString()} days</td>}
              <td className="px-4 py-2 text-right font-medium">{fmt(r.reach || null)}</td>
              {!compact && <td className="px-4 py-2"><ScoreBar value={r.score} max={max} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 15 && (
        <div className="flex gap-2 justify-end px-4 py-2 border-t border-white/[0.05] text-xs">
          <button disabled={page === 0} onClick={() => setPage(page - 1)} className="px-2 py-1 rounded disabled:opacity-30 hover:bg-white/[0.06]">‹ Prev</button>
          <span className="text-white/40 self-center">{page + 1} / {Math.ceil(rows.length / 15)}</span>
          <button disabled={(page + 1) * 15 >= rows.length} onClick={() => setPage(page + 1)} className="px-2 py-1 rounded disabled:opacity-30 hover:bg-white/[0.06]">Next ›</button>
        </div>
      )}
    </div>
  );
}

function Timeline({ ads, onOpen }: { ads: Ad[]; onOpen: (a: Ad) => void }) {
  const [days, setDays] = useState(30);
  const end = new Date(today());
  const start = new Date(end.getTime() - (days - 1) * 864e5);
  const inWindow = ads.filter((a) => a.start_date && (a.is_active || (a.end_date && new Date(a.end_date) >= start)))
    .sort((a, b) => score(b) - score(a)).slice(0, 60);
  const pos = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - start.getTime()) / 864e5 / days) * 100));
  const ticks = Array.from({ length: 6 }, (_, i) => new Date(start.getTime() + (i * (days - 1) * 864e5) / 5));
  return (
    <div className="rounded-xl border border-white/[0.08] overflow-hidden">
      <div className="px-4 py-2 text-xs text-white/50 bg-white/[0.02] flex items-center gap-2">
        <span>Ads running in the period (top 60 by score)</span>
        <div className="ml-auto flex gap-1">
          {[30, 90, 180].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`px-2 py-0.5 rounded ${days === d ? "bg-white/[0.1] text-white" : "hover:text-white"}`}>{d}d</button>
          ))}
        </div>
      </div>
      <div className="px-4 pt-2 pl-[180px] relative h-6 text-[10px] text-white/40">
        {ticks.map((t) => <span key={t.toISOString()} className="absolute" style={{ left: `calc(180px + (100% - 196px) * ${pos(t) / 100})` }}>{t.toISOString().slice(5, 10)}</span>)}
      </div>
      <div className="divide-y divide-white/[0.04]">
        {inWindow.map((a) => {
          const s = new Date(a.start_date!);
          const e = a.is_active ? end : new Date(a.end_date!);
          const left = pos(s), right = pos(e);
          return (
            <button key={a.ad_archive_id} onClick={() => onOpen(a)} className="flex items-center w-full hover:bg-white/[0.02] text-left">
              <div className="w-[180px] shrink-0 px-4 py-1.5 text-[11px] text-white/60 truncate">{firstLine(a.body) || a.display_format}</div>
              <div className="relative flex-1 h-7 mr-4">
                <div className={`absolute top-1 bottom-1 rounded text-[10px] flex items-center justify-center overflow-hidden ${a.is_active ? "bg-emerald-500/25 text-emerald-200" : "bg-white/[0.1] text-white/60"}`}
                  style={{ left: `${left}%`, width: `${Math.max(1.5, right - left)}%` }}>
                  {a.days_running}d
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */
function BrandView({ pageId, pageIds, title, brands, onBack }: {
  pageId: string; pageIds?: string[]; title?: string; brands: Brand[]; onBack: () => void;
}) {
  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const idsKey = (pageIds ?? []).join(",");
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Ad | null>(null);

  // Filters (apply to every tab)
  const [status, setStatus] = useState<"all" | "active" | "stopped">("all");
  const [format, setFormat] = useState("all");
  const [launched, setLaunched] = useState<Launched>("all");
  const [sort, setSort] = useState<Sort>("top");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<{ label: string; ids: Set<string> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data: auth } = await createClient().auth.getSession();
      const token = auth.session?.access_token;
      if (!token) { setAuthModalOpen(true); setError("Sign in to see the Lab."); return; }
      const qs = pageId ? `?page_id=${pageId}` : idsKey ? `?page_ids=${idsKey}` : "";
      const res = await fetch(`/api/lab/summary${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load the Lab");
      setData(json as Summary);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [pageId, idsKey, setAuthModalOpen]);

  useEffect(() => { load(); }, [load]);

  const formats = useMemo(() => [...new Set((data?.ads ?? []).map((a) => a.display_format).filter(Boolean))] as string[], [data]);

  const ads = useMemo(() => {
    let list = data?.ads ?? [];
    if (status === "active") list = list.filter((a) => a.is_active);
    if (status === "stopped") list = list.filter((a) => !a.is_active);
    if (format !== "all") list = list.filter((a) => a.display_format === format);
    if (launched !== "all") {
      const days = launched === "30d" ? 30 : 7;
      const since = launched === "week"
        ? (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); })()
        : new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      list = list.filter((a) => (a.start_date ?? "") >= since);
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((a) => [a.body, a.title, a.link_url].some((t) => t?.toLowerCase().includes(q)));
    }
    if (focus) list = list.filter((a) => focus.ids.has(a.ad_archive_id));
    const dup = new Map<string, number>();
    for (const a of list) if (a.collation_id) dup.set(a.collation_id, (dup.get(a.collation_id) ?? 0) + 1);
    const sorted = [...list];
    if (sort === "top") sorted.sort((a, b) => score(b) - score(a));
    if (sort === "reach") sorted.sort((a, b) => (b.eu_total_reach ?? -1) - (a.eu_total_reach ?? -1));
    if (sort === "duplicated") sorted.sort((a, b) => (dup.get(b.collation_id ?? "") ?? 0) - (dup.get(a.collation_id ?? "") ?? 0) || score(b) - score(a));
    if (sort === "newest") sorted.sort((a, b) => (b.start_date ?? "").localeCompare(a.start_date ?? ""));
    if (sort === "longest") sorted.sort((a, b) => (b.days_running ?? 0) - (a.days_running ?? 0));
    return sorted;
  }, [data, status, format, launched, query, focus, sort]);

  const view = (label: string, list: Ad[]) => { setFocus({ label, ids: new Set(list.map((a) => a.ad_archive_id)) }); setTab("ads"); };

  const overview = useMemo(() => {
    const active = ads.filter((a) => a.is_active).length;
    const video = ads.filter((a) => (a.display_format ?? "").toUpperCase() === "VIDEO").length;
    const men = ads.reduce((s, a) => s + (a.reach_male ?? 0), 0);
    const women = ads.reduce((s, a) => s + (a.reach_female ?? 0), 0);
    const ages: Record<string, number> = {};
    for (const a of ads) for (const [k, v] of Object.entries(a.reach_by_age ?? {})) if (k !== "Unknown") ages[k] = (ages[k] ?? 0) + v;
    const countries: Record<string, number> = {};
    for (const a of ads) for (const l of a.target_locations ?? []) if (!l.excluded) countries[l.name] = (countries[l.name] ?? 0) + 1;
    const fmts: Record<string, number> = {};
    for (const a of ads) fmts[a.display_format ?? "?"] = (fmts[a.display_format ?? "?"] ?? 0) + 1;
    return {
      active, video, men, women,
      ages: Object.entries(ages).sort().map(([label, value]) => ({ label, value })),
      countries: Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, value]) => ({ label, value })),
      formats: Object.entries(fmts).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
      reach: ads.reduce((s, a) => s + (a.eu_total_reach ?? 0), 0),
    };
  }, [ads]);

  const copies = useMemo(() => groupBy(ads, (a) => (isTemplate(a.body) ? null : (a.body || "").trim() || null)), [ads]);
  const headlines = useMemo(() => groupBy(ads, (a) => (isTemplate(a.title) ? null : (a.title || "").trim() || null)), [ads]);
  const landing = useMemo(() => groupBy(ads, (a) => (a.link_url ? cleanUrl(a.link_url) : null)), [ads]);
  const brand = brands.find((c) => c.page_id === pageId);

  const TABS: [Tab, string][] = [
    ["overview", "Overview"], ["ads", "Ads"], ["concepts", "Concepts"], ["copies", "Ad copies"], ["headlines", "Headlines"],
    ["landing", "Landing pages"], ["timeline", "Timeline"], ["hooks", "Hooks · Types · Elements"],
  ];
  const selectCls = "bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs";

  return (
    <div className="h-full overflow-y-auto flex-1 min-w-0">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-8 py-6 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={onBack} className="text-xs text-white/50 hover:text-white">‹ Brand Spy</button>
          <h1 className="text-xl font-semibold">{brand?.name ?? title ?? (pageId ? "Brand" : "All brands")}</h1>
          {!pageId && pageIds?.length ? <span className="text-xs text-white/40">{pageIds.length} brands</span> : null}
          {brand?.market && <span className="text-xs px-2 py-0.5 rounded bg-white/[0.06] text-white/60">{brand.market}</span>}
          {pageId && <a href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${pageId}`} target="_blank" rel="noreferrer" className="text-xs text-sky-300 hover:underline">Meta Ad Library ↗</a>}
          <span className="text-xs text-white/40 ml-auto">
            {data?.lastRun?.finished_at ? `Last scan ${new Date(data.lastRun.finished_at).toLocaleString()}` : "No scan yet"} · weekly on Mondays
          </span>
          <button onClick={load} className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white">Refresh</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-white/[0.06] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map(([t, l]) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs whitespace-nowrap border-b-2 -mb-px ${tab === t ? "border-sky-400 text-white" : "border-transparent text-white/50 hover:text-white"}`}>{l}</button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex gap-2 flex-wrap items-center">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search copy, headline, link…" className={`${selectCls} w-56`} />
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={selectCls}>
            <option value="all">Status: all</option><option value="active">Active</option><option value="stopped">Stopped</option>
          </select>
          <select value={format} onChange={(e) => setFormat(e.target.value)} className={selectCls}>
            <option value="all">Type: all</option>{formats.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={launched} onChange={(e) => setLaunched(e.target.value as Launched)} className={selectCls}>
            <option value="all">Launched: all time</option><option value="week">This week</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={selectCls}>
            <option value="top">Sort: top performing</option><option value="reach">Top reach</option><option value="duplicated">Most duplicated</option>
            <option value="newest">Newest</option><option value="longest">Longest running</option>
          </select>
          {focus && <button onClick={() => setFocus(null)} className="px-2.5 py-1.5 rounded-lg text-xs bg-sky-500/15 text-sky-300 max-w-[320px] truncate">{focus.label} ✕</button>}
          <span className="ml-auto text-xs text-white/40" title="Score = EU reach where Meta publishes it, otherwise days running">{ads.length} ads · score = EU reach, else days running</span>
        </div>

        {error && <div className="text-sm text-red-400">{error}</div>}
        {loading && !data && <div className="text-sm text-white/50">Loading…</div>}

        {data && tab === "overview" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card label="Total ads" value={ads.length.toLocaleString()} sub={`${overview.active} active · ${ads.length - overview.active} stopped`} />
              <Card label="Video share" value={pct(ads.length ? overview.video / ads.length : null)} sub="of ads are video" />
              <Card label="EU reach" value={fmt(overview.reach)} sub="accounts actually reached" />
              <Card label="Concepts" value={String(groupBy(ads, (a) => a.concept).length)} sub="ads grouped by message" />
            </div>
            <div className="grid md:grid-cols-4 gap-3">
              <Card label="Who it reached (actual delivery)">
                {overview.men + overview.women ? <Bars rows={[{ label: "Men", value: overview.men }, { label: "Women", value: overview.women }]} /> : <div className="text-xs text-white/30 mt-2">No EU data</div>}
              </Card>
              <Card label="Age groups (actual delivery)">
                {overview.ages.length ? <Bars rows={overview.ages} /> : <div className="text-xs text-white/30 mt-2">No EU data</div>}
              </Card>
              <Card label="Target countries"><Bars rows={overview.countries} /></Card>
              <Card label="Ad formats"><Bars rows={overview.formats} /></Card>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <GroupTable title="Top landing pages" label="Landing page" rows={landing.slice(0, 5)} compact onView={(k) => view(k, landing.find((r) => r.key === k)!.ads)} />
              <GroupTable title="Top ad copies" label="Ad copy" rows={copies.slice(0, 5)} compact onView={(k) => view(firstLine(k), copies.find((r) => r.key === k)!.ads)} />
            </div>
            <div className="text-xs text-white/50 pt-1">Top ads</div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {[...ads].sort((a, b) => score(b) - score(a)).slice(0, 10).map((a) => <AdCard key={a.ad_archive_id} ad={a} onOpen={setOpen} />)}
            </div>
          </div>
        )}

        {data && tab === "ads" && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {ads.slice(0, 200).map((a) => <AdCard key={a.ad_archive_id} ad={a} onOpen={setOpen} />)}
            {ads.length > 200 && <div className="col-span-full text-xs text-white/40">Showing 200 of {ads.length}. Narrow the filters to see more.</div>}
          </div>
        )}

        {data && tab === "concepts" && (
          <div className="rounded-xl border border-white/[0.08] overflow-x-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="text-left text-xs text-white/40">
                  <th className="px-4 py-2 font-normal">Concept</th><th className="px-4 py-2 font-normal">Status</th>
                  <th className="px-4 py-2 font-normal text-right">Reach</th><th className="px-4 py-2 font-normal text-right">Share</th>
                  <th className="px-4 py-2 font-normal">Audience</th><th className="px-4 py-2 font-normal text-right">25–44</th>
                  <th className="px-4 py-2 font-normal text-right">Longest</th><th className="px-4 py-2 font-normal text-right">Live / ads</th>
                </tr>
              </thead>
              <tbody>
                {data.concepts.map((c) => (
                  <tr key={`${c.page}-${c.concept}`} className="border-t border-white/[0.05] hover:bg-white/[0.02] cursor-pointer"
                    onClick={() => view(c.concept, data.ads.filter((a) => a.concept === c.concept && a.page === c.page))}>
                    <td className="px-4 py-2 max-w-[320px]">
                      <div className="truncate">{c.concept}</div>
                      <div className="text-[11px] text-white/40">{c.page} · {c.formats.join(", ")}{c.lastStart ? ` · last launch ${c.lastStart}` : ""}</div>
                    </td>
                    <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[c.status] ?? ""}`}>{c.status}</span></td>
                    <td className="px-4 py-2 text-right font-medium">{fmt(c.reach)}</td>
                    <td className="px-4 py-2 text-right text-white/60">{pct(c.share)}</td>
                    <td className="px-4 py-2"><GenderBar male={c.malePct} /></td>
                    <td className="px-4 py-2 text-right text-white/60">{pct(c.age25to44Pct)}</td>
                    <td className="px-4 py-2 text-right text-white/60">{c.longest}d</td>
                    <td className="px-4 py-2 text-right text-white/60">{c.active}/{c.ads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && tab === "copies" && <GroupTable title="All ad copies with the applied filters" label="Ad copy" rows={copies} onView={(k) => view(firstLine(k), copies.find((r) => r.key === k)!.ads)} />}
        {data && tab === "headlines" && <GroupTable title="Headlines" label="Headline" rows={headlines} onView={(k) => view(k, headlines.find((r) => r.key === k)!.ads)} />}
        {data && tab === "landing" && <GroupTable title="Landing pages" label="Landing page" rows={landing} onView={(k) => view(k, landing.find((r) => r.key === k)!.ads)} />}
        {data && tab === "timeline" && <Timeline ads={ads} onOpen={setOpen} />}
        {data && tab === "hooks" && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 text-sm text-white/60 space-y-2">
            <div className="text-white">Hooks, ad types and ad elements come from the AI analysis step.</div>
            <div>Each qualifying ad (winner signals, one per variant group) gets a transcript, its spoken and on-screen hook, a format type (UGC, testimonial, problem–solution…) and elements (taste, bloating, energy…). These tabs fill in once that step is switched on.</div>
          </div>
        )}
      </div>
      {open && <AdDrawer ad={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ── Brand Spy: list of tracked brands ────────────────────────────────────── */
interface Brand {
  page_id: string; name: string; market: string | null; kind: string | null; tier: string; active: boolean;
  created_at: string; last_scan_at: string | null; backfilled_at: string | null;
  ads_total: number; ads_active: number; reach_total: number; folder_id: number | null;
}
interface Folder { id: number; name: string; position: number }

async function authed(path: string, init: RequestInit = {}) {
  const { data: auth } = await createClient().auth.getSession();
  const token = auth.session?.access_token;
  if (!token) throw new Error("Sign in to use the Lab.");
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Request failed");
  return json;
}

function brandStatus(b: Brand): { label: string; cls: string } {
  if (!b.active) return { label: "Paused", cls: "bg-amber-500/15 text-amber-300" };
  if (!b.backfilled_at) return { label: "Queued for first scan", cls: "bg-sky-500/15 text-sky-300" };
  return { label: "Up to date", cls: "bg-emerald-500/15 text-emerald-300" };
}

function AddBrand({ folders, onClose, onAdded }: { folders: Folder[]; onClose: () => void; onAdded: () => void }) {
  const [folderId, setFolderId] = useState<string>(folders[0] ? String(folders[0].id) : "");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [market, setMarket] = useState("");
  const [tier, setTier] = useState("A");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const field = "w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-2 text-sm";
  const submit = async () => {
    setBusy(true); setError("");
    try { await authed("/api/lab/brands", { method: "POST", body: JSON.stringify({ url, name, market, tier, folder_id: folderId || null }) }); onAdded(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-white/[0.1] bg-[#141414] p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-base font-semibold">Add brand</div>
        <div className="text-xs text-white/50">Open the brand in the Meta Ad Library and copy the link. It contains <code>view_all_page_id=…</code>.</div>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Ad Library link or page ID" className={field} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Brand name" className={field} />
        <div className="flex gap-2">
          <input value={market} onChange={(e) => setMarket(e.target.value)} placeholder="Market (BG, RO, US…)" className={field} />
          <select value={tier} onChange={(e) => setTier(e.target.value)} className={field}>
            <option value="A">Tier A · weekly</option>
            <option value="B">Tier B · every 4 weeks</option>
          </select>
        </div>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)} className={field}>
          <option value="">Folder: uncategorized</option>
          {folders.map((f) => <option key={f.id} value={f.id}>Folder: {f.name}</option>)}
        </select>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-white/60 hover:text-white">Cancel</button>
          <button onClick={submit} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs bg-sky-500 text-white disabled:opacity-50">{busy ? "Adding…" : "Add brand"}</button>
        </div>
        <div className="text-[11px] text-white/40">New brands get their full history on the next scan (Mondays 08:00).</div>
      </div>
    </div>
  );
}


const AVATAR_COLORS = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#6366f1"];
function BrandAvatar({ name, size = 26 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = name.replace(/\(.*?\)/g, "").split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <span className="inline-grid place-items-center rounded-full text-[10px] font-semibold text-white ring-2 ring-[#0B0E14] shrink-0"
      style={{ width: size, height: size, background: AVATAR_COLORS[h % AVATAR_COLORS.length] }} title={name}>
      {initials || "?"}
    </span>
  );
}

function BrandRow({ b, folders, onOpen, onChanged }: { b: Brand; folders: Folder[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const st = brandStatus(b);
  const patch = async (body: Record<string, unknown>) => { await authed("/api/lab/brands", { method: "PATCH", body: JSON.stringify({ page_id: b.page_id, ...body }) }); onChanged(); };
  return (
    <tr className="border-t border-white/[0.05] hover:bg-white/[0.02] cursor-pointer" onClick={() => onOpen(b.page_id)}>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <BrandAvatar name={b.name} />
          <span className="font-medium truncate">{b.name}</span>
          {b.kind === "own" && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">you</span>}
        </div>
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <span className="text-emerald-300">● {b.ads_active.toLocaleString()}</span>
        <span className="text-white/40 ml-3">● {b.ads_total.toLocaleString()}</span>
      </td>
      <td className="px-4 py-2.5 text-white/60 hidden lg:table-cell">{b.market ?? "—"} · Tier {b.tier}</td>
      <td className="px-4 py-2.5 text-white/60 hidden md:table-cell">{new Date(b.created_at).toLocaleDateString()}</td>
      <td className="px-4 py-2.5 text-white/60 hidden md:table-cell">{b.last_scan_at ? new Date(b.last_scan_at).toLocaleDateString() : "—"}</td>
      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded text-xs whitespace-nowrap ${st.cls}`}>{st.label}</span>
          <button onClick={() => patch({ active: !b.active })} className="text-[11px] text-white/40 hover:text-white">{b.active ? "Pause" : "Resume"}</button>
          <select value={b.folder_id ?? ""} onChange={(e) => patch({ folder_id: e.target.value || null })}
            className="bg-transparent text-[11px] text-white/40 hover:text-white border-0 p-0 cursor-pointer" title="Move to folder">
            <option value="">Move: uncategorized</option>
            {folders.map((f) => <option key={f.id} value={f.id}>Move: {f.name}</option>)}
          </select>
        </div>
      </td>
    </tr>
  );
}

function BrandSpy({ brands, folders, onOpen, onBrowse, onReload, onAdd }: {
  brands: Brand[]; folders: Folder[];
  onOpen: (id: string) => void; onBrowse: (name: string, ids: string[]) => void;
  onReload: () => void; onAdd: () => void;
}) {
  const [q, setQ] = useState("");
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [err, setErr] = useState("");
  const search = q.trim().toLowerCase();
  const match = (b: Brand) => !search || b.name.toLowerCase().includes(search);
  const groups = [
    ...folders.map((f) => ({ key: String(f.id), name: f.name, brands: brands.filter((b) => b.folder_id === f.id && match(b)) })),
    { key: "none", name: "Uncategorized", brands: brands.filter((b) => !b.folder_id && match(b)) },
  ].filter((g) => g.key !== "none" || g.brands.length || !search);
  const isOpen = (k: string) => openFolders.has(k) || !!search;
  const toggle = (k: string) => setOpenFolders((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const createFolder = async () => {
    setErr("");
    try { await authed("/api/lab/brands", { method: "POST", body: JSON.stringify({ folder: folderName }) }); setFolderName(""); setCreating(false); onReload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="h-full overflow-y-auto flex-1 min-w-0">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-8 py-6 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Brand Spy</h1>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search spied brands…"
            className="order-3 w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-md sm:mx-auto bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm" />
          <button onClick={onAdd} className="ml-auto sm:ml-0 px-3 py-1.5 rounded-lg text-xs bg-sky-500 text-white">+ Add brand</button>
        </div>

        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g.key} className="rounded-xl border border-white/[0.08] bg-white/[0.015] overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02]" onClick={() => toggle(g.key)}>
                <span className={`text-white/40 transition-transform ${isOpen(g.key) ? "rotate-90" : ""}`}>›</span>
                <span className="text-white/50">▤</span>
                <span className="font-medium">{g.name}</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/50">{g.brands.length}</span>
                <div className="ml-auto flex items-center gap-3">
                  <div className="hidden sm:flex -space-x-1.5">
                    {g.brands.slice(0, 10).map((b) => <BrandAvatar key={b.page_id} name={b.name} size={24} />)}
                    {g.brands.length > 10 && <span className="pl-3 text-xs text-white/40 self-center">+{g.brands.length - 10}</span>}
                  </div>
                  {g.brands.length > 0 && (
                    <button onClick={(e) => { e.stopPropagation(); onBrowse(g.name, g.brands.map((b) => b.page_id)); }}
                      className="px-2.5 py-1 rounded-lg text-xs border border-white/[0.1] text-white/70 hover:text-white hover:bg-white/[0.05] whitespace-nowrap"
                      title="Browse all ads from brands in this folder">▦ Browse ads</button>
                  )}
                </div>
              </div>
              {isOpen(g.key) && (
                <table className="w-full text-sm table-fixed">
                  <colgroup>
                    <col /><col className="w-[150px]" /><col className="hidden lg:table-column w-[120px]" />
                    <col className="hidden md:table-column w-[110px]" /><col className="hidden md:table-column w-[110px]" /><col className="w-[260px]" />
                  </colgroup>
                  <thead>
                    <tr className="text-left text-xs text-white/40 border-t border-white/[0.05]">
                      <th className="px-4 py-2 font-normal">Name</th><th className="px-4 py-2 font-normal">Ads</th>
                      <th className="px-4 py-2 font-normal hidden lg:table-cell">Market</th>
                      <th className="px-4 py-2 font-normal hidden md:table-cell">Added</th>
                      <th className="px-4 py-2 font-normal hidden md:table-cell">Last scanned</th>
                      <th className="px-4 py-2 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.brands.map((b) => <BrandRow key={b.page_id} b={b} folders={folders} onOpen={onOpen} onChanged={onReload} />)}
                    {!g.brands.length && <tr><td colSpan={6} className="px-4 py-4 text-center text-xs text-white/40">No brands in this folder yet. Add one, or move a brand here.</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-center">
          {creating ? (
            <div className="flex gap-2 items-center">
              <input autoFocus value={folderName} onChange={(e) => setFolderName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFolder()}
                placeholder="Folder name" className="bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-1.5 text-sm" />
              <button onClick={createFolder} className="px-3 py-1.5 rounded-lg text-xs bg-sky-500 text-white">Create</button>
              <button onClick={() => { setCreating(false); setErr(""); }} className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white">Cancel</button>
              {err && <span className="text-xs text-red-400">{err}</span>}
            </div>
          ) : (
            <button onClick={() => setCreating(true)} className="px-4 py-2 rounded-lg text-sm border border-white/[0.1] text-white/70 hover:text-white hover:bg-white/[0.04]">+ Create new folder</button>
          )}
        </div>
        <div className="text-[11px] text-white/40 text-center">● active ads · ● all ads collected (incl. stopped). Brands are rescanned on their tier interval; paused brands are skipped.</div>
      </div>
    </div>
  );
}

/* ── Lab shell: collapsible side panel + content ──────────────────────────── */
type View = { kind: "spy" } | { kind: "brand"; id: string } | { kind: "folder"; name: string; ids: string[] } | { kind: "all" };

export default function LabPage() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [view, setView] = useState<View>({ kind: "spy" });
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    try { setCollapsed(localStorage.getItem("lab.panel.collapsed") === "1"); } catch { /* storage unavailable */ }
  }, []);
  const togglePanel = () => setCollapsed((c) => {
    try { localStorage.setItem("lab.panel.collapsed", c ? "0" : "1"); } catch { /* storage unavailable */ }
    return !c;
  });

  const loadBrands = useCallback(async () => {
    try {
      setError("");
      const json = await authed("/api/lab/brands");
      setBrands(json.brands as Brand[]);
      setFolders(json.folders as Folder[]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { loadBrands(); }, [loadBrands]);

  const navItem = (active: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left ${active ? "bg-sky-500/15 text-sky-300" : "text-white/70 hover:bg-white/[0.05] hover:text-white"}`;
  const folderBrands = (f: Folder) => brands.filter((b) => b.folder_id === f.id).map((b) => b.page_id);
  const back = () => setView({ kind: "spy" });

  return (
    <div className="h-full flex min-h-0">
      {/* Side panel — collapses to a thin rail that always keeps its expand button */}
      <aside className={`shrink-0 border-r border-white/[0.06] h-full flex flex-col transition-[width] duration-200 ${collapsed ? "w-11" : "w-56"}`}>
        <div className={`flex items-center h-12 ${collapsed ? "justify-center" : "px-3"}`}>
          {!collapsed && <span className="text-sm font-semibold">Creative Lab</span>}
          <button onClick={togglePanel} title={collapsed ? "Expand panel" : "Collapse panel"}
            className={`${collapsed ? "" : "ml-auto"} w-7 h-7 grid place-items-center rounded-md text-white/50 hover:text-white hover:bg-white/[0.06]`}>
            {collapsed ? "»" : "«"}
          </button>
        </div>
        {!collapsed && (
          <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
            <button onClick={back} className={navItem(view.kind === "spy")}>Brand Spy</button>
            <button onClick={() => setView({ kind: "all" })} className={navItem(view.kind === "all")}>All ads</button>
            <div className="pt-3 pb-1 px-3 text-[11px] uppercase tracking-wide text-white/35">Folders</div>
            {folders.map((f) => (
              <button key={f.id} onClick={() => setView({ kind: "folder", name: f.name, ids: folderBrands(f) })}
                className={navItem(view.kind === "folder" && view.name === f.name)}>
                <span className="text-white/40">▤</span><span className="truncate">{f.name}</span>
                <span className="ml-auto text-[11px] text-white/40">{folderBrands(f).length}</span>
              </button>
            ))}
            <button onClick={() => setAdding(true)} className="w-full px-3 py-2 text-left text-xs text-white/40 hover:text-white">+ Add brand</button>
          </div>
        )}
      </aside>

      {/* Content */}
      {error && view.kind === "spy" ? (
        <div className="p-6 text-sm text-red-400">{error}</div>
      ) : view.kind === "spy" ? (
        <BrandSpy brands={brands} folders={folders} onReload={loadBrands} onAdd={() => setAdding(true)}
          onOpen={(id) => setView({ kind: "brand", id })} onBrowse={(name, ids) => setView({ kind: "folder", name, ids })} />
      ) : view.kind === "brand" ? (
        <BrandView key={view.id} pageId={view.id} brands={brands} onBack={back} />
      ) : view.kind === "folder" ? (
        <BrandView key={`f-${view.name}`} pageId="" pageIds={view.ids.length ? view.ids : ["0"]} title={view.name} brands={brands} onBack={back} />
      ) : (
        <BrandView key="all" pageId="" title="All ads" brands={brands} onBack={back} />
      )}
      {adding && <AddBrand folders={folders} onClose={() => setAdding(false)} onAdded={loadBrands} />}
    </div>
  );
}
