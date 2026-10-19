/**
 * /api/meta/iterate
 *   GET  ?ad_id=…  → saved suggestion sets for an ad (newest first)
 *   POST { ad_id } → diagnose the ad against its account and ask Claude (via Kie) for
 *                    iterations (fix the weak part, keep what works) and variations (new
 *                    versions of what works). Copy is written in the market's language.
 */
import { NextRequest, NextResponse } from "next/server";
import { askClaude } from "@/lib/kieClaude";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";
import { getKieToken } from "@/lib/getKieToken";

export const dynamic = "force-dynamic";
export const maxDuration = 300;


const LANGUAGE: Record<string, string> = { BG: "Bulgarian", RO: "Romanian", HU: "Hungarian", CZ: "Czech" };

const BRAND_CONTEXT = `BRAND: Nutrizma — creatine monohydrate gummies (5 g creatine in 3 gummies; flavors Blueberry, Strawberry, Green Apple, Mango), plus Creatine + Electrolytes sachets and Mood Reset gummies.
Positioning: "Built for Consistency" / "Consistency Starts Here". Aspirational, for people roughly 28–40 ("life can begin at 30"), not a senior brand.
Key audiences: men 35+ (energy, strength), women 40+ (muscle preservation), runners, pilates. Real converters skew male.
Common objections: doubt that it works, "creatine is only for bodybuilders", bloating, taste of powder, hassle of shakers.
Rules: EU health-claims rules apply. Never claim cognitive/brain benefits or cure/treat language. Keep to strength, performance, consistency, taste, convenience.
Payment is mostly cash on delivery in BG/RO.`;

type M = Record<string, number | null>;
const r = (x: number | null | undefined, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

async function sumAd(adId: string | null, accountId: string, since: string, until: string) {
  let q = supabaseAdmin.from("meta_ad_insights_daily")
    .select("spend,impressions,link_clicks,purchases,purchase_value,video_3s,thruplays,video_p25,video_p50,video_p75,video_p100")
    .eq("account_id", accountId).gte("date", since).lte("date", until).limit(100000);
  if (adId) q = q.eq("ad_id", adId);
  const { data } = await q;
  const s = { spend: 0, impressions: 0, link_clicks: 0, purchases: 0, purchase_value: 0, video_3s: 0, thruplays: 0, video_p25: 0, video_p50: 0, video_p75: 0, video_p100: 0 };
  for (const row of data ?? []) for (const k of Object.keys(s) as (keyof typeof s)[]) s[k] += Number(row[k] ?? 0);
  const d = (a: number, b: number) => (b > 0 ? a / b : null);
  return {
    spend: r(s.spend), impressions: s.impressions, purchases: r(s.purchases, 1),
    roas: r(d(s.purchase_value, s.spend)), cpa: r(d(s.spend, s.purchases)), ctr: r(d(s.link_clicks, s.impressions), 4),
    cvr: r(d(s.purchases, s.link_clicks), 4), hookRate: r(d(s.video_3s, s.impressions), 4), holdRate: r(d(s.thruplays, s.video_3s), 4),
    completion: r(d(s.video_p100, s.video_3s), 4),
  } as M;
}

/** Rule-based diagnosis: which stage of the funnel is weakest relative to the account. */
function diagnose(ad: M, acc: M, prev: M) {
  const findings: { stage: string; text: string }[] = [];
  if ((ad.impressions ?? 0) < 1000) return { weakest: "not_enough_data", findings: [{ stage: "data", text: "Under 1,000 impressions — too early to judge." }] };
  const low = (k: string, f = 0.8) => ad[k] != null && acc[k] != null && (ad[k] as number) < (acc[k] as number) * f;
  const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  if (low("hookRate")) findings.push({ stage: "hook", text: `Hook rate ${pct(ad.hookRate)} vs account ${pct(acc.hookRate)}: the first 3 seconds lose people.` });
  if (low("holdRate")) findings.push({ stage: "hold", text: `Hold rate ${pct(ad.holdRate)} vs account ${pct(acc.holdRate)}: the middle loses viewers.` });
  if (low("ctr")) findings.push({ stage: "click", text: `Link CTR ${pct(ad.ctr)} vs account ${pct(acc.ctr)}: people watch but don't click (CTA/offer).` });
  if (low("cvr")) findings.push({ stage: "conversion", text: `Conversion ${pct(ad.cvr)} vs account ${pct(acc.cvr)}: clicks don't buy (promise vs landing page mismatch).` });
  if (prev.ctr != null && ad.ctr != null && (ad.ctr as number) < (prev.ctr as number) * 0.8)
    findings.push({ stage: "fatigue", text: `CTR fell from ${pct(prev.ctr)} to ${pct(ad.ctr)} vs the previous period: likely creative fatigue.` });
  const order = ["hook", "hold", "click", "conversion", "fatigue"];
  const weakest = findings.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage))[0]?.stage ?? "none";
  return { weakest, findings };
}


function extractJson(text: string) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON in reply");
  return JSON.parse(text.slice(start, end + 1));
}

