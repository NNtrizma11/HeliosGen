/**
 * POST /api/meta/sync  { account_id?, full? }
 * Signed-in users sync one account (or all enabled ones). The daily cron calls it with
 * header x-cron-secret = META_CRON_SECRET to sync every enabled account.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/guestMode";
import { syncAccount, syncAll } from "@/lib/meta";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  const cron = !!process.env.META_CRON_SECRET && req.headers.get("x-cron-secret") === process.env.META_CRON_SECRET;
  if (!cron && !(await resolveUserId(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.account_id) return NextResponse.json({ ok: true, result: await syncAccount(String(body.account_id), { full: !!body.full }) });
    return NextResponse.json({ ok: true, results: await syncAll() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
