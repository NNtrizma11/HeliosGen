/**
 * One canvas, opened by its owner or a teammate.
 * GET → { space: { id, name, nodes, edges, nodeCounters, viewport, createdAt, updatedAt, isPublic }, mine, ownerId, ownerEmail }
 * PUT { name, data } → save a teammate's canvas (the owner stays the owner).
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentUser, claimInvites, spaceAccess, emailsFor } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await currentUser(req);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await claimInvites(me);
  const access = await spaceAccess(me, id);
  if (!access) return NextResponse.json({ error: "Not found or not shared with you." }, { status: 404 });
  const { data: row } = await supabaseAdmin.from("spaces").select("id,name,data,is_public,created_at").eq("id", id).single();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const createdAt = row.data?.createdAt ?? Date.parse(row.created_at);
  const ownerEmail = access.mine ? me.email : (await emailsFor([access.ownerId]))[access.ownerId] ?? "teammate";
  return NextResponse.json({
    space: {
      id: row.id, name: row.name,
      nodes: row.data?.nodes ?? [], edges: row.data?.edges ?? [],
      nodeCounters: row.data?.nodeCounters ?? {}, viewport: row.data?.viewport,
      createdAt, updatedAt: row.data?.updatedAt ?? createdAt, isPublic: row.is_public ?? false,
    },
    mine: access.mine, ownerId: access.ownerId, ownerEmail,
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await currentUser(req);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await spaceAccess(me, id);
  if (!access) return NextResponse.json({ error: "Not shared with you." }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { name?: string; data?: Record<string, unknown> } | null;
  if (!body?.data || !Array.isArray((body.data as { nodes?: unknown }).nodes)) {
    return NextResponse.json({ error: "data.nodes required" }, { status: 400 });
  }
  const { error } = await supabaseAdmin.from("spaces")
    .update({ name: body.name ?? undefined, data: body.data })
    .eq("id", id).eq("user_id", access.ownerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
