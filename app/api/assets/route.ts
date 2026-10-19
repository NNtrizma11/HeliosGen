/**
 * Brand asset library (packaging, product shots, logos, characters…), shared with the team.
 * GET                 → { assets: Asset[] }  (yours + teammates')
 * POST   { url, name, brand, category, tags?, mime?, width?, height?, notes? } → { asset }
 *        (files are uploaded first via /api/upload-asset, which returns the CDN url)
 * PATCH  { id, name?, brand?, category?, tags?, notes? } → { asset }
 * DELETE ?id=…
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentUser, claimInvites, teammateIds } from "@/lib/team";

export const dynamic = "force-dynamic";

const FIELDS = "id,user_id,brand,category,name,tags,url,mime,width,height,notes,created_at,updated_at";

const cleanTags = (t: unknown) =>
  Array.isArray(t) ? [...new Set(t.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 30) : undefined;

/** The user plus teammates — who can see and change these assets. */
async function scope(req: Request) {
  const me = await currentUser(req);
  if (!me) return null;
  await claimInvites(me);
  return { me, ids: [me.id, ...(await teammateIds(me))] };
}

export async function GET(req: NextRequest) {
  const s = await scope(req);
  if (!s) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await supabaseAdmin.from("brand_assets").select(FIELDS).in("user_id", s.ids).order("created_at", { ascending: false }).limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ assets: data ?? [] });
}

export async function POST(req: NextRequest) {
  const s = await scope(req);
  if (!s) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const url = String(b.url ?? "");
  if (!/^https?:\/\//.test(url)) return NextResponse.json({ error: "url required" }, { status: 400 });
  const row = {
    user_id: s.me.id,
    url,
    name: String(b.name ?? "").trim() || "Untitled",
    brand: String(b.brand ?? "").trim() || "Nutrizma",
    category: String(b.category ?? "").trim() || "Other",
    tags: cleanTags(b.tags) ?? [],
    mime: b.mime ? String(b.mime) : null,
    width: Number(b.width) || null,
    height: Number(b.height) || null,
    notes: b.notes ? String(b.notes) : null,
  };
  const { data, error } = await supabaseAdmin.from("brand_assets").insert(row).select(FIELDS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ asset: data });
}

export async function PATCH(req: NextRequest) {
  const s = await scope(req);
  if (!s) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!b.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ["name", "brand", "category", "notes"] as const) if (typeof b[k] === "string") patch[k] = (b[k] as string).trim();
  const tags = cleanTags(b.tags);
  if (tags) patch.tags = tags;
  const { data, error } = await supabaseAdmin.from("brand_assets").update(patch).eq("id", String(b.id)).in("user_id", s.ids).select(FIELDS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ asset: data });
}

export async function DELETE(req: NextRequest) {
  const s = await scope(req);
  if (!s) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabaseAdmin.from("brand_assets").delete().eq("id", id).in("user_id", s.ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
