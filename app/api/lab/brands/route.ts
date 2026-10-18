/**
 * /api/lab/brands
 *   GET    → every tracked brand with ad counts (lab_brand_stats view)
 *   POST   { url | page_id, name, market?, tier? } → start tracking a brand (scanned on the next run)
 *   PATCH  { page_id, active?, tier? } → pause / resume a brand or change its tier
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";

export const dynamic = "force-dynamic";

const TIER_DAYS: Record<string, number> = { A: 7, B: 28 };

/** Accepts a numeric page id, an Ad Library URL (view_all_page_id=… or id=…), or plain digits in a link. */
function parsePageId(input: string): string | null {
  const s = input.trim();
  if (/^\d{5,20}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const id = u.searchParams.get("view_all_page_id");
    if (id && /^\d+$/.test(id)) return id;
  } catch { /* not a URL */ }
  const m = s.match(/view_all_page_id=(\d+)/);
  return m ? m[1] : null;
}

export async function GET(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabaseAdmin.from("lab_brand_stats").select("*").order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ brands: data ?? [] });
}

export async function POST(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const pageId = parsePageId(String(body.page_id ?? body.url ?? ""));
  const name = String(body.name ?? "").trim();
  if (!pageId) return NextResponse.json({ error: "Paste the brand's Ad Library link (it contains view_all_page_id=…) or its page ID." }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Give the brand a name." }, { status: 400 });
  const tier = body.tier === "B" ? "B" : "A";
  const { error } = await supabaseAdmin.from("lab_competitors").upsert({
    page_id: pageId, name, market: body.market ? String(body.market).toUpperCase().slice(0, 4) : null,
    kind: body.kind ?? "direct", tier, scan_every_days: TIER_DAYS[tier], active: true,
  }, { onConflict: "page_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, page_id: pageId });
}

export async function PATCH(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const pageId = String(body.page_id ?? "");
  if (!pageId) return NextResponse.json({ error: "page_id required" }, { status: 400 });
  const patch: Record<string, unknown> = {};
  if (typeof body.active === "boolean") patch.active = body.active;
  if (body.tier === "A" || body.tier === "B") { patch.tier = body.tier; patch.scan_every_days = TIER_DAYS[body.tier]; }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  const { error } = await supabaseAdmin.from("lab_competitors").update(patch).eq("page_id", pageId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
