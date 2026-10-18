#!/usr/bin/env node
/**
 * Creative Lab — competitor ad ingest (runs weekly on Railway, Mondays 05:00 UTC).
 *
 * - Brands due for a scan (tier interval in lab_competitors.scan_every_days) are scanned via the
 *   Apify actor curious_coder/facebook-ads-library-scraper, with ad details (EU reach, audience).
 * - First scan of a brand pulls its full history (active + inactive). Later scans pull active ads
 *   only; ads that vanished from the active list are marked ended (completeness-guarded).
 * - Ads go to lab_ads (latest state) and lab_ad_snapshots (one row per ad per scan day).
 * - Media goes to R2: every image, every video (kept 30 days, permanently for winner-signal ads).
 *
 * Env: APIFY_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_* (optional)
 * Optional: LAB_MAX_ADS / LAB_MAX_COST_USD (incremental caps), LAB_BACKFILL_MAX_ADS /
 *           LAB_BACKFILL_MAX_COST_USD (backfill caps), LAB_VIDEO_BUFFER_DAYS, LAB_FORCE=1 (scan all now)
 *
 * Run: node scripts/lab/ingest.mjs
 */
import { createClient } from "@supabase/supabase-js";

const ACTOR = "curious_coder~facebook-ads-library-scraper";
const { APIFY_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

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
  const images = [...(s.images || []), ...cards, ...(s.videos || [])]
    .map((i) => i.original_image_url || i.resized_image_url || i.video_preview_image_url).filter(Boolean);

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
    ended_detected: false,
    collation_count: a.collation_count ?? null,
  };
}

/* ── Media archive (Cloudflare R2) ─────────────────────────────────────────────
 * Meta's CDN links expire after ~4 days, so copies go to R2 when an ad is first seen:
 * the image of every ad and the video of every video ad. Videos of ads that never
 * show winner signals (see markKeepers) are deleted again after VIDEO_BUFFER_DAYS.
 */
const VIDEO_BUFFER_DAYS = Number(process.env.LAB_VIDEO_BUFFER_DAYS || 30);
const MAX_ARCHIVE_MB = Number(process.env.LAB_MAX_ARCHIVE_MB || 5000);

let _s3 = null;
async function r2() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) return null;
  if (!_s3) {
    const sdk = await import("@aws-sdk/client-s3");
    _s3 = {
      sdk,
      client: new sdk.S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      }),
      bucket: R2_BUCKET_NAME,
      base: R2_PUBLIC_URL.replace(/\/$/, ""),
    };
  }
  return _s3;
}

async function existingRows(ids, columns) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db.from("lab_ads").select(columns).in("ad_archive_id", ids.slice(i, i + 500));
    if (error) throw error;
    out.push(...(data ?? []));
  }
  return out;
}

async function archiveMedia(ads) {
  const s3 = await r2();
  if (!s3) { console.log("R2 not configured — skipping media archive."); return { files: 0, bytes: 0 }; }

  const stored = new Map((await existingRows(ads.map((a) => a.ad_archive_id), "ad_archive_id, archived_media"))
    .map((r) => [r.ad_archive_id, r.archived_media ?? []]));

  let files = 0, bytes = 0;
  const queue = ads.filter((a) => {
    const kinds = new Set((stored.get(a.ad_archive_id) ?? []).map((m) => m.kind));
    const needImage = a.image_urls.length > 0 && !kinds.has("image");
    const needVideo = a.video_urls.length > 0 && !kinds.has("video");
    return needImage || needVideo;
  });

  const worker = async () => {
    while (queue.length && bytes < MAX_ARCHIVE_MB * 1e6) {
      const ad = queue.shift();
      const media = [...(stored.get(ad.ad_archive_id) ?? [])];
      const kinds = new Set(media.map((m) => m.kind));
      const jobs = [
        ...(!kinds.has("image") ? ad.image_urls.slice(0, 1).map((url) => ({ kind: "image", url })) : []),
        ...(!kinds.has("video") ? ad.video_urls.slice(0, 1).map((url) => ({ kind: "video", url })) : []),
      ];
      for (const j of jobs) {
        try {
          const res = await fetch(j.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const type = res.headers.get("content-type") || (j.kind === "video" ? "video/mp4" : "image/jpeg");
          const ext = j.kind === "video" ? "mp4" : type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
          const key = `lab/${ad.page_id}/${ad.ad_archive_id}/${j.kind}.${ext}`;
          await s3.client.send(new s3.sdk.PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: buf, ContentType: type }));
          media.push({ kind: j.kind, url: `${s3.base}/${key}`, key, bytes: buf.length, archived_at: new Date().toISOString() });
          files++; bytes += buf.length;
        } catch (e) {
          console.warn(`Media failed for ${ad.ad_archive_id}: ${e.message}`);
        }
      }
      await db.from("lab_ads").update({ archived_media: media }).eq("ad_archive_id", ad.ad_archive_id);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`Archived ${files} media files (${(bytes / 1e6).toFixed(1)} MB) to R2.`);
  return { files, bytes };
}

