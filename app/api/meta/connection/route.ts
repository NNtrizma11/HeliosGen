/**
 * /api/meta/connection
 *   GET    → { connected, connection, accounts, oauthAvailable }
 *   POST   { token } → validate + store a token, register its ad accounts
 *   PATCH  { account_id, sync_enabled?, market? } → choose which accounts sync
 *   DELETE → disconnect (removes the token; synced data stays)
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";
import { connectToken, getConnection } from "@/lib/meta";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [connection, { data: accounts }] = await Promise.all([
    getConnection(),
    supabaseAdmin.from("meta_ad_accounts").select("*").order("name"),
  ]);
  return NextResponse.json({
    connected: !!connection,
    connection,
    accounts: accounts ?? [],
    oauthAvailable: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
  });
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const token = String(body.token ?? "").trim();
  if (token.length < 50) return NextResponse.json({ error: "Paste the full access token." }, { status: 400 });
  try {
    const result = await connectToken(token, userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = String(body.account_id ?? "");
  const patch: Record<string, unknown> = {};
  if (typeof body.sync_enabled === "boolean") patch.sync_enabled = body.sync_enabled;
  if (typeof body.market === "string") patch.market = body.market.toUpperCase().slice(0, 4) || null;
  if (!id || !Object.keys(patch).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  const { error } = await supabaseAdmin.from("meta_ad_accounts").update(patch).eq("account_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await supabaseAdmin.from("meta_connections").delete().gte("id", 0);
  return NextResponse.json({ ok: true });
}
