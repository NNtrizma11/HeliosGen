#!/usr/bin/env node
/**
 * Creative Lab — weekly competitor ad ingest.
 *
 * 1. Reads active competitors from public.lab_competitors
 * 2. Runs the Apify actor curious_coder/facebook-ads-library-scraper (active + inactive ads, with details / EU reach)
 * 3. Upserts every ad into public.lab_ads and writes one row per ad into public.lab_ad_snapshots
 * 4. Logs the run in public.lab_runs, including how many ads came back vs. what the Library claims
 *
 * Env: APIFY_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: LAB_MAX_ADS (default 1500 total per run), LAB_MAX_COST_USD (default 2)
 *
 * Run: node scripts/lab/ingest.mjs
 */
import { createClient } from "@supabase/supabase-js";

const ACTOR = "curious_coder~facebook-ads-library-scraper";
const { APIFY_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const MAX_ADS = Number(process.env.LAB_MAX_ADS || 1500);
const MAX_COST = Number(process.env.LAB_MAX_COST_USD || 2);

for (const [k, v] of Object.entries({ APIFY_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
}

const db = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const today = new Date().toISOString().slice(0, 10);
const toDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apify(path, init = {}) {
  const res = await fetch(`https://api.apify.com/v2${path}${path.includes("?") ? "&" : "?"}token=${APIFY_TOKEN}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Apify ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

function mapAd(a) {
  const s = a.snapshot || {};
  const ai = a.aaa_info || a.transparency_by_location?.eu_transparency || {};
  const cards = s.cards || [];
  const body = s.body?.text || cards[0]?.body || null;
  const videos = [...(s.videos || []), ...cards]
    .map((v) => v.video_hd_url || v.video_sd_url).filter(Boolean);
  const images = [...(s.images || []), ...cards]
    .map((i) => i.original_image_url || i.resized_image_url).filter(Boolean);

  let male = 0, female = 0; const ages = {};
  for (const c of ai.age_country_gender_reach_breakdown || []) {
    for (const b of c.age_gender_breakdowns || []) {
      male += b.male || 0; female += b.female || 0;
      ages[b.age_range] = (ages[b.age_range] || 0) + (b.male || 0) + (b.female || 0) + (b.unknown || 0);
    }
  }
  const start = toDate(a.start_date);
  const end = toDate(a.end_date);
  const days = start ? Math.round(((end ? new Date(end) : new Date(today)) - new Date(start)) / 864e5) + 1 : null;

  return {
    ad_archive_id: String(a.ad_archive_id),
    page_id: String(a.page_id),
    collation_id: a.collation_id ? String(a.collation_id) : null,
    display_format: s.display_format || null,
    body,
    title: s.title || null,
    cta_text: s.cta_text || null,
    link_url: s.link_url || null,
    video_urls: videos,
    image_urls: images,
    platforms: a.publisher_platform || [],
    start_date: start,
    end_date: end,
    is_active: !!a.is_active,
    days_running: days,
    eu_total_reach: ai.eu_total_reach ?? null,
    reach_male: male || null,
    reach_female: female || null,
    reach_by_age: Object.keys(ages).length ? ages : null,
    target_age_min: ai.age_audience?.min ?? null,
    target_age_max: ai.age_audience?.max ?? null,
    target_gender: ai.gender_audience ?? null,
    target_locations: ai.location_audience ?? null,
    last_seen_at: new Date().toISOString(),
    raw: a,
  };
}

async function main() {
  const { data: competitors, error } = await db.from("lab_competitors").select("page_id,name").eq("active", true);
  if (error) throw error;
  if (!competitors.length) { console.log("No active competitors."); return; }
  console.log(`Competitors: ${competitors.map((c) => c.name).join(", ")}`);

  const { data: runRow, error: runErr } = await db.from("lab_runs").insert({ source: "apify:curious_coder" }).select().single();
  if (runErr) throw runErr;

  const input = {
    count: MAX_ADS,
    scrapeAdDetails: true,
    "scrapePageAds.activeStatus": "all",
    "scrapePageAds.countryCode": "ALL",
    "scrapePageAds.sortBy": "impressions_desc",
    urls: competitors.map((c) => ({
      url: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&view_all_page_id=${c.page_id}`,
    })),
  };

  const started = await apify(`/acts/${ACTOR}/runs?maxTotalChargeUsd=${MAX_COST}`, { method: "POST", body: JSON.stringify(input) });
  const runId = started.data.id;
  await db.from("lab_runs").update({ apify_run_id: runId }).eq("id", runRow.id);
  console.log(`Apify run ${runId} started`);

  let run;
  for (;;) {
    await sleep(15000);
    run = (await apify(`/actor-runs/${runId}`)).data;
    if (!["READY", "RUNNING"].includes(run.status)) break;
  }
  console.log(`Apify run finished: ${run.status}`);

  const items = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json`);
  const ads = items.filter((a) => a.ad_archive_id).map(mapAd);

  // Only keep ads from pages we track (keyword noise, reshared posts, etc. are dropped)
  const tracked = new Set(competitors.map((c) => c.page_id));
  const kept = ads.filter((a) => tracked.has(a.page_id));

  // Upsert in chunks; first_seen_at keeps its default on insert and is never overwritten
  for (let i = 0; i < kept.length; i += 200) {
    const { error: e } = await db.from("lab_ads").upsert(kept.slice(i, i + 200), { onConflict: "ad_archive_id" });
    if (e) throw e;
  }
  const snaps = kept.map((a) => ({
    ad_archive_id: a.ad_archive_id,
    run_id: runRow.id,
    snapshot_date: today,
    is_active: a.is_active,
    end_date: a.end_date,
    eu_total_reach: a.eu_total_reach,
    collation_count: a.raw.collation_count ?? null,
  }));
  for (let i = 0; i < snaps.length; i += 500) {
    const { error: e } = await db.from("lab_ad_snapshots").upsert(snaps.slice(i, i + 500), { onConflict: "ad_archive_id,snapshot_date" });
    if (e) throw e;
  }

  const claimed = items.reduce((m, a) => Math.max(m, a.total || 0), 0) || null;
  await db.from("lab_runs").update({
    finished_at: new Date().toISOString(),
    status: run.status === "SUCCEEDED" ? "succeeded" : run.status.toLowerCase(),
    ads_returned: kept.length,
    claimed_total: claimed,
    cost_usd: run.usageTotalUsd ?? run.stats?.computeUnits ?? null,
    notes: `${items.length} items from Apify, ${kept.length} kept for ${competitors.length} competitors`,
  }).eq("id", runRow.id);

  console.log(`Stored ${kept.length} ads (${kept.filter((a) => a.is_active).length} active).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
