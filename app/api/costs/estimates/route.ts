/**
 * GET /api/costs/estimates
 * Latest real charge per cost key, as credits per billing unit.
 * Shared across all accounts in this workspace so both users benefit.
 */
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/guestMode";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from("generations")
    .select("cost_key, cost_units, credits, created_at")
    .not("credits", "is", null)
    .not("cost_key", "is", null)
    .eq("status", "done")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const perUnit: Record<string, number> = {};
  for (const row of data ?? []) {
    const key = row.cost_key as string;
    if (key in perUnit) continue; // rows are newest first
    const units = Number(row.cost_units) || 1;
    perUnit[key] = Number(row.credits) / units;
  }
  return NextResponse.json({ perUnit });
}
