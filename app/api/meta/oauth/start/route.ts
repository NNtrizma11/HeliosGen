/**
 * GET /api/meta/oauth/start → redirects to Facebook Login (only when META_APP_ID / META_APP_SECRET are set).
 * The signed-in user's id travels in a short-lived cookie together with a CSRF state value.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GRAPH_VERSION } from "@/lib/meta";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const appId = process.env.META_APP_ID;
  if (!appId || !process.env.META_APP_SECRET) return NextResponse.json({ error: "Facebook Login is not configured." }, { status: 400 });
  const accessToken = req.nextUrl.searchParams.get("t") ?? "";
  const { data } = await supabaseAdmin.auth.getUser(accessToken);
  if (!data.user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const state = randomBytes(16).toString("hex");
  const origin = process.env.CALLBACK_BASE_URL?.replace(/\/$/, "") || req.nextUrl.origin;
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", `${origin}/api/meta/oauth/callback`);
  url.searchParams.set("state", state);
  // Business-type apps use "Facebook Login for Business", which takes a configuration id instead of scopes
  if (process.env.META_CONFIG_ID) url.searchParams.set("config_id", process.env.META_CONFIG_ID);
  else url.searchParams.set("scope", "ads_read,business_management");
  const res = NextResponse.redirect(url);
  res.cookies.set("meta_oauth", `${state}.${data.user.id}`, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
