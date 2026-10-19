"use client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

/* ── Types ─────────────────────────────────────────────────────────────────── */
interface Account {
  account_id: string; name: string; currency: string | null; market: string | null; business_name: string | null;
  sync_enabled: boolean; backfilled_at: string | null; last_sync_at: string | null; last_sync_error: string | null;
}
interface ConnectionInfo {
  connected: boolean; oauthAvailable: boolean; accounts: Account[];
  connection: { token_type: string; meta_user_name: string | null; expires_at: string | null; created_at: string } | null;
}
type Metrics = {
  spend: number; impressions: number; purchases: number; purchase_value: number; link_clicks: number; video_3s: number; thruplays: number;
  roas: number | null; cpa: number | null; cpm: number | null; ctr: number | null; cvr: number | null; aov: number | null;
  hookRate: number | null; holdRate: number | null;
};
interface AdRow {
  ad_id: string; name: string | null; effective_status: string | null; campaign_name: string | null; adset_name: string | null;
  title: string | null; body: string | null; thumbnail_url: string | null; image_url: string | null; video_id: string | null;
  share: number; labels: string[]; iterated: boolean; metrics: Metrics;
  prev: { spend: number; roas: number | null; ctr: number | null; cpa: number | null; hookRate: number | null };
}
type BreakdownItem = { key: string; key2: string; spend: number; purchases: number; purchase_value: number; impressions: number };
interface Analytics {
  account: Account; period: { start: string; end: string; days: number };
  total: Metrics; prevTotal: Metrics; series: (Metrics & { date: string })[]; prevSeries: (Metrics & { date: string })[];
  breakdowns: Record<string, BreakdownItem[]>; ads: AdRow[];
}
interface IterationItem {
  kind: "iteration" | "variation"; type: string; title: string; what_changes: string; why: string;
  hook: string; script: string; visual_direction: string; priority: number;
}
interface IterationSet {
  id: number; created_at: string;
  diagnosis: { weakest: string; findings: { stage: string; text: string }[] };
  suggestions: { summary: string; keep: string[]; items: IterationItem[] };
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */
async function api(path: string, init: RequestInit = {}) {
  const { data } = await createClient().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in to use Analytics.");
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}
const money = (n: number | null | undefined, cur = "USD") =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: n >= 1000 ? 0 : 2, notation: n >= 10000 ? "compact" : "standard" }).format(n);
const pct = (n: number | null | undefined, d = 1) => (n == null ? "—" : `${(n * 100).toFixed(d)}%`);
const fix = (n: number | null | undefined, d = 2) => (n == null ? "—" : n.toFixed(d));
const int = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString());
const delta = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : (a - b) / b);

const box = "rounded-xl border border-white/[0.08] bg-white/[0.02]";
const btn = "px-3 py-1.5 rounded-lg text-xs border border-white/[0.1] text-white/70 hover:text-white hover:bg-white/[0.05] disabled:opacity-40";
const primary = "px-3 py-1.5 rounded-lg text-xs bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-50";

