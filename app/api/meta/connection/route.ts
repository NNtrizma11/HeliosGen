/**
 * /api/meta/connection
 *   GET    → { connected, connections, accounts, oauthAvailable }
 *   POST   { token } → validate + store a token, register its ad accounts
 *   PATCH  { account_id, sync_enabled?, market? } → choose which accounts sync
 *   DELETE ?id=… → remove one connection (synced data stays)
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";
import { canSeeAccount, connectToken, listConnections, removeConnection, visibleAccountIds, visibleConnectionIds } from "@/lib/meta";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ids = await visibleAccountIds(userId);
  let accQ = supabaseAdmin.from("meta_ad_accounts").select("*").order("name");
  if (ids) accQ = accQ.in("account_id", ids.length ? ids : ["-"]);
  const [connections, { data: accounts }] = await Promise.all([listConnections(userId), accQ]);
  return NextResponse.json({
    connected: connections.length > 0,
    connections,
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
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = String(body.account_id ?? "");
  if (id && !(await canSeeAccount(userId, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const patch: Record<string, unknown> = {};
  if (typeof body.sync_enabled === "boolean") patch.sync_enabled = body.sync_enabled;
  if (typeof body.market === "string") patch.market = body.market.toUpperCase().slice(0, 4) || null;
  if (!id || !Object.keys(patch).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  const { error } = await supabaseAdmin.from("meta_ad_accounts").update(patch).eq("account_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const conns = await visibleConnectionIds(userId);
  if (conns && !conns.includes(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await removeConnection(id);
  return NextResponse.json({ ok: true });
}
