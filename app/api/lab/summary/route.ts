/**
 * GET /api/lab/summary?page_id=<optional>
 * Creative Lab: competitors, their ads and ads grouped into concepts.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";

export const dynamic = "force-dynamic";

interface AdRow {
  ad_archive_id: string; page_id: string; collation_id: string | null; display_format: string | null;
  body: string | null; title: string | null; cta_text: string | null; link_url: string | null;
  video_urls: string[] | null; image_urls: string[] | null; start_date: string | null; end_date: string | null;
  is_active: boolean | null; days_running: number | null; eu_total_reach: number | null;
  reach_male: number | null; reach_female: number | null; reach_by_age: Record<string, number> | null;
  last_seen_at: string; archived_media: { kind: string; url: string }[] | null;
  platforms: string[] | null; target_locations: { name: string; excluded?: boolean }[] | null;
  ended_detected: boolean | null; keep_video: boolean | null;
}

/** Group key for a concept: first line of the copy without trailing emoji/punctuation. */
function conceptKey(ad: AdRow): string {
  const text = (ad.body || ad.title || "").trim();
  if (!text || text.includes("{{")) return "Catalog / dynamic ads";
  const first = text.split("\n")[0].slice(0, 70);
  // Trim trailing emoji, punctuation and spaces (kept ES2017-safe: no Unicode property escapes)
  const chars = Array.from(first);
  while (chars.length && !/[0-9A-Za-z\u0400-\u04FF\u00C0-\u024F]/.test(chars[chars.length - 1])) chars.pop();
  return chars.join("").trim() || "Untitled";
}

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pageId = req.nextUrl.searchParams.get("page_id");

  const { data: competitors, error: cErr } = await supabaseAdmin
    .from("lab_competitors").select("page_id, name, market, kind, active").order("name");
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

  // PostgREST returns at most 1,000 rows per request, so page through in chunks
  const COLS = "ad_archive_id, page_id, collation_id, display_format, body, title, cta_text, link_url, video_urls, image_urls, start_date, end_date, is_active, days_running, eu_total_reach, reach_male, reach_female, reach_by_age, last_seen_at, archived_media, platforms, target_locations, ended_detected, keep_video";
  const ads: AdRow[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    let q = supabaseAdmin.from("lab_ads").select(COLS)
      .order("eu_total_reach", { ascending: false, nullsFirst: false })
      .order("ad_archive_id")
      .range(from, from + 999);
    if (pageId) q = q.eq("page_id", pageId);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    ads.push(...((data ?? []) as AdRow[]));
    if (!data || data.length < 1000) break;
  }

  const { data: lastRun } = await supabaseAdmin
    .from("lab_runs").select("finished_at, status, ads_returned, cost_usd")
    .order("id", { ascending: false }).limit(1).maybeSingle();

  const names = Object.fromEntries((competitors ?? []).map((c) => [c.page_id, c.name]));
  const totalReach = ads.reduce((a, r) => a + (r.eu_total_reach ?? 0), 0);

  // Concepts
  const map = new Map<string, { key: string; page: string; ads: AdRow[] }>();
  for (const ad of ads) {
    const key = `${ad.page_id}::${conceptKey(ad)}`;
    if (!map.has(key)) map.set(key, { key: conceptKey(ad), page: names[ad.page_id] ?? ad.page_id, ads: [] });
    map.get(key)!.ads.push(ad);
  }
  const concepts = [...map.values()].map((c) => {
    const reach = c.ads.reduce((a, r) => a + (r.eu_total_reach ?? 0), 0);
    const male = c.ads.reduce((a, r) => a + (r.reach_male ?? 0), 0);
    const female = c.ads.reduce((a, r) => a + (r.reach_female ?? 0), 0);
    const ages: Record<string, number> = {};
    for (const r of c.ads) for (const [k, v] of Object.entries(r.reach_by_age ?? {})) ages[k] = (ages[k] ?? 0) + v;
    const ageTotal = Object.values(ages).reduce((a, v) => a + v, 0) || 1;
    const topAge = Object.entries(ages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const active = c.ads.filter((r) => r.is_active).length;
    const longest = Math.max(...c.ads.map((r) => r.days_running ?? 0));
    const lastStart = c.ads.map((r) => r.start_date ?? "").sort().at(-1) ?? null;
    // Simple, transparent status rules (refined later)
    let status = "test";
    if (longest >= 30 && reach > 0 && reach >= totalReach * 0.05) status = active ? "winner" : "burned winner";
    else if (longest >= 30 && reach < totalReach * 0.02) status = "low-spend runner";
    else if (!active && longest <= 7) status = "killed fast";
    return {
      concept: c.key, page: c.page, ads: c.ads.length, active, reach,
      share: totalReach ? reach / totalReach : 0,
      malePct: male + female ? male / (male + female) : null,
      age25to44Pct: ((ages["25-34"] ?? 0) + (ages["35-44"] ?? 0)) / ageTotal,
      topAge, longest, lastStart, status,
      formats: [...new Set(c.ads.map((r) => r.display_format).filter(Boolean))],
      sampleId: c.ads[0].ad_archive_id,
    };
  }).sort((a, b) => b.reach - a.reach);

  return NextResponse.json({
    competitors: competitors ?? [],
    lastRun,
    totals: {
      ads: ads.length,
      active: ads.filter((r) => r.is_active).length,
      reach: totalReach,
      concepts: concepts.length,
    },
    concepts,
    ads: ads.map((r) => ({ ...r, page: names[r.page_id] ?? r.page_id, concept: conceptKey(r) })),
  });
}