export async function GET(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const adId = req.nextUrl.searchParams.get("ad_id") ?? "";
  const { data, error } = await supabaseAdmin.from("meta_ad_iterations").select("*").eq("ad_id", adId).order("created_at", { ascending: false }).limit(10);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sets: data ?? [] });
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const apiKey = await getKieToken(req);
  if (!apiKey) return NextResponse.json({ error: "No Kie.ai API key configured. Add one in Settings." }, { status: 401 });

  const { ad_id } = await req.json().catch(() => ({}));
  const { data: ad } = await supabaseAdmin.from("meta_ads").select("*").eq("ad_id", String(ad_id ?? "")).single();
  if (!ad) return NextResponse.json({ error: "Ad not found" }, { status: 404 });
  const { data: account } = await supabaseAdmin.from("meta_ad_accounts").select("name, market, currency").eq("account_id", ad.account_id).single();

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date(Date.now() - 864e5);
  const d14 = iso(new Date(end.getTime() - 13 * 864e5)), d28 = iso(new Date(end.getTime() - 27 * 864e5)), d15 = iso(new Date(end.getTime() - 14 * 864e5));
  const [adNow, adPrev, accNow] = await Promise.all([
    sumAd(ad.ad_id, ad.account_id, d14, iso(end)),
    sumAd(ad.ad_id, ad.account_id, d28, d15),
    sumAd(null, ad.account_id, d14, iso(end)),
  ]);
  const diagnosis = diagnose(adNow, accNow, adPrev);

  // The account's best recent ads give the model proven patterns to borrow from
  const { data: recent } = await supabaseAdmin.from("meta_ad_insights_daily")
    .select("ad_id,spend,purchase_value").eq("account_id", ad.account_id).gte("date", d28).limit(100000);
  const agg = new Map<string, { spend: number; pv: number }>();
  for (const x of recent ?? []) {
    const a = agg.get(x.ad_id) ?? { spend: 0, pv: 0 };
    a.spend += Number(x.spend); a.pv += Number(x.purchase_value); agg.set(x.ad_id, a);
  }
  const winnerIds = [...agg.entries()].filter(([id, a]) => id !== ad.ad_id && a.spend > 20).sort((a, b) => b[1].pv / b[1].spend - a[1].pv / a[1].spend).slice(0, 3).map(([id]) => id);
  const { data: winners } = winnerIds.length
    ? await supabaseAdmin.from("meta_ads").select("ad_id,name,title,body").in("ad_id", winnerIds)
    : { data: [] as { ad_id: string; name: string; title: string; body: string }[] };

  const language = LANGUAGE[account?.market ?? ""] ?? "Bulgarian";
  const prompt = `You are a senior performance creative strategist for Meta ads.

${BRAND_CONTEXT}

MARKET: ${account?.name ?? ""} (${account?.market ?? "?"}). Write all ad copy, hooks, on-screen text and voiceover in ${language}, matching the formality of the original ad (formal or informal "you"). Write explanations in English.

THE AD (${ad.name ?? ad.ad_id}):
Campaign: ${ad.campaign_name ?? "?"} / Ad set: ${ad.adset_name ?? "?"}
Format: ${ad.video_id ? "video" : "image/other"}
Headline: ${ad.title ?? "—"}
Primary text: ${ad.body ?? "—"}

PERFORMANCE, last 14 days (ad vs account average):
${JSON.stringify({ ad: adNow, account: accNow, ad_previous_14_days: adPrev })}
(hookRate = 3-second views / impressions; holdRate = ThruPlays / 3-second views; ctr = link clicks / impressions; cvr = purchases / link clicks)

RULE-BASED DIAGNOSIS: weakest stage = ${diagnosis.weakest}
${diagnosis.findings.map((f) => `- ${f.text}`).join("\n") || "- No stage is clearly below the account average."}

BEST OTHER ADS IN THIS ACCOUNT (last 28 days, by ROAS) — patterns that work here:
${(winners ?? []).map((w) => `- ${w.name}: ${(w.title ?? "").slice(0, 120)} | ${(w.body ?? "").slice(0, 300)}`).join("\n") || "- none"}

TASK
1. Explain in 2–3 sentences what is working and what is holding this ad back, using the numbers.
2. List what to KEEP unchanged (the parts that work).
3. Give 3 ITERATIONS: same concept, change only the weak part (e.g. weak hook → 3 new hooks on the same body; weak click → new CTA/offer framing; fatigue → same script, new character/format). Each must be testable against the original.
4. Give 3 VARIATIONS: new versions that reuse what works (new angle, persona, or format) — for scaling, not fixing.
Each item: what changes, why (tie to a number), a hook line, a short script (max ~60 words of voiceover or on-screen text), and a visual direction usable for AI video/image generation.

Reply with JSON only, no prose before or after:
{"summary": string, "keep": [string], "items": [{"kind": "iteration"|"variation", "type": "hook"|"body"|"cta"|"offer"|"format"|"angle"|"persona"|"visual", "title": string, "what_changes": string, "why": string, "hook": string, "script": string, "visual_direction": string, "priority": 1|2|3}]}`;

  try {
    const { text: reply } = await askClaude(apiKey, [{ role: "user", content: prompt }], 6000);
    const suggestions = extractJson(reply);
    const { data: saved, error } = await supabaseAdmin.from("meta_ad_iterations").insert({
      ad_id: ad.ad_id, created_by: userId, metrics: { ad: adNow, account: accNow, previous: adPrev }, diagnosis, suggestions,
    }).select().single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ set: saved });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
