/**
 * GET /api/meta/analytics?account_id=…&days=7
 * KPIs (vs previous period), daily series, audience breakdowns and per-ad metrics with
 * Scaling / Opportunity / Fatiguing / Loser labels, for the period ending yesterday.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";

export const dynamic = "force-dynamic";

interface Row {
  ad_id: string; date: string; spend: number; impressions: number; clicks: number; link_clicks: number;
  purchases: number; purchase_value: number; add_to_cart: number; checkouts: number;
  video_3s: number; thruplays: number; video_p25: number; video_p50: number; video_p75: number; video_p100: number;
}
type Sum = Omit<Row, "ad_id" | "date">;

const KEYS: (keyof Sum)[] = ["spend", "impressions", "clicks", "link_clicks", "purchases", "purchase_value", "add_to_cart", "checkouts", "video_3s", "thruplays", "video_p25", "video_p50", "video_p75", "video_p100"];
const zero = (): Sum => Object.fromEntries(KEYS.map((k) => [k, 0])) as Sum;
const add = (a: Sum, r: Partial<Sum>) => { for (const k of KEYS) a[k] += Number(r[k] ?? 0); return a; };
const div = (a: number, b: number) => (b > 0 ? a / b : null);

/** Derived metrics shared by account totals and single ads. */
function metrics(s: Sum) {
  return {
    ...s,
    roas: div(s.purchase_value, s.spend),
    cpa: div(s.spend, s.purchases),
    cpm: div(s.spend * 1000, s.impressions),
    ctr: div(s.link_clicks, s.impressions),
    cvr: div(s.purchases, s.link_clicks),
    aov: div(s.purchase_value, s.purchases),
    hookRate: div(s.video_3s, s.impressions),
    holdRate: div(s.thruplays, s.video_3s),
  };
}

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const accountId = req.nextUrl.searchParams.get("account_id") ?? "";
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 7));
  if (!accountId) return NextResponse.json({ error: "account_id required" }, { status: 400 });

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date(Date.now() - 864e5);                 // yesterday: today is still incomplete
  const start = new Date(end.getTime() - (days - 1) * 864e5);
  const prevEnd = new Date(start.getTime() - 864e5);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 864e5);

  try {
    const [rows, breakdownRows, { data: account }, { data: iterationRows }] = await Promise.all([
      fetchAll<Row>((f, t) => supabaseAdmin.from("meta_ad_insights_daily")
        .select("ad_id,date,spend,impressions,clicks,link_clicks,purchases,purchase_value,add_to_cart,checkouts,video_3s,thruplays,video_p25,video_p50,video_p75,video_p100")
        .eq("account_id", accountId).gte("date", iso(prevStart)).lte("date", iso(end)).order("date").order("ad_id").range(f, t)),
      fetchAll<{ breakdown: string; key1: string; key2: string; spend: number; purchases: number; purchase_value: number; impressions: number }>((f, t) =>
        supabaseAdmin.from("meta_insights_breakdown").select("breakdown,key1,key2,spend,impressions,purchases,purchase_value")
          .eq("account_id", accountId).gte("date", iso(start)).lte("date", iso(end)).order("date").order("breakdown").order("key1").order("key2").range(f, t)),
      supabaseAdmin.from("meta_ad_accounts").select("*").eq("account_id", accountId).single(),
      supabaseAdmin.from("meta_ad_iterations").select("ad_id").limit(5000),
    ]);

    const cur = rows.filter((r) => r.date >= iso(start));
    const prev = rows.filter((r) => r.date < iso(start));

    // Totals and daily series (index-aligned so the previous period can be drawn as a dotted line)
    const total = metrics(cur.reduce((a, r) => add(a, r), zero()));
    const prevTotal = metrics(prev.reduce((a, r) => add(a, r), zero()));
    const seriesFor = (list: Row[], from: Date) => Array.from({ length: days }, (_, i) => {
      const d = iso(new Date(from.getTime() + i * 864e5));
      return { date: d, ...metrics(list.filter((r) => r.date === d).reduce((a, r) => add(a, r), zero())) };
    });

    // Per-ad aggregation
    const byAd = new Map<string, { cur: Sum; prev: Sum }>();
    for (const r of rows) {
      if (!byAd.has(r.ad_id)) byAd.set(r.ad_id, { cur: zero(), prev: zero() });
      add(r.date >= iso(start) ? byAd.get(r.ad_id)!.cur : byAd.get(r.ad_id)!.prev, r);
    }
    const adIds = [...byAd.keys()].filter((id) => byAd.get(id)!.cur.spend > 0);
    const meta = adIds.length
      ? await fetchAll<Record<string, string | null>>((f, t) => supabaseAdmin.from("meta_ads")
          .select("ad_id,name,effective_status,campaign_name,adset_name,title,body,thumbnail_url,image_url,video_id,link_url,created_time")
          .in("ad_id", adIds.slice(0, 1000)).range(f, t))
      : [];
    const metaById = new Map(meta.map((m) => [m.ad_id as string, m]));
    const iterated = new Set((iterationRows ?? []).map((r) => r.ad_id as string));

    const accRoas = total.roas ?? 0;
    const accCpa = total.cpa ?? Infinity;
    const ads = adIds.map((id) => {
      const { cur: c, prev: p } = byAd.get(id)!;
      const m = metrics(c), pm = metrics(p);
      const share = total.spend ? c.spend / total.spend : 0;
      const labels: string[] = [];
      // Scaling: meaningful share of spend, at least account-level efficiency, spend growing
      if (share >= 0.1 && (m.roas ?? 0) >= accRoas * 0.9 && c.spend >= p.spend * 1.15) labels.push("scaling");
      // Opportunity: clearly more efficient than the account, but underfunded
      if ((m.roas ?? 0) >= accRoas * 1.2 && c.purchases >= 2 && share < 0.1) labels.push("opportunity");
      // Fatiguing: had real spend before, and click-through or efficiency dropped noticeably
      if (p.spend >= total.spend * 0.03 && ((pm.ctr && m.ctr != null && m.ctr < pm.ctr * 0.8) || (pm.roas && m.roas != null && m.roas < pm.roas * 0.7))) labels.push("fatiguing");
      // Loser: spent 2× the account CPA without a purchase, or ROAS under half the account's
      if ((c.purchases === 0 && c.spend >= 2 * accCpa) || (c.spend >= accCpa && (m.roas ?? 0) < accRoas * 0.5)) labels.push("loser");
      return {
        ad_id: id, ...metaById.get(id), share, labels, iterated: iterated.has(id),
        metrics: m,
        prev: { spend: p.spend, roas: pm.roas, ctr: pm.ctr, cpa: pm.cpa, hookRate: pm.hookRate },
      };
    }).sort((a, b) => b.metrics.spend - a.metrics.spend);

    // Breakdowns aggregated over the period
    const breakdowns: Record<string, { key: string; key2: string; spend: number; purchases: number; purchase_value: number; impressions: number }[]> = {};
    for (const b of breakdownRows) {
      const list = (breakdowns[b.breakdown] ??= []);
      let item = list.find((x) => x.key === b.key1 && x.key2 === b.key2);
      if (!item) { item = { key: b.key1, key2: b.key2, spend: 0, purchases: 0, purchase_value: 0, impressions: 0 }; list.push(item); }
      item.spend += Number(b.spend); item.purchases += Number(b.purchases);
      item.purchase_value += Number(b.purchase_value); item.impressions += Number(b.impressions);
    }

    return NextResponse.json({
      account,
      period: { start: iso(start), end: iso(end), prevStart: iso(prevStart), prevEnd: iso(prevEnd), days },
      total, prevTotal,
      series: seriesFor(cur, start), prevSeries: seriesFor(prev, prevStart),
      breakdowns, ads,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
