/**
 * GET /api/costs/summary?days=30
 * Spend across all accounts: totals, per model, per person, and the job list.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";
import { creditsToUsd } from "@/lib/pricing";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const days = Math.min(366, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("generations")
    .select("id, created_at, user_id, generation_type, model, status, credits, cost_key, cost_units, prompt, duration, aspect_ratio")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Map user ids to emails (two-person workspace, one page of users is plenty)
  const emails: Record<string, string> = {};
  const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of users?.users ?? []) emails[u.id] = u.email ?? u.id;

  const rows = (data ?? []).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    user: emails[r.user_id as string] ?? "unknown",
    type: r.generation_type as string,
    model: r.model as string,
    status: r.status as string,
    credits: r.credits === null ? null : Number(r.credits),
    usd: r.credits === null ? null : creditsToUsd(Number(r.credits)),
    duration: r.duration as number | null,
    prompt: ((r.prompt as string | null) ?? "").slice(0, 140),
  }));

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const sum = (list: typeof rows) => list.reduce((a, r) => a + (r.credits ?? 0), 0);
  const group = (by: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, { credits: number; count: number }>();
    for (const r of rows) {
      const k = by(r);
      const g = m.get(k) ?? { credits: 0, count: 0 };
      g.credits += r.credits ?? 0;
      g.count += 1;
      m.set(k, g);
    }
    return [...m.entries()]
      .map(([name, g]) => ({ name, credits: g.credits, usd: creditsToUsd(g.credits), count: g.count }))
      .sort((a, b) => b.credits - a.credits);
  };

  const totalCredits = sum(rows);
  const todayCredits = sum(rows.filter((r) => new Date(r.createdAt) >= startOfToday));
  return NextResponse.json({
    days,
    totals: {
      credits: totalCredits,
      usd: creditsToUsd(totalCredits),
      todayCredits,
      todayUsd: creditsToUsd(todayCredits),
      jobs: rows.length,
      unpriced: rows.filter((r) => r.credits === null && r.status === "done").length,
    },
    byModel: group((r) => r.model ?? "unknown"),
    byUser: group((r) => r.user),
    byType: group((r) => r.type),
    rows,
  });
}
