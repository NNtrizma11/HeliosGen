/** GET /api/meta/oauth/callback → exchanges the code for a long-lived (60-day) token and stores it. */
import { NextRequest, NextResponse } from "next/server";
import { connectToken, GRAPH_VERSION } from "@/lib/meta";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = process.env.CALLBACK_BASE_URL?.replace(/\/$/, "") || req.nextUrl.origin;
  const back = (q: string) => {
    const res = NextResponse.redirect(`${origin}/analytics?${q}`);
    res.cookies.delete("meta_oauth");
    return res;
  };
  const [state, userId] = (req.cookies.get("meta_oauth")?.value ?? "").split(".");
  const code = req.nextUrl.searchParams.get("code");
  if (!code || !state || state !== req.nextUrl.searchParams.get("state")) return back("meta=error&reason=state");

  const base = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;
  const id = process.env.META_APP_ID!, secret = process.env.META_APP_SECRET!;
  try {
    const short = await fetch(`${base}?client_id=${id}&client_secret=${secret}&redirect_uri=${encodeURIComponent(`${origin}/api/meta/oauth/callback`)}&code=${code}`).then((r) => r.json());
    if (!short.access_token) throw new Error(short.error?.message ?? "No token");
    const long = await fetch(`${base}?grant_type=fb_exchange_token&client_id=${id}&client_secret=${secret}&fb_exchange_token=${short.access_token}`).then((r) => r.json());
    const token = long.access_token ?? short.access_token;
    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;
    await connectToken(token, userId || null, "user_long_lived", expiresAt);
    return back("meta=connected");
  } catch (e) {
    return back(`meta=error&reason=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
}
