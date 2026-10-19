/**
 * Meta Marketing API: connection + sync for our own ad accounts.
 *
 * Data model (Supabase):
 *   meta_connections        one workspace-wide token (system user token preferred: it never expires)
 *   meta_ad_accounts        accounts the token can see; sync_enabled marks the ones we pull
 *   meta_ads                ad metadata + creative (copy, thumbnail)
 *   meta_ad_insights_daily  per ad per day: spend, impressions, purchases, video views…
 *   meta_insights_breakdown per account per day: age×gender, country, platform, device
 *
 * Sync strategy: first sync of an account pulls BACKFILL_DAYS; later syncs re-pull the last
 * REFRESH_DAYS (Meta keeps revising recent days as conversions attribute).
 */
import { supabaseAdmin } from "@/lib/supabase/admin";

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const BACKFILL_DAYS = Number(process.env.META_BACKFILL_DAYS || 90);
const REFRESH_DAYS = Number(process.env.META_REFRESH_DAYS || 4);
const BREAKDOWN_REFRESH_DAYS = Number(process.env.META_BREAKDOWN_REFRESH_DAYS || 2);

type Json = Record<string, unknown>;

export class MetaError extends Error {
  constructor(message: string, public code?: number) { super(message); }
}

async function graph(path: string, token: string, params: Record<string, string> = {}): Promise<Json> {
  const url = new URL(path.startsWith("http") ? path : `${GRAPH}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", token);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as Json;
    const err = json.error as { message?: string; code?: number; is_transient?: boolean } | undefined;
    if (res.ok && !err) return json;
    // 4/17/32/613 = rate limits, 1/2 = transient: back off and retry a few times
    const retryable = err && ([1, 2, 4, 17, 32, 613].includes(err.code ?? 0) || err.is_transient);
    if (retryable && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    throw new MetaError(err?.message ?? `Meta API ${res.status}`, err?.code);
  }
}

/** Follow paging.next until done (or until `max` rows). */
async function graphAll(path: string, token: string, params: Record<string, string>, max = 20000): Promise<Json[]> {
  const out: Json[] = [];
  let page = await graph(path, token, params);
  for (;;) {
    out.push(...((page.data as Json[]) ?? []));
    const next = (page.paging as { next?: string } | undefined)?.next;
    if (!next || out.length >= max) break;
    page = await graph(next, token);
  }
  return out;
}

/* ── Connections ────────────────────────────────────────────────────────────
 * Several connections can exist at once (different Facebook profiles / businesses, e.g. backup
 * ad-account structures). Each ad account remembers the connection that last saw it; a sync uses
 * that connection's token, falling back to any other connection that can still see the account.
 */

export async function listConnections() {
  const { data } = await supabaseAdmin.from("meta_connections")
    .select("id, token_type, meta_user_id, meta_user_name, expires_at, last_error, created_at").order("id");
  return data ?? [];
}

/** Token for an account: its own connection first, then every other connection as fallback. */
async function tokensFor(accountId: string): Promise<{ id: number; token: string }[]> {
  const [{ data: acc }, { data: all }] = await Promise.all([
    supabaseAdmin.from("meta_ad_accounts").select("connection_id").eq("account_id", accountId).maybeSingle(),
    supabaseAdmin.from("meta_connections").select("id, access_token").order("id", { ascending: false }),
  ]);
  const list = (all ?? []).map((c) => ({ id: c.id as number, token: c.access_token as string }));
  return list.sort((x, y) => Number(y.id === acc?.connection_id) - Number(x.id === acc?.connection_id));
}

/** Validate a token, store it (one per Facebook profile / system user), and register every ad account it can see. */
export async function connectToken(token: string, userId: string | null, tokenType = "system_user", expiresAt: string | null = null) {
  const me = await graph("me", token, { fields: "id,name" });
  const accounts = await graphAll("me/adaccounts", token, { fields: "account_id,name,currency,timezone_name,business{name},account_status", limit: "100" });
  if (!accounts.length) throw new MetaError("This login can't see any ad accounts. Give it access to the ad accounts first.");

  const { data: conn, error } = await supabaseAdmin.from("meta_connections").upsert({
    meta_user_id: String(me.id), access_token: token, token_type: tokenType, meta_user_name: me.name ?? null,
    expires_at: expiresAt, connected_by: userId, last_error: null,
  }, { onConflict: "meta_user_id" }).select("id").single();
  if (error) throw new Error(error.message);

  const rows = accounts.map((a) => ({
    account_id: String(a.account_id),
    name: String(a.name ?? a.account_id),
    currency: (a.currency as string) ?? null,
    timezone: (a.timezone_name as string) ?? null,
    business_name: ((a.business as Json | undefined)?.name as string) ?? null,
    account_status: num(a.account_status) || null,
    connection_id: conn.id as number,
  }));
  const { error: aErr } = await supabaseAdmin.from("meta_ad_accounts").upsert(rows, { onConflict: "account_id" });
  if (aErr) throw new Error(aErr.message);
  // New accounts get a market guess; existing ones keep whatever was set by hand
  for (const r of rows) {
    const market = guessMarket(r.name);
    if (market) await supabaseAdmin.from("meta_ad_accounts").update({ market }).eq("account_id", r.account_id).is("market", null);
  }
  return { name: me.name as string, accounts: rows };
}

export async function removeConnection(id: number) {
  await supabaseAdmin.from("meta_connections").delete().eq("id", id);
}

function guessMarket(name: string): string | null {
  const n = name.toLowerCase();
  if (/bulgaria|\bbg\b/.test(n)) return "BG";
  if (/romania|\bro\b/.test(n)) return "RO";
  if (/\bhu\b|hungary/.test(n)) return "HU";
  if (/\bcz\b|czech/.test(n)) return "CZ";
  return null;
}

/* ── Sync ───────────────────────────────────────────────────────────────── */

const day = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);

/** Sum the given action types from Meta's actions / action_values arrays (first type that exists wins). */
function pick(list: unknown, types: string[]): number {
  const arr = (list as { action_type: string; value: string }[] | undefined) ?? [];
  for (const t of types) {
    const hit = arr.find((a) => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}
const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const ATC = ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"];
const CHECKOUT = ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout"];
const firstVal = (list: unknown) => num(((list as { value: string }[] | undefined) ?? [])[0]?.value);

async function syncAds(accountId: string, token: string) {
  const ads = await graphAll(`act_${accountId}/ads`, token, {
    fields: "id,name,status,effective_status,created_time,campaign{id,name},adset{id,name},creative{id,title,body,call_to_action_type,thumbnail_url,image_url,video_id,object_story_spec,asset_feed_spec}",
    limit: "200",
    thumbnail_width: "480",
    thumbnail_height: "480",
  }, 10000);
  const rows = ads.map((a) => {
    const c = (a.creative as Json) ?? {};
    const oss = (c.object_story_spec as Json) ?? {};
    const vd = (oss.video_data as Json) ?? {};
    const ld = (oss.link_data as Json) ?? {};
    const afs = (c.asset_feed_spec as Json) ?? {};
    const firstText = (arr: unknown) => ((arr as { text?: string }[] | undefined) ?? [])[0]?.text ?? null;
    return {
      ad_id: String(a.id),
      account_id: accountId,
      name: (a.name as string) ?? null,
      status: (a.status as string) ?? null,
      effective_status: (a.effective_status as string) ?? null,
      created_time: (a.created_time as string) ?? null,
      campaign_id: ((a.campaign as Json)?.id as string) ?? null,
      campaign_name: ((a.campaign as Json)?.name as string) ?? null,
      adset_id: ((a.adset as Json)?.id as string) ?? null,
      adset_name: ((a.adset as Json)?.name as string) ?? null,
      creative_id: (c.id as string) ?? null,
      title: (c.title as string) ?? (vd.title as string) ?? (ld.name as string) ?? firstText(afs.titles),
      body: (c.body as string) ?? (vd.message as string) ?? (ld.message as string) ?? firstText(afs.bodies),
      cta_type: (c.call_to_action_type as string) ?? null,
      link_url: (ld.link as string) ?? (((vd.call_to_action as Json)?.value as Json)?.link as string) ?? null,
      thumbnail_url: (c.thumbnail_url as string) ?? null,
      image_url: (c.image_url as string) ?? (vd.image_url as string) ?? null,
      video_id: (c.video_id as string) ?? (vd.video_id as string) ?? null,
      updated_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabaseAdmin.from("meta_ads").upsert(rows.slice(i, i + 200), { onConflict: "ad_id" });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

/** Split [since, until] into windows of `size` days so each insights request stays small. */
function windows(since: Date, until: Date, size: number): [string, string][] {
  const out: [string, string][] = [];
  for (let s = new Date(since); s <= until; s = new Date(s.getTime() + size * 864e5)) {
    const e = new Date(Math.min(until.getTime(), s.getTime() + (size - 1) * 864e5));
    out.push([day(s), day(e)]);
  }
  return out;
}

async function syncInsights(accountId: string, token: string, since: Date, until: Date) {
  let total = 0;
  for (const [s, e] of windows(since, until, 7)) {
    const rows = await graphAll(`act_${accountId}/insights`, token, {
      level: "ad",
      time_increment: "1",
      time_range: JSON.stringify({ since: s, until: e }),
      fields: "ad_id,date_start,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values,video_thruplay_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions",
      use_account_attribution_setting: "true",
      limit: "500",
    }, 100000);
    const mapped = rows.map((r) => ({
      ad_id: String(r.ad_id),
      account_id: accountId,
      date: String(r.date_start),
      spend: num(r.spend),
      impressions: num(r.impressions),
      reach: num(r.reach),
      clicks: num(r.clicks),
      link_clicks: num(r.inline_link_clicks),
      purchases: pick(r.actions, PURCHASE),
      purchase_value: pick(r.action_values, PURCHASE),
      add_to_cart: pick(r.actions, ATC),
      checkouts: pick(r.actions, CHECKOUT),
      video_3s: pick(r.actions, ["video_view"]),
      thruplays: firstVal(r.video_thruplay_watched_actions),
      video_p25: firstVal(r.video_p25_watched_actions),
      video_p50: firstVal(r.video_p50_watched_actions),
      video_p75: firstVal(r.video_p75_watched_actions),
      video_p100: firstVal(r.video_p100_watched_actions),
    }));
    for (let i = 0; i < mapped.length; i += 300) {
      const { error } = await supabaseAdmin.from("meta_ad_insights_daily").upsert(mapped.slice(i, i + 300), { onConflict: "ad_id,date" });
      if (error) throw new Error(error.message);
    }
    total += mapped.length;
  }
  return total;
}

const BREAKDOWNS: { name: string; param: string; keys: [string, string?] }[] = [
  { name: "age_gender", param: "age,gender", keys: ["age", "gender"] },
  { name: "country", param: "country", keys: ["country"] },
  { name: "platform", param: "publisher_platform", keys: ["publisher_platform"] },
  { name: "device", param: "impression_device", keys: ["impression_device"] },
];

async function syncBreakdowns(accountId: string, token: string, since: Date, until: Date) {
  let total = 0;
  for (const b of BREAKDOWNS) {
    for (const [s, e] of windows(since, until, 30)) {
      const rows = await graphAll(`act_${accountId}/insights`, token, {
        level: "account",
        time_increment: "1",
        breakdowns: b.param,
        time_range: JSON.stringify({ since: s, until: e }),
        fields: "date_start,spend,impressions,actions,action_values",
        use_account_attribution_setting: "true",
        limit: "500",
      });
      const mapped = rows.map((r) => ({
        account_id: accountId,
        date: String(r.date_start),
        breakdown: b.name,
        key1: String(r[b.keys[0]] ?? "unknown"),
        key2: b.keys[1] ? String(r[b.keys[1]] ?? "unknown") : "",
        spend: num(r.spend),
        impressions: num(r.impressions),
        purchases: pick(r.actions, PURCHASE),
        purchase_value: pick(r.action_values, PURCHASE),
      }));
      for (let i = 0; i < mapped.length; i += 500) {
        const { error } = await supabaseAdmin.from("meta_insights_breakdown").upsert(mapped.slice(i, i + 500), { onConflict: "account_id,date,breakdown,key1,key2" });
        if (error) throw new Error(error.message);
      }
      total += mapped.length;
    }
  }
  return total;
}

export async function syncAccount(accountId: string, opts: { full?: boolean } = {}) {
  const tokens = await tokensFor(accountId);
  if (!tokens.length) throw new MetaError("Meta is not connected.");
  const { data: acc } = await supabaseAdmin.from("meta_ad_accounts").select("backfilled_at").eq("account_id", accountId).single();
  const full = opts.full || !acc?.backfilled_at;
  const until = new Date();
  const since = new Date(until.getTime() - ((full ? BACKFILL_DAYS : REFRESH_DAYS) - 1) * 864e5);
  let lastError: unknown = null;
  for (const { id, token } of tokens) {
    try {
      const ads = await syncAds(accountId, token);
      const rows = await syncInsights(accountId, token, since, until);
      // Breakdowns change slowly: on frequent incremental runs only the last couple of days are refreshed
      const bSince = full ? since : new Date(until.getTime() - (BREAKDOWN_REFRESH_DAYS - 1) * 864e5);
      const breakdownRows = await syncBreakdowns(accountId, token, bSince, until);
      const now = new Date().toISOString();
      await supabaseAdmin.from("meta_ad_accounts").update({
        last_sync_at: now, last_sync_error: null, connection_id: id, ...(full ? { backfilled_at: now } : {}),
      }).eq("account_id", accountId);
      return { accountId, ads, rows, breakdownRows, since: day(since), until: day(until), full };
    } catch (e) {
      lastError = e;
      // 190 = token expired/revoked; 10/200/272 = no permission on this account: try the next connection
      const code = e instanceof MetaError ? e.code : undefined;
      if (code === 190) await supabaseAdmin.from("meta_connections").update({ last_error: "Login expired or revoked: reconnect" }).eq("id", id);
      if (![190, 10, 200, 272, 100].includes(code ?? -1)) break;
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  await supabaseAdmin.from("meta_ad_accounts").update({ last_sync_error: msg.slice(0, 500) }).eq("account_id", accountId);
  throw lastError;
}

export async function syncAll() {
  const { data } = await supabaseAdmin.from("meta_ad_accounts").select("account_id").eq("sync_enabled", true);
  const results: unknown[] = [];
  for (const a of data ?? []) {
    try { results.push(await syncAccount(a.account_id as string)); }
    catch (e) { results.push({ accountId: a.account_id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return results;
}
