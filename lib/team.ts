/**
 * Team access (server only). Members of the same team can open and edit each
 * other's canvases through the normal /workflow/<id> link.
 *
 * Tables: teams, team_members (team_id, email, user_id|null, role). An invite is a
 * member row with user_id null; it is claimed the first time that email signs in.
 * A user may belong to several teams; teammates = everyone in any of their teams.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface Me { id: string; email: string }

/** Resolve the signed-in user (id + email) from the request's bearer token. */
export async function currentUser(req: Request): Promise<Me | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  if (!data.user) return null;
  return { id: data.user.id, email: (data.user.email ?? "").toLowerCase() };
}

/** Attach pending invites for this email to the user. */
export async function claimInvites(me: Me): Promise<void> {
  if (!me.email) return;
  await supabaseAdmin.from("team_members").update({ user_id: me.id }).is("user_id", null).ilike("email", me.email);
}

/** Team ids the user belongs to. */
export async function myTeamIds(me: Me): Promise<string[]> {
  const { data } = await supabaseAdmin.from("team_members").select("team_id").eq("user_id", me.id);
  return [...new Set<string>((data ?? []).map((r: { team_id: string }) => r.team_id))];
}

/** User ids of everyone sharing a team with the user (excluding the user). */
export async function teammateIds(me: Me): Promise<string[]> {
  const teams = await myTeamIds(me);
  if (!teams.length) return [];
  const { data } = await supabaseAdmin.from("team_members").select("user_id").in("team_id", teams).not("user_id", "is", null);
  return [...new Set<string>((data ?? []).map((r: { user_id: string }) => r.user_id))].filter((id) => id !== me.id);
}

/** Owner's team where the user is owner, created on first invite. */
export async function ensureOwnTeam(me: Me): Promise<string> {
  const { data } = await supabaseAdmin.from("team_members").select("team_id").eq("user_id", me.id).eq("role", "owner").limit(1);
  if (data?.[0]) return data[0].team_id as string;
  const { data: team, error } = await supabaseAdmin.from("teams").insert({ created_by: me.id, name: "Team" }).select("id").single();
  if (error || !team) throw new Error(error?.message ?? "Could not create the team.");
  await supabaseAdmin.from("team_members").insert({ team_id: team.id, email: me.email, user_id: me.id, role: "owner" });
  return team.id as string;
}

/** Find an existing account by email (small user base: list and match). */
export async function userIdByEmail(email: string): Promise<string | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** May the user open/edit this space? Returns the owner id, or null if not allowed / missing. */
export async function spaceAccess(me: Me, spaceId: string): Promise<{ ownerId: string; mine: boolean } | null> {
  const { data } = await supabaseAdmin.from("spaces").select("user_id").eq("id", spaceId).maybeSingle();
  if (!data) return null;
  const ownerId = data.user_id as string;
  if (ownerId === me.id) return { ownerId, mine: true };
  const mates = await teammateIds(me);
  return mates.includes(ownerId) ? { ownerId, mine: false } : null;
}

/** Emails for a set of user ids. */
export async function emailsFor(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const { data } = await supabaseAdmin.from("team_members").select("user_id,email").in("user_id", ids);
  return Object.fromEntries((data ?? []).map((r) => [r.user_id as string, r.email as string]));
}
