"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useWorkflowStore } from "@/lib/store";

interface Competitor { page_id: string; name: string; market: string | null }
interface Concept {
  concept: string; page: string; ads: number; active: number; reach: number; share: number;
  malePct: number | null; age25to44Pct: number; topAge: string | null; longest: number;
  lastStart: string | null; status: string; formats: string[]; sampleId: string;
}
interface Ad {
  ad_archive_id: string; page: string; concept: string; display_format: string | null; body: string | null;
  video_urls: string[] | null; image_urls: string[] | null; start_date: string | null; end_date: string | null;
  is_active: boolean | null; days_running: number | null; eu_total_reach: number | null;
  reach_male: number | null; reach_female: number | null; link_url: string | null; cta_text: string | null;
  archived_media: { kind: string; url: string }[] | null;
}
interface Summary {
  competitors: Competitor[];
  lastRun: { finished_at: string | null; status: string | null; ads_returned: number | null; cost_usd: number | null } | null;
  totals: { ads: number; active: number; reach: number; concepts: number };
  concepts: Concept[]; ads: Ad[];
}

const fmt = (n: number | null | undefined) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);

const STATUS_STYLE: Record<string, string> = {
  winner: "bg-emerald-500/15 text-emerald-300",
  "burned winner": "bg-amber-500/15 text-amber-300",
  "low-spend runner": "bg-white/[0.06] text-white/60",
  "killed fast": "bg-red-500/15 text-red-300",
  test: "bg-sky-500/15 text-sky-300",
};

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <div className="text-xs text-white/50">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-[11px] text-white/40 mt-0.5">{sub}</div>}
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

function AdCard({ ad }: { ad: Ad }) {
  // Archived copies in R2 never expire; Meta's own links stop working after ~4 days
  const video = ad.archived_media?.find((m) => m.kind === "video")?.url ?? ad.video_urls?.[0];
  const image = ad.archived_media?.find((m) => m.kind === "image")?.url ?? ad.image_urls?.[0];
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
          <div className="h-full grid place-items-center text-xs text-white/30">Media link expired — refreshes on next scan</div>
        )}
      </div>
      <div className="p-3 space-y-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 rounded ${ad.is_active ? "bg-emerald-500/15 text-emerald-300" : "bg-white/[0.06] text-white/50"}`}>
            {ad.is_active ? "Active" : "Stopped"}
          </span>
          <span className="text-white/50">{ad.days_running ?? "?"} days · {ad.display_format}</span>
        </div>
        <div className="text-white/80 line-clamp-3 whitespace-pre-line">{ad.body || "—"}</div>
        <div className="flex justify-between text-white/50">
          <span>Reach {fmt(ad.eu_total_reach)}</span>
          <span>{total ? `${Math.round(((ad.reach_male ?? 0) / total) * 100)}% men` : ""}</span>
        </div>
        <div className="text-white/40">{ad.start_date} → {ad.is_active ? "now" : ad.end_date}</div>
        <a href={`https://www.facebook.com/ads/library/?id=${ad.ad_archive_id}`} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
          Open in Ad Library
        </a>
      </div>
    </div>
  );
}

