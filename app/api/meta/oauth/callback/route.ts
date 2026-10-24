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
  if (!code || !state || state !== req.nextUrl.searchParams.get("state")) { console.error("[meta oauth callback] state mismatch or missing code"); return back("meta=error&reason=state"); }

  const base = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;
  const id = process.env.META_APP_ID!, secret = process.env.META_APP_SECRET!;
  try {
    const short = await fetch(`${base}?client_id=${id}&client_secret=${secret}&redirect_uri=${encodeURIComponent(`${origin}/api/meta/oauth/callback`)}&code=${code}`).then((r) => r.json());
    if (!short.access_token) throw new Error(short.error?.message ?? "No token");
    // With a "system-user access token" configuration the code already yields a business-integration
    // system user token that never expires; only personal user tokens need the 60-day exchange.
    const debug = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${short.access_token}&access_token=${id}|${secret}`).then((r) => r.json()).catch(() => ({}));
    const kind = debug?.data?.type === "SYSTEM_USER" ? "business_integration" : "user_long_lived";
    let token = short.access_token as string;
    let expiresAt: string | null = null;
    if (kind === "user_long_lived") {
      const long = await fetch(`${base}?grant_type=fb_exchange_token&client_id=${id}&client_secret=${secret}&fb_exchange_token=${short.access_token}`).then((r) => r.json());
      token = long.access_token ?? token;
      expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;
    } else if (debug?.data?.expires_at) {
      expiresAt = new Date(debug.data.expires_at * 1000).toISOString();
    }
    await connectToken(token, userId || null, kind, expiresAt);
    return back("meta=connected");
  } catch (e) {
    console.error("[meta oauth callback]", e instanceof Error ? e.message : e);
    return back(`meta=error&reason=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
}