/* ── Winner signals ───────────────────────────────────────────────────────────
 * An ad's video is kept permanently (keep_video) when ANY of these hold:
 *  - it ran 14+ days
 *  - its reach per day is in the top 20% of that advertiser's ads (EU ads only)
 *  - its concept was brought back: ads with the same copy or variant group started 14+ days apart
 *  - its variant group has 3+ ads (they invested in sizes/placements)
 * keep_video never flips back to false.
 */
async function markKeepers(pageIds) {
  for (const pageId of pageIds) {
    const { data: rows, error } = await db.from("lab_ads")
      .select("ad_archive_id, collation_id, body, start_date, days_running, eu_total_reach, keep_video")
      .eq("page_id", pageId);
    if (error) throw error;

    const perDay = rows.filter((r) => r.eu_total_reach && r.days_running)
      .map((r) => r.eu_total_reach / r.days_running).sort((a, b) => a - b);
    const p80 = perDay.length >= 5 ? perDay[Math.floor(perDay.length * 0.8)] : Infinity;

    const groups = new Map();
    for (const r of rows) {
      for (const k of [r.collation_id && `c:${r.collation_id}`, r.body && `b:${r.body.split("\n")[0].trim().slice(0, 60)}`].filter(Boolean)) {
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
    }
    const relaunched = new Set(), invested = new Set();
    for (const [k, list] of groups) {
      const starts = list.map((r) => r.start_date).filter(Boolean).sort();
      if (starts.length >= 2 && (new Date(starts.at(-1)) - new Date(starts[0])) / 864e5 >= 14) list.forEach((r) => relaunched.add(r.ad_archive_id));
      if (k.startsWith("c:") && list.length >= 3) list.forEach((r) => invested.add(r.ad_archive_id));
    }

    const keep = rows.filter((r) => !r.keep_video && (
      (r.days_running ?? 0) >= 14 ||
      (r.eu_total_reach && r.days_running && r.eu_total_reach / r.days_running >= p80) ||
      relaunched.has(r.ad_archive_id) || invested.has(r.ad_archive_id)
    )).map((r) => r.ad_archive_id);
    for (let i = 0; i < keep.length; i += 500) {
      await db.from("lab_ads").update({ keep_video: true }).in("ad_archive_id", keep.slice(i, i + 500));
    }
    if (keep.length) console.log(`${pageId}: ${keep.length} more ads marked as keepers.`);
  }
}

/** Delete buffered videos of non-keepers once they are older than VIDEO_BUFFER_DAYS. */
async function pruneVideos() {
  const s3 = await r2();
  if (!s3) return 0;
  const cutoff = Date.now() - VIDEO_BUFFER_DAYS * 864e5;
  const { data, error } = await db.from("lab_ads").select("ad_archive_id, archived_media")
    .eq("keep_video", false).eq("is_active", false).limit(5000);
  if (error) throw error;
  let removed = 0;
  for (const r of data ?? []) {
    const media = r.archived_media ?? [];
    const old = media.filter((m) => m.kind === "video" && m.key && m.archived_at && Date.parse(m.archived_at) < cutoff);
    if (!old.length) continue;
    for (const m of old) {
      try { await s3.client.send(new s3.sdk.DeleteObjectCommand({ Bucket: s3.bucket, Key: m.key })); removed++; }
      catch (e) { console.warn(`Delete failed ${m.key}: ${e.message}`); }
    }
    await db.from("lab_ads").update({ archived_media: media.filter((m) => !old.includes(m)) }).eq("ad_archive_id", r.ad_archive_id);
  }
  if (removed) console.log(`Pruned ${removed} buffered videos past ${VIDEO_BUFFER_DAYS} days.`);
  return removed;
}

/* ── Scanning ─────────────────────────────────────────────────────────────────
 * First scan of a brand (backfill): all ads, active and inactive.
 * Later scans (incremental): active ads only (~5x cheaper). An ad that was active
 * before and is missing now is marked ended, with its last-seen day as end date.
 */
async function runActor(competitors, activeStatus, maxAds, maxCost) {
  const input = {
    count: maxAds,
    scrapeAdDetails: true,
    "scrapePageAds.activeStatus": activeStatus,
    "scrapePageAds.countryCode": "ALL",
    "scrapePageAds.sortBy": "impressions_desc",
    urls: competitors.map((c) => ({
      url: `https://www.facebook.com/ads/library/?active_status=${activeStatus}&ad_type=all&country=ALL&view_all_page_id=${c.page_id}`,
    })),
  };
  // The actor requires at least one input URL per 512 MB of memory, and Apify memory must be a
  // power of two: use the largest power of two <= 512 MB x URLs, capped at 4 GB.
  let memory = 512;
  while (memory * 2 <= Math.min(4096, 512 * competitors.length)) memory *= 2;
  // LAB_REUSE_APIFY_RUN=<runId> re-processes a finished run instead of scraping again (no new Apify cost)
  const reuse = process.env.LAB_REUSE_APIFY_RUN;
  const runId = reuse || (await apify(`/acts/${ACTOR}/runs?maxTotalChargeUsd=${maxCost}&memory=${memory}`, { method: "POST", body: JSON.stringify(input) })).data.id;
  if (reuse) console.log(`Re-using Apify run ${reuse}`);
  console.log(`Apify run ${runId} (${activeStatus}, ${memory} MB) started for ${competitors.length} brands`);
  let run;
  for (;;) {
    await sleep(15000);
    run = (await apify(`/actor-runs/${runId}`)).data;
    if (!["READY", "RUNNING"].includes(run.status)) break;
  }
  console.log(`Apify run ${runId} finished: ${run.status}`);
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json&offset=${offset}&limit=1000`);
    items.push(...page);
    if (page.length < 1000) break;
  }
  return { runId, run, items };
}

async function storeAds(kept, runRowId) {
  // Small batches keep each statement well under Supabase's statement timeout
  const rows = kept.map(({ collation_count, ...r }) => r);
  for (let i = 0; i < rows.length; i += 50) {
    const { error } = await db.from("lab_ads").upsert(rows.slice(i, i + 50), { onConflict: "ad_archive_id" });
    if (error) throw error;
  }
  const snaps = kept.map((a) => ({
    ad_archive_id: a.ad_archive_id, run_id: runRowId, snapshot_date: today,
    is_active: a.is_active, end_date: a.end_date, eu_total_reach: a.eu_total_reach,
    collation_count: a.collation_count ?? null,
  }));
  for (let i = 0; i < snaps.length; i += 200) {
    const { error } = await db.from("lab_ad_snapshots").upsert(snaps.slice(i, i + 200), { onConflict: "ad_archive_id,snapshot_date" });
    if (error) throw error;
  }
}

/** Incremental scans only: ads we had as active that did not come back are marked ended. */
async function detectEnded(competitors, returned, runRowId) {
  const returnedIds = new Set(returned.map((a) => a.ad_archive_id));
  let ended = 0;
  const notes = [];
  for (const c of competitors) {
    const { data: wasActive, error } = await db.from("lab_ads")
      .select("ad_archive_id, last_seen_at, start_date, eu_total_reach")
      .eq("page_id", c.page_id).eq("is_active", true);
    if (error) throw error;
    const back = returned.filter((a) => a.page_id === c.page_id).length;
    // Completeness guard: a scan that returned far fewer ads than we knew were running is
    // more likely cut off than a mass shutdown, so it cannot vouch for anything having ended.
    if (wasActive.length >= 10 && back < wasActive.length * 0.5) {
      notes.push(`${c.name}: only ${back}/${wasActive.length} active ads returned, end detection skipped`);
      continue;
    }
    const gone = wasActive.filter((r) => !returnedIds.has(r.ad_archive_id));
    for (const r of gone) {
      const end = r.last_seen_at.slice(0, 10);
      const days = r.start_date ? Math.round((new Date(end) - new Date(r.start_date)) / 864e5) + 1 : null;
      await db.from("lab_ads").update({ is_active: false, end_date: end, days_running: days, ended_detected: true }).eq("ad_archive_id", r.ad_archive_id);
      await db.from("lab_ad_snapshots").upsert({
        ad_archive_id: r.ad_archive_id, run_id: runRowId, snapshot_date: today,
        is_active: false, end_date: end, eu_total_reach: r.eu_total_reach,
      }, { onConflict: "ad_archive_id,snapshot_date" });
    }
    ended += gone.length;
  }
  return { ended, notes };
}

async function scanGroup(competitors, mode) {
  if (!competitors.length) return;
  const backfill = mode === "backfill";
  const maxAds = Number(backfill ? process.env.LAB_BACKFILL_MAX_ADS || 30000 : process.env.LAB_MAX_ADS || 20000);
  const maxCost = Number(backfill ? process.env.LAB_BACKFILL_MAX_COST_USD || 25 : process.env.LAB_MAX_COST_USD || 10);

  const { data: runRow, error } = await db.from("lab_runs").insert({ source: "apify:curious_coder", mode }).select().single();
  if (error) throw error;

  const { runId, run, items } = await runActor(competitors, backfill ? "all" : "active", maxAds, maxCost);
  await db.from("lab_runs").update({ apify_run_id: runId }).eq("id", runRow.id);

  const tracked = new Set(competitors.map((c) => c.page_id));
  const kept = items.filter((a) => a.ad_archive_id).map(mapAd).filter((a) => tracked.has(a.page_id));
  await storeAds(kept, runRow.id);

  // A run that returns nothing at all (e.g. rejected input, blocked scan) is not trusted:
  // it must not mark brands as backfilled or ads as ended.
  if (run.status === "SUCCEEDED" && items.length === 0) console.warn(`Apify run ${runId} returned no items: ${run.statusMessage ?? ""}`);
  const succeeded = run.status === "SUCCEEDED" && items.length > 0;
  const endInfo = !backfill && succeeded ? await detectEnded(competitors, kept, runRow.id) : { ended: 0, notes: [] };

  await markKeepers([...tracked]);
  const archived = await archiveMedia(kept);

  const now = new Date().toISOString();
  if (succeeded) {
    for (const c of competitors) {
      await db.from("lab_competitors").update({ last_scan_at: now, ...(backfill ? { backfilled_at: now } : {}) }).eq("page_id", c.page_id);
    }
  }
  await db.from("lab_runs").update({
    finished_at: now,
    status: succeeded ? "succeeded" : items.length === 0 && run.status === "SUCCEEDED" ? "empty" : run.status.toLowerCase(),
    ads_returned: kept.length,
    claimed_total: items.reduce((m, a) => Math.max(m, a.total || 0), 0) || null,
    cost_usd: run.usageTotalUsd ?? null,
    notes: [
      `${mode}: ${kept.length} ads for ${competitors.length} brands (${competitors.map((c) => c.name).join(", ")})`,
      backfill ? null : `${endInfo.ended} ads detected as ended`,
      `media archived: ${archived.files} files, ${(archived.bytes / 1e6).toFixed(1)} MB`,
      ...endInfo.notes,
      !succeeded && run.statusMessage ? `actor: ${run.statusMessage}` : null,
    ].filter(Boolean).join("; "),
  }).eq("id", runRow.id);
  console.log(`${mode}: stored ${kept.length} ads, ${endInfo.ended} ended, ${archived.files} media files.`);
}

async function main() {
  const { data: competitors, error } = await db.from("lab_competitors")
    .select("page_id, name, tier, scan_every_days, backfilled_at, last_scan_at").eq("active", true);
  if (error) throw error;

  // Due when never scanned, or the tier's interval has passed (1 day slack for cron timing)
  const due = competitors.filter((c) => !c.last_scan_at ||
    Date.now() - Date.parse(c.last_scan_at) >= (c.scan_every_days - 1) * 864e5 || process.env.LAB_FORCE === "1");
  console.log(`Competitors: ${competitors.length}, due now: ${due.map((c) => c.name).join(", ") || "none"}`);

  await scanGroup(due.filter((c) => !c.backfilled_at), "backfill");
  await scanGroup(due.filter((c) => c.backfilled_at), "incremental");
  await pruneVideos();
}

main().catch((e) => { console.error(e); process.exit(1); });
