"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useWorkflowStore } from "@/lib/store";
import { fetchKieBalance } from "@/lib/nodeCost";
import { creditsToUsd, formatUsd } from "@/lib/pricing";

interface Group { name: string; credits: number; usd: number; count: number }
interface Row {
  id: string; createdAt: string; user: string; type: string; model: string; status: string;
  credits: number | null; usd: number | null; duration: number | null; prompt: string;
}
interface Summary {
  days: number;
  totals: { credits: number; usd: number; todayCredits: number; todayUsd: number; jobs: number; unpriced: number };
  byModel: Group[]; byUser: Group[]; byType: Group[]; rows: Row[];
}

const RANGES = [7, 30, 90];
const fmtCredits = (c: number) => (Math.round(c * 100) / 100).toLocaleString();

function Card({ label, usd, sub }: { label: string; usd: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3">
      <div className="text-xs text-white/50">{label}</div>
      <div className="text-2xl font-semibold mt-1">{usd}</div>
      {sub && <div className="text-[11px] text-white/40 mt-0.5">{sub}</div>}
    </div>
  );
}

function GroupTable({ title, groups }: { title: string; groups: Group[] }) {
  return (
    <div className="rounded-xl border border-white/[0.08] overflow-hidden">
      <div className="px-4 py-2 text-xs text-white/50 bg-white/[0.02]">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {groups.length === 0 && <tr><td className="px-4 py-3 text-white/40">No data</td></tr>}
          {groups.map((g) => (
            <tr key={g.name} className="border-t border-white/[0.05]">
              <td className="px-4 py-2 truncate max-w-[220px]">{g.name}</td>
              <td className="px-4 py-2 text-right text-white/50">{g.count}×</td>
              <td className="px-4 py-2 text-right text-white/50">{fmtCredits(g.credits)} cr</td>
              <td className="px-4 py-2 text-right font-medium">{formatUsd(g.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CostsPage() {
  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Summary | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data: auth } = await createClient().auth.getSession();
      const token = auth.session?.access_token;
      if (!token) { setAuthModalOpen(true); setError("Sign in to see costs."); return; }
      const res = await fetch(`/api/costs/summary?days=${days}`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load costs");
      setData(json as Summary);
      setBalance(await fetchKieBalance());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [days, setAuthModalOpen]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Costs</h1>
          <span className="text-xs text-white/40">Both accounts · real charges reported by Kie · 1 credit = {formatUsd(creditsToUsd(1))}</span>
          <div className="ml-auto flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                className={`px-3 py-1.5 rounded-lg text-xs ${days === r ? "bg-white/[0.1] text-white" : "text-white/50 hover:text-white"}`}
              >
                {r} days
              </button>
            ))}
            <button onClick={load} className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white">Refresh</button>
          </div>
        </div>

        {error && <div className="text-sm text-red-400">{error}</div>}
        {loading && !data && <div className="text-sm text-white/50">Loading…</div>}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card label="Today" usd={formatUsd(data.totals.todayUsd)} sub={`${fmtCredits(data.totals.todayCredits)} credits`} />
              <Card label={`Last ${data.days} days`} usd={formatUsd(data.totals.usd)} sub={`${fmtCredits(data.totals.credits)} credits`} />
              <Card label="Jobs" usd={String(data.totals.jobs)} sub={data.totals.unpriced ? `${data.totals.unpriced} finished without a recorded charge` : "all charges recorded"} />
              <Card label="Kie balance" usd={balance === null ? "—" : formatUsd(creditsToUsd(balance))} sub={balance === null ? "unavailable" : `${fmtCredits(balance)} credits`} />
            </div>

            <div className="grid md:grid-cols-3 gap-3">
              <GroupTable title="By model" groups={data.byModel} />
              <GroupTable title="By person" groups={data.byUser} />
              <GroupTable title="By type" groups={data.byType} />
            </div>

            <div className="rounded-xl border border-white/[0.08] overflow-x-auto">
              <div className="px-4 py-2 text-xs text-white/50 bg-white/[0.02]">Every generation</div>
              <table className="w-full text-sm min-w-[720px]">
                <thead>
                  <tr className="text-left text-xs text-white/40">
                    <th className="px-4 py-2 font-normal">When</th>
                    <th className="px-4 py-2 font-normal">Who</th>
                    <th className="px-4 py-2 font-normal">Model</th>
                    <th className="px-4 py-2 font-normal">Status</th>
                    <th className="px-4 py-2 font-normal">Prompt</th>
                    <th className="px-4 py-2 font-normal text-right">Credits</th>
                    <th className="px-4 py-2 font-normal text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-t border-white/[0.05]">
                      <td className="px-4 py-2 whitespace-nowrap text-white/60">{new Date(r.createdAt).toLocaleString()}</td>
                      <td className="px-4 py-2 truncate max-w-[140px]">{r.user}</td>
                      <td className="px-4 py-2 whitespace-nowrap">{r.model}{r.duration ? ` · ${r.duration}s` : ""}</td>
                      <td className={`px-4 py-2 ${r.status === "error" ? "text-red-400" : r.status === "done" ? "text-white/60" : "text-amber-300"}`}>{r.status}</td>
                      <td className="px-4 py-2 truncate max-w-[260px] text-white/50" title={r.prompt}>{r.prompt}</td>
                      <td className="px-4 py-2 text-right text-white/50">{r.credits === null ? "—" : fmtCredits(r.credits)}</td>
                      <td className="px-4 py-2 text-right font-medium">{r.usd === null ? "—" : formatUsd(r.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
