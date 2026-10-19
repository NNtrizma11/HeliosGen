/**
 * GET → teammates' canvases for the dashboard: { spaces: [{ id, name, ownerEmail, createdAt, updatedAt, media }] }
 * media = up to 4 thumbnails, so the full node data isn't sent.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentUser, claimInvites, teammateIds, emailsFor } from "@/lib/team";

export const dynamic = "force-dynamic";

type N = { data?: { r2Url?: unknown; imageUrl?: unknown; videoUrl?: unknown } };

export async function GET(req: NextRequest) {
  const me = await currentUser(req);
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await claimInvites(me);
  const mates = await teammateIds(me);
  if (!mates.length) return NextResponse.json({ spaces: [] });
  const [{ data, error }, emails] = await Promise.all([
    supabaseAdmin.from("spaces").select("id,name,user_id,data,created_at").in("user_id", mates),
    emailsFor(mates),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const spaces = (data ?? []).map((row) => {
    const nodes = ((row.data?.nodes ?? []) as N[]);
    const media: { type: "image" | "video"; url: string }[] = [];
    for (const n of nodes) {
      if (media.length >= 4) break;
      const d = n.data ?? {};
      if (typeof d.videoUrl === "string" && d.videoUrl) media.push({ type: "video", url: d.videoUrl });
      else if (typeof d.r2Url === "string" && d.r2Url) media.push({ type: "image", url: d.r2Url });
      else if (typeof d.imageUrl === "string" && d.imageUrl) media.push({ type: "image", url: d.imageUrl });
    }
    const createdAt = row.data?.createdAt ?? Date.parse(row.created_at);
    return {
      id: row.id, name: row.name, ownerEmail: emails[row.user_id] ?? "teammate",
      createdAt, updatedAt: row.data?.updatedAt ?? createdAt, nodeCount: nodes.length, media,
    };
  }).filter((s) => s.nodeCount > 0);
  return NextResponse.json({ spaces });
}