/* ── Charts (plain SVG/CSS) ────────────────────────────────────────────────── */
function Sparkline({ cur, prev }: { cur: (number | null)[]; prev: (number | null)[] }) {
  const vals = [...cur, ...prev].filter((v): v is number => v != null);
  if (vals.length < 2) return <div className="h-10" />;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const path = (arr: (number | null)[]) => arr.map((v, i) => v == null ? null : `${(i / Math.max(1, arr.length - 1)) * 100},${36 - ((v - min) / span) * 32}`)
    .filter(Boolean).map((p, i) => `${i ? "L" : "M"}${p}`).join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full h-10 mt-2">
      <path d={path(prev)} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.2" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      <path d={path(cur)} fill="none" stroke="#34d399" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function KpiCard({ label, value, change, good = "up", cur, prev, hint }: {
  label: string; value: string; change: number | null; good?: "up" | "down"; cur: (number | null)[]; prev: (number | null)[]; hint?: string;
}) {
  const positive = change == null ? null : good === "up" ? change >= 0 : change <= 0;
  return (
    <div className={`${box} px-4 py-3`} title={hint}>
      <div className="text-xs text-white/50">{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-2xl font-semibold">{value}</span>
        {change != null && (
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${positive ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
            {change >= 0 ? "+" : ""}{(change * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <Sparkline cur={cur} prev={prev} />
    </div>
  );
}

function BarList({ rows, format }: { rows: { label: ReactNode; value: number }[]; format: (n: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 text-xs">
          <span className="w-24 shrink-0 text-white/70 truncate">{r.label}</span>
          <div className="flex-1 h-2 rounded-full bg-white/[0.05] overflow-hidden"><div className="h-full rounded-full bg-sky-400" style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <span className="w-16 text-right text-white/70">{format(r.value)}</span>
        </div>
      ))}
      {!rows.length && <div className="text-xs text-white/30">No data for this period</div>}
    </div>
  );
}

function AgeGender({ items, value, format }: { items: BreakdownItem[]; value: (b: BreakdownItem) => number; format: (n: number) => string }) {
  const ages = [...new Set(items.map((i) => i.key))].filter((a) => a !== "Unknown").sort();
  const get = (age: string, g: string) => items.filter((i) => i.key === age && i.key2 === g).reduce((s, i) => s + value(i), 0);
  const max = Math.max(...ages.flatMap((a) => [get(a, "female"), get(a, "male")]), 0) || 1;
  return (
    <div>
      <div className="flex gap-4 text-[11px] text-white/50 mb-3">
        <span><span className="inline-block w-2 h-2 rounded-sm bg-pink-400 mr-1" />Female</span>
        <span><span className="inline-block w-2 h-2 rounded-sm bg-sky-400 mr-1" />Male</span>
      </div>
      <div className="flex items-end gap-3 h-40">
        {ages.map((a) => (
          <div key={a} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
            <div className="flex items-end gap-1 h-full w-full justify-center">
              {(["female", "male"] as const).map((g) => (
                <div key={g} title={`${a} ${g}: ${format(get(a, g))}`} className={`w-3 sm:w-4 rounded-t ${g === "female" ? "bg-pink-400" : "bg-sky-400"}`}
                  style={{ height: `${Math.max(2, (get(a, g) / max) * 100)}%` }} />
              ))}
            </div>
            <span className="text-[10px] text-white/50">{a}</span>
          </div>
        ))}
        {!ages.length && <div className="text-xs text-white/30 self-center">No data for this period</div>}
      </div>
    </div>
  );
}

/* ── Connect flow ──────────────────────────────────────────────────────────── */
function Connect({ info, onDone }: { info: ConnectionInfo | null; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setBusy(true); setErr("");
    try { await api("/api/meta/connection", { method: "POST", body: JSON.stringify({ token }) }); setToken(""); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const fbLogin = async () => {
    const { data } = await createClient().auth.getSession();
    window.location.href = `/api/meta/oauth/start?t=${encodeURIComponent(data.session?.access_token ?? "")}`;
  };
  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Connect Meta ads</h1>
        <p className="text-sm text-white/50 mt-1">Read-only access to your ad accounts, so Analytics can sync spend, purchases, ROAS and creative performance every day.</p>
      </div>
      {info?.oauthAvailable && (
        <div className={`${box} p-5 space-y-3`}>
          <div className="text-sm font-medium">Option 1 · Log in with Facebook</div>
          <p className="text-xs text-white/50">Quickest. The connection lasts 60 days, then you log in again.</p>
          <button onClick={fbLogin} className={primary}>Continue with Facebook</button>
        </div>
      )}
      <div className={`${box} p-5 space-y-3`}>
        <div className="text-sm font-medium">{info?.oauthAvailable ? "Option 2 · " : ""}System user token (recommended, never expires)</div>
        <ol className="text-xs text-white/60 space-y-1.5 list-decimal pl-4">
          <li>Open <a className="text-sky-300 hover:underline" href="https://business.facebook.com/settings/system-users" target="_blank" rel="noreferrer">Business settings → Users → System users</a> and add a system user (role: Admin).</li>
          <li>Click <b>Assign assets</b> → Ad accounts → select every account to sync → permission <b>View performance</b>.</li>
          <li>Click <b>Generate new token</b> → pick your app → tick <b>ads_read</b> and <b>business_management</b> → token expiration <b>Never</b>.</li>
          <li>Paste the token below.</li>
        </ol>
        <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={3} placeholder="EAAB…"
          className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-2 text-xs font-mono" />
        {err && <div className="text-xs text-red-400">{err}</div>}
        <button onClick={submit} disabled={busy || token.trim().length < 50} className={primary}>{busy ? "Checking…" : "Connect"}</button>
      </div>
    </div>
  );
}

function AccountSettings({ info, onChange, onClose }: { info: ConnectionInfo; onChange: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const patch = async (account_id: string, body: Record<string, unknown>) => {
    await api("/api/meta/connection", { method: "PATCH", body: JSON.stringify({ account_id, ...body }) }); onChange();
  };
  const sync = async (a: Account, full = false) => {
    setBusy(a.account_id); setMsg("");
    try {
      const r = await api("/api/meta/sync", { method: "POST", body: JSON.stringify({ account_id: a.account_id, full }) });
      setMsg(`${a.name}: ${r.result.ads} ads, ${r.result.rows} daily rows (${r.result.since} → ${r.result.until}).`);
    } catch (e) { setMsg(`${a.name}: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(null); onChange(); }
  };
  const disconnect = async () => { await api("/api/meta/connection", { method: "DELETE" }); onChange(); onClose(); };
  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-white/[0.1] bg-[#121212] p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center">
          <div>
            <div className="text-base font-semibold">Meta ad accounts</div>
            <div className="text-xs text-white/50">
              Connected {info.connection?.meta_user_name ? `as ${info.connection.meta_user_name}` : ""} · {info.connection?.token_type === "system_user" ? "system user token" : "Facebook login"}
              {info.connection?.expires_at ? ` · expires ${new Date(info.connection.expires_at).toLocaleDateString()}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="ml-auto text-white/50 hover:text-white text-sm">✕</button>
        </div>
        <div className="space-y-2">
          {info.accounts.map((a) => (
            <div key={a.account_id} className={`${box} px-4 py-3 flex items-center gap-3 flex-wrap`}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={a.sync_enabled} onChange={(e) => patch(a.account_id, { sync_enabled: e.target.checked })} />
                <span className="text-sm font-medium">{a.name}</span>
              </label>
              <input defaultValue={a.market ?? ""} onBlur={(e) => e.target.value !== (a.market ?? "") && patch(a.account_id, { market: e.target.value })}
                placeholder="Market" className="w-16 bg-white/[0.04] border border-white/[0.1] rounded px-2 py-1 text-xs" />
              <span className="text-[11px] text-white/40">
                {a.last_sync_error ? <span className="text-red-400">Error: {a.last_sync_error.slice(0, 80)}</span>
                  : a.last_sync_at ? `Synced ${new Date(a.last_sync_at).toLocaleString()}` : a.sync_enabled ? "Not synced yet" : "Not syncing"}
              </span>
              {a.sync_enabled && (
                <div className="ml-auto flex gap-2">
                  <button onClick={() => sync(a)} disabled={!!busy} className={btn}>{busy === a.account_id ? "Syncing…" : a.backfilled_at ? "Sync now" : "First sync (90 days)"}</button>
                </div>
              )}
            </div>
          ))}
        </div>
        {msg && <div className="text-xs text-white/60">{msg}</div>}
        <div className="text-[11px] text-white/40">Ticked accounts sync automatically every night: the last few days are refreshed, since Meta keeps attributing purchases for several days. The first sync loads 90 days and can take a few minutes.</div>
        <div className="flex justify-between pt-1">
          <button onClick={disconnect} className="text-xs text-red-400/80 hover:text-red-300">Disconnect Meta</button>
          <button onClick={onClose} className={primary}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ── Iterations drawer ─────────────────────────────────────────────────────── */
function IterationsDrawer({ ad, cur, onClose, onSaved }: { ad: AdRow; cur: string; onClose: () => void; onSaved: () => void }) {
  const [sets, setSets] = useState<IterationSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try { setSets((await api(`/api/meta/iterate?ad_id=${ad.ad_id}`)).sets); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [ad.ad_id]);
  useEffect(() => { load(); }, [load]);
  const generate = async () => {
    setBusy(true); setErr("");
    try { const r = await api("/api/meta/iterate", { method: "POST", body: JSON.stringify({ ad_id: ad.ad_id }) }); setSets((s) => [r.set, ...s]); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const latest = sets[0];
  const copy = (it: IterationItem) => navigator.clipboard?.writeText(`${it.title}\n\nHook: ${it.hook}\n\n${it.script}\n\nVisual: ${it.visual_direction}`);
  const m = ad.metrics;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-3xl h-full overflow-y-auto bg-[#111] border-l border-white/[0.08] p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          {(ad.thumbnail_url || ad.image_url) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ad.thumbnail_url ?? ad.image_url ?? ""} alt="" className="w-20 h-20 rounded-lg object-cover" />
          )}
          <div className="min-w-0">
            <div className="font-semibold truncate">{ad.name}</div>
            <div className="text-xs text-white/50 truncate">{ad.campaign_name} · {ad.adset_name}</div>
            <div className="text-xs text-white/60 mt-1">ROAS {fix(m.roas)} · {fix(m.purchases, 0)} purchases · {money(m.spend, cur)} · CTR {pct(m.ctr, 2)} · Hook {pct(m.hookRate)} · Hold {pct(m.holdRate)}</div>
          </div>
          <button onClick={onClose} className="ml-auto text-white/50 hover:text-white text-sm">✕</button>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={generate} disabled={busy} className={primary}>{busy ? "Analyzing… (~30s)" : latest ? "Generate new suggestions" : "Suggest iterations & variations"}</button>
          {latest && <span className="text-[11px] text-white/40">Last generated {new Date(latest.created_at).toLocaleString()}</span>}
        </div>
        {err && <div className="text-xs text-red-400">{err}</div>}
        {loading && <div className="text-xs text-white/40">Loading…</div>}

        {latest && (
          <>
            <div className={`${box} p-4 space-y-2`}>
              <div className="text-xs text-white/50">Diagnosis · weakest stage: <b className="text-white/80">{latest.diagnosis.weakest.replace(/_/g, " ")}</b></div>
              <div className="text-sm text-white/85">{latest.suggestions.summary}</div>
              {latest.diagnosis.findings.length > 0 && (
                <ul className="text-xs text-white/60 list-disc pl-4 space-y-0.5">{latest.diagnosis.findings.map((f, i) => <li key={i}>{f.text}</li>)}</ul>
              )}
              {latest.suggestions.keep?.length > 0 && (
                <div className="text-xs text-emerald-300/80">Keep: {latest.suggestions.keep.join(" · ")}</div>
              )}
            </div>
            {(["iteration", "variation"] as const).map((kind) => (
              <div key={kind} className="space-y-2">
                <div className="text-xs uppercase tracking-wide text-white/40">{kind === "iteration" ? "Iterations · fix the weak part" : "Variations · scale what works"}</div>
                {latest.suggestions.items.filter((i) => i.kind === kind).map((it, i) => (
                  <div key={i} className={`${box} p-4 space-y-2`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/60 uppercase">{it.type}</span>
                      <span className="font-medium text-sm">{it.title}</span>
                      <button onClick={() => copy(it)} className="ml-auto text-[11px] text-white/40 hover:text-white">Copy</button>
                    </div>
                    <div className="text-xs text-white/60"><b className="text-white/70">Change:</b> {it.what_changes}</div>
                    <div className="text-xs text-white/60"><b className="text-white/70">Why:</b> {it.why}</div>
                    <div className="text-sm text-white/90 border-l-2 border-sky-400/60 pl-3">{it.hook}</div>
                    <div className="text-xs text-white/75 whitespace-pre-line">{it.script}</div>
                    <div className="text-[11px] text-white/45"><b>Visual:</b> {it.visual_direction}</div>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */
const LABELS: { key: string; label: string; hint: string }[] = [
  { key: "scaling", label: "↗ Scaling", hint: "Big share of spend, ROAS at or above the account, spend growing" },
  { key: "opportunity", label: "⚡ Opportunities", hint: "ROAS 20%+ above the account but under 10% of spend: candidates to scale" },
  { key: "fatiguing", label: "↘ Fatiguing", hint: "CTR or ROAS dropped vs the previous period" },
  { key: "loser", label: "✂ Losers to cut", hint: "Spent 2× the account CPA without a sale, or ROAS under half the account's" },
  { key: "all", label: "All ads", hint: "Every ad with spend in the period" },
];

export default function AnalyticsPage() {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [accountId, setAccountId] = useState("");
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [metric, setMetric] = useState<"spend" | "purchases" | "roas">("spend");
  const [label, setLabel] = useState("scaling");
  const [openAd, setOpenAd] = useState<AdRow | null>(null);

  const loadInfo = useCallback(async () => {
    try {
      const i = (await api("/api/meta/connection")) as ConnectionInfo;
      setInfo(i);
      const enabled = i.accounts.filter((a) => a.sync_enabled);
      setAccountId((cur) => cur && i.accounts.some((a) => a.account_id === cur) ? cur : (enabled[0] ?? i.accounts[0])?.account_id ?? "");
      if (i.connected && !enabled.length) setSettings(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { loadInfo(); }, [loadInfo]);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true); setError("");
    try { setData(await api(`/api/meta/analytics?account_id=${accountId}&days=${days}`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [accountId, days]);
  useEffect(() => { if (info?.connected) load(); }, [info?.connected, load]);

  const syncNow = async () => {
    setSyncing(true); setError("");
    try { await api("/api/meta/sync", { method: "POST", body: JSON.stringify({ account_id: accountId }) }); await loadInfo(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSyncing(false); }
  };

  const cur = data?.account.currency ?? "USD";
  const value = useCallback((b: BreakdownItem) => metric === "spend" ? b.spend : metric === "purchases" ? b.purchases : b.spend ? b.purchase_value / b.spend : 0, [metric]);
  const fmtMetric = (n: number) => metric === "spend" ? money(n, cur) : metric === "purchases" ? int(n) : fix(n);
  const groups = useMemo(() => {
    const b = data?.breakdowns ?? {};
    const rows = (name: string, label: (k: string) => string = (k) => k) => {
      const m = new Map<string, BreakdownItem>();
      for (const i of b[name] ?? []) {
        const x = m.get(i.key) ?? { key: i.key, key2: "", spend: 0, purchases: 0, purchase_value: 0, impressions: 0 };
        x.spend += i.spend; x.purchases += i.purchases; x.purchase_value += i.purchase_value; x.impressions += i.impressions; m.set(i.key, x);
      }
      return [...m.values()].map((x) => ({ label: label(x.key), value: value(x) })).sort((p, q) => q.value - p.value).slice(0, 8);
    };
    return {
      country: rows("country"),
      platform: rows("platform", (k) => k.replace(/_/g, " ")),
      device: rows("device", (k) => k.replace(/_/g, " ")),
      ageGender: b.age_gender ?? [],
    };
  }, [data, value]);
  const ads = useMemo(() => (data?.ads ?? []).filter((a) => label === "all" || a.labels.includes(label)), [data, label]);
  const counts = useMemo(() => Object.fromEntries(LABELS.map((l) => [l.key, (data?.ads ?? []).filter((a) => l.key === "all" || a.labels.includes(l.key)).length])), [data]);

  if (!info) return <div className="p-6 text-sm text-white/50">{error || "Loading…"}</div>;
  if (!info.connected) return <div className="h-full overflow-y-auto"><Connect info={info} onDone={loadInfo} /></div>;

  const t = data?.total, p = data?.prevTotal;
  const series = (k: keyof Metrics) => (data?.series ?? []).map((s) => s[k] as number | null);
  const prevSeries = (k: keyof Metrics) => (data?.prevSeries ?? []).map((s) => s[k] as number | null);
  const enabled = info.accounts.filter((a) => a.sync_enabled);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-8 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Analytics</h1>
          <div className="flex gap-1 flex-wrap">
            {enabled.map((a) => (
              <button key={a.account_id} onClick={() => setAccountId(a.account_id)}
                className={`px-3 py-1.5 rounded-lg text-xs ${accountId === a.account_id ? "bg-sky-500/15 text-sky-300" : "text-white/60 hover:text-white hover:bg-white/[0.05]"}`}>
                {a.market ? `${a.market} · ` : ""}{a.name.replace(/^Nutrizma\s*/i, "") || a.name}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-1 items-center flex-wrap">
            {[7, 14, 30, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)} className={`px-2.5 py-1.5 rounded-lg text-xs ${days === d ? "bg-white/[0.1] text-white" : "text-white/50 hover:text-white"}`}>{d}d</button>
            ))}
            <button onClick={syncNow} disabled={syncing || !accountId} className={primary}>{syncing ? "Syncing…" : "↻ Sync"}</button>
            <button onClick={() => setSettings(true)} className={btn}>Accounts</button>
          </div>
        </div>
        {data && (
          <div className="text-[11px] text-white/40 -mt-3">
            {data.period.start} → {data.period.end} vs previous {data.period.days} days · last synced {data.account.last_sync_at ? new Date(data.account.last_sync_at).toLocaleString() : "never"} · purchases and revenue as reported by Meta (COD orders not yet adjusted for non-pickup)
          </div>
        )}
        {error && <div className="text-sm text-red-400">{error}</div>}
        {!enabled.length && <div className={`${box} p-6 text-sm text-white/60`}>Choose which ad accounts to sync under <b>Accounts</b>.</div>}
        {loading && !data && <div className="text-sm text-white/50">Loading…</div>}
        {data && t && p && !t.spend && <div className={`${box} p-6 text-sm text-white/60`}>No spend in this period yet. If this account was just connected, run its first sync under <b>Accounts</b>.</div>}

        {data && t && p && t.spend > 0 && (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiCard label="ROAS" value={fix(t.roas)} change={delta(t.roas, p.roas)} cur={series("roas")} prev={prevSeries("roas")} />
              <KpiCard label="Purchases" value={int(t.purchases)} change={delta(t.purchases, p.purchases)} cur={series("purchases")} prev={prevSeries("purchases")} />
              <KpiCard label="Spend" value={money(t.spend, cur)} change={delta(t.spend, p.spend)} cur={series("spend")} prev={prevSeries("spend")} />
              <KpiCard label="CPA" value={money(t.cpa, cur)} change={delta(t.cpa, p.cpa)} good="down" cur={series("cpa")} prev={prevSeries("cpa")} />
              <KpiCard label="CPM" value={money(t.cpm, cur)} change={delta(t.cpm, p.cpm)} good="down" cur={series("cpm")} prev={prevSeries("cpm")} />
              <KpiCard label="Link CTR" value={pct(t.ctr, 2)} change={delta(t.ctr, p.ctr)} cur={series("ctr")} prev={prevSeries("ctr")} />
              <KpiCard label="Hook rate" value={pct(t.hookRate)} change={delta(t.hookRate, p.hookRate)} cur={series("hookRate")} prev={prevSeries("hookRate")} hint="3-second video views / impressions" />
              <KpiCard label="AOV" value={money(t.aov, cur)} change={delta(t.aov, p.aov)} cur={series("aov")} prev={prevSeries("aov")} />
            </div>

            {/* Audiences */}
            <div className="flex items-center gap-3 pt-2">
              <h2 className="text-base font-semibold">Top audiences by</h2>
              <div className="flex gap-1">
                {(["spend", "purchases", "roas"] as const).map((m) => (
                  <button key={m} onClick={() => setMetric(m)} className={`px-2.5 py-1 rounded-lg text-xs ${metric === m ? "bg-white/[0.1] text-white" : "text-white/50 hover:text-white"}`}>
                    {m === "roas" ? "ROAS" : m[0].toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div className={`${box} p-4`}><div className="text-sm font-medium mb-3">Age &amp; gender</div><AgeGender items={groups.ageGender} value={value} format={fmtMetric} /></div>
              <div className={`${box} p-4`}><div className="text-sm font-medium mb-3">Country</div><BarList rows={groups.country} format={fmtMetric} /></div>
              <div className={`${box} p-4`}><div className="text-sm font-medium mb-3">Platform</div><BarList rows={groups.platform} format={fmtMetric} /></div>
              <div className={`${box} p-4`}><div className="text-sm font-medium mb-3">Device</div><BarList rows={groups.device} format={fmtMetric} /></div>
            </div>

            {/* Creatives */}
            <div className="flex items-center gap-3 flex-wrap pt-2">
              <h2 className="text-base font-semibold">Ad creatives</h2>
              <div className="flex gap-1 flex-wrap ml-auto">
                {LABELS.map((l) => (
                  <button key={l.key} title={l.hint} onClick={() => setLabel(l.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs ${label === l.key ? "bg-white/[0.1] text-white" : "text-white/50 hover:text-white"}`}>
                    {l.label} <span className="text-white/40">({counts[l.key] ?? 0})</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {ads.map((a) => (
                <div key={a.ad_id} className={`${box} overflow-hidden flex flex-col`}>
                  <div className="aspect-[4/3] bg-black/40 relative">
                    {(a.thumbnail_url || a.image_url) && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.thumbnail_url ?? a.image_url ?? ""} alt="" className="h-full w-full object-cover" />
                    )}
                    <div className="absolute top-2 left-2 flex gap-1">
                      {a.labels.map((l) => <span key={l} className="text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-white/80">{l}</span>)}
                    </div>
                  </div>
                  <div className="p-3 space-y-1.5 text-xs flex-1 flex flex-col">
                    <div className="font-medium text-sm truncate" title={a.name ?? ""}>{a.name}</div>
                    <div className="text-white/40 truncate">{a.campaign_name}</div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-white/70">
                      <span>ROAS</span><span className="text-right font-medium text-white">{fix(a.metrics.roas)}</span>
                      <span>Purchases</span><span className="text-right">{fix(a.metrics.purchases, 0)}</span>
                      <span>Spend</span><span className="text-right">{money(a.metrics.spend, cur)} <span className="text-white/40">({pct(a.share, 0)})</span></span>
                      <span>CPA</span><span className="text-right">{money(a.metrics.cpa, cur)}</span>
                      <span>CTR</span><span className="text-right">{pct(a.metrics.ctr, 2)}</span>
                      {a.video_id && <><span>Hook / hold</span><span className="text-right">{pct(a.metrics.hookRate, 0)} / {pct(a.metrics.holdRate, 0)}</span></>}
                    </div>
                    <div className="flex-1" />
                    <button onClick={() => setOpenAd(a)} className={`${a.iterated ? btn : primary} mt-2 w-full`}>
                      {a.iterated ? "View suggestions" : "✦ Suggest iterations"}
                    </button>
                  </div>
                </div>
              ))}
              {!ads.length && <div className="col-span-full text-sm text-white/40">No ads in this group for the period.</div>}
            </div>
          </>
        )}
      </div>
      {settings && <AccountSettings info={info} onChange={loadInfo} onClose={() => { setSettings(false); load(); }} />}
      {openAd && <IterationsDrawer ad={openAd} cur={cur} onClose={() => setOpenAd(null)} onSaved={load} />}
    </div>
  );
}
