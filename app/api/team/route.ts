/**
 * Team members.
 * GET    → { members: [{ email, role, pending, me }], canManage }
 * POST   { email } → invite (an existing account joins at once; otherwise on first sign-in)
 * DELETE ?email=… → remove (team owner only; you can always remove yourself)
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentUser, claimInvites, myTeamIds, ensureOwnTeam, userIdByEmail } from "@/lib/team";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const me = await currentUser(req);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await claimInvites(me);
  const teams = await myTeamIds(me);
  if (!teams.length) return NextResponse.json({ members: [], canManage: true });
  const { data } = await supabaseAdmin.from("team_members").select("team_id,email,user_id,role").in("team_id", teams).order("added_at");
  const { data: owned } = await supabaseAdmin.from("team_members").select("team_id").eq("user_id", me.id).eq("role", "owner");
  const seen = new Set<string>();
  const members = (data ?? []).filter((m) => { const k = String(m.email).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((m) => ({ email: m.email as string, role: m.role as string, pending: !m.user_id, me: m.user_id === me.id }));
  return NextResponse.json({ members, canManage: (owned ?? []).length > 0 });
}

export async function POST(req: NextRequest) {
  const me = await currentUser(req);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  const clean = (email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
  if (clean === me.email) return NextResponse.json({ error: "That's you." }, { status: 400 });
  try {
    const teamId = await ensureOwnTeam(me);
    const userId = await userIdByEmail(clean);
    const { error } = await supabaseAdmin.from("team_members")
      .upsert({ team_id: teamId, email: clean, user_id: userId, role: "member" }, { onConflict: "team_id,email" });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, pending: !userId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const me = await currentUser(req);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const email = (req.nextUrl.searchParams.get("email") ?? "").toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (email === me.email) {
    await supabaseAdmin.from("team_members").delete().eq("user_id", me.id).neq("role", "owner");
    return NextResponse.json({ ok: true });
  }
  const { data: owned } = await supabaseAdmin.from("team_members").select("team_id").eq("user_id", me.id).eq("role", "owner");
  const ids = (owned ?? []).map((r) => r.team_id as string);
  if (!ids.length) return NextResponse.json({ error: "Only the team owner can remove people." }, { status: 403 });
  await supabaseAdmin.from("team_members").delete().in("team_id", ids).ilike("email", email).neq("role", "owner");
  return NextResponse.json({ ok: true });
}