export default function LabPage() {
  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const [pageId, setPageId] = useState("");
  const [tab, setTab] = useState<"concepts" | "ads">("concepts");
  const [conceptFilter, setConceptFilter] = useState<string | null>(null);
  const [adFilter, setAdFilter] = useState<"all" | "active" | "long" | "male">("all");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data: auth } = await createClient().auth.getSession();
      const token = auth.session?.access_token;
      if (!token) { setAuthModalOpen(true); setError("Sign in to see the Lab."); return; }
      const res = await fetch(`/api/lab/summary${pageId ? `?page_id=${pageId}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load the Lab");
      setData(json as Summary);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [pageId, setAuthModalOpen]);

  useEffect(() => { load(); }, [load]);

  const ads = useMemo(() => {
    let list = data?.ads ?? [];
    if (conceptFilter) list = list.filter((a) => a.concept === conceptFilter);
    if (adFilter === "active") list = list.filter((a) => a.is_active);
    if (adFilter === "long") list = list.filter((a) => (a.days_running ?? 0) >= 30);
    if (adFilter === "male") list = list.filter((a) => {
      const t = (a.reach_male ?? 0) + (a.reach_female ?? 0);
      return t > 0 && (a.reach_male ?? 0) / t >= 0.5;
    });
    return list;
  }, [data, conceptFilter, adFilter]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Creative Lab</h1>
          <span className="text-xs text-white/40">
            {data?.lastRun?.finished_at ? `Last scan ${new Date(data.lastRun.finished_at).toLocaleString()} · ${data.lastRun.ads_returned ?? 0} ads` : "No scan yet"} · weekly on Mondays
          </span>
          <div className="ml-auto flex gap-2 items-center">
            <select
              value={pageId}
              onChange={(e) => { setPageId(e.target.value); setConceptFilter(null); }}
              className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs"
            >
              <option value="">All competitors</option>
              {data?.competitors.map((c) => <option key={c.page_id} value={c.page_id}>{c.name}{c.market ? ` (${c.market})` : ""}</option>)}
            </select>
            <button onClick={load} className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white">Refresh</button>
          </div>
        </div>

        {error && <div className="text-sm text-red-400">{error}</div>}
        {loading && !data && <div className="text-sm text-white/50">Loading…</div>}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card label="Ads tracked" value={String(data.totals.ads)} sub={`${data.totals.active} running now`} />
              <Card label="Concepts" value={String(data.totals.concepts)} sub="ads grouped by message" />
              <Card label="EU reach (all time)" value={fmt(data.totals.reach)} sub="accounts reached, EU ads only" />
              <Card label="Competitors" value={String(data.competitors.length)} sub={data.competitors.map((c) => c.name).join(", ")} />
            </div>

            <div className="flex gap-1">
              {(["concepts", "ads"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs ${tab === t ? "bg-white/[0.1] text-white" : "text-white/50 hover:text-white"}`}>
                  {t === "concepts" ? "Concepts" : "Ad library"}
                </button>
              ))}
              {conceptFilter && (
                <button onClick={() => setConceptFilter(null)} className="ml-2 px-3 py-1.5 rounded-lg text-xs bg-sky-500/15 text-sky-300">
                  Concept: {conceptFilter.slice(0, 40)} ✕
                </button>
              )}
            </div>

            {tab === "concepts" && (
              <div className="rounded-xl border border-white/[0.08] overflow-x-auto">
                <table className="w-full text-sm min-w-[860px]">
                  <thead>
                    <tr className="text-left text-xs text-white/40">
                      <th className="px-4 py-2 font-normal">Concept</th>
                      <th className="px-4 py-2 font-normal">Status</th>
                      <th className="px-4 py-2 font-normal text-right">Reach</th>
                      <th className="px-4 py-2 font-normal text-right">Share</th>
                      <th className="px-4 py-2 font-normal">Audience</th>
                      <th className="px-4 py-2 font-normal text-right">25–44</th>
                      <th className="px-4 py-2 font-normal text-right">Longest</th>
                      <th className="px-4 py-2 font-normal text-right">Ads</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.concepts.map((c) => (
                      <tr key={`${c.page}-${c.concept}`} className="border-t border-white/[0.05] hover:bg-white/[0.02] cursor-pointer"
                        onClick={() => { setConceptFilter(c.concept); setTab("ads"); }}>
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

            {tab === "ads" && (
              <>
                <div className="flex gap-1">
                  {([["all", "All"], ["active", "Running now"], ["long", "30+ days"], ["male", "Male-skewed"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setAdFilter(k)}
                      className={`px-3 py-1 rounded-lg text-xs ${adFilter === k ? "bg-white/[0.1] text-white" : "text-white/50 hover:text-white"}`}>{l}</button>
                  ))}
                  <span className="ml-auto text-xs text-white/40 self-center">{ads.length} ads</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {ads.map((a) => <AdCard key={a.ad_archive_id} ad={a} />)}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
