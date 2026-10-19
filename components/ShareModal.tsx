"use client";
import React, { useState, useEffect } from "react";
import { X, Copy, Check, Globe, Lock, Users } from "lucide-react";
import { useWorkflowStore } from "@/lib/store";
import { createClient } from "@/lib/supabase/client";

interface Member { email: string; role: string; pending: boolean; me: boolean }

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await createClient().auth.getSession();
  const t = data.session?.access_token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Team access: teammates open and edit this canvas through its normal link. */
function TeamSection({ spaceId, ownerEmail }: { spaceId: string; ownerEmail?: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = typeof window !== "undefined" ? `${window.location.origin}/workflow/${spaceId}` : `/workflow/${spaceId}`;

  const load = async () => {
    const res = await fetch("/api/team", { headers: await authHeaders() }).catch(() => null);
    if (!res?.ok) { setMembers([]); return; }
    const j = (await res.json()) as { members: Member[]; canManage: boolean };
    setMembers(j.members);
    setCanManage(j.canManage);
  };
  useEffect(() => { load(); }, []);

  const invite = async () => {
    if (!email.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({ email }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not invite.");
      setMsg(j.pending ? `${email} will join when they sign up to Helios with that email.` : `${email} added.`);
      setEmail("");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: Member) => {
    setBusy(true);
    await fetch(`/api/team?email=${encodeURIComponent(m.email)}`, { method: "DELETE", headers: await authHeaders() }).catch(() => null);
    await load();
    setBusy(false);
  };

  const others = (members ?? []).filter((m) => !m.me);
  const box: React.CSSProperties = { padding: "14px 16px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12 };

  return (
    <div style={{ ...box, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Users size={16} style={{ color: "#38bdf8" }} />
        <div style={{ flex: 1 }}>
          <div style={{ color: "#fff", fontSize: 13, fontWeight: 500 }}>Team access</div>
          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 2 }}>
            {ownerEmail
              ? `Owned by ${ownerEmail}. Your team can open and edit it with this link.`
              : others.length
                ? "Your team can open and edit your canvases with the link."
                : "Invite teammates so they can open and edit your canvases."}
          </div>
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
          style={{ height: 28, padding: "0 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: copied ? "rgba(45,212,191,0.15)" : "rgba(56,189,248,0.15)", color: copied ? "#2DD4BF" : "#7dd3fc", display: "flex", alignItems: "center", gap: 6 }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy team link"}
        </button>
      </div>

      {members === null ? (
        <div style={{ color: "rgba(255,255,255,0.35)", fontSize: 12 }}>Loading team…</div>
      ) : others.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {others.map((m) => (
            <div key={m.email} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "rgba(255,255,255,0.75)" }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{m.email}</span>
              <span style={{ color: "rgba(255,255,255,0.35)" }}>{m.role === "owner" ? "owner" : m.pending ? "invited" : "member"}</span>
              {canManage && m.role !== "owner" && (
                <button onClick={() => remove(m)} disabled={busy} title="Remove" style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.35)", cursor: "pointer" }}>
                  <X size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") invite(); }}
          placeholder="teammate@email.com"
          style={{ flex: 1, padding: "8px 10px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12, color: "#fff", outline: "none" }}
        />
        <button
          onClick={invite}
          disabled={busy || !email.trim()}
          style={{ padding: "0 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 500, background: "rgba(56,189,248,0.15)", color: "#7dd3fc", opacity: busy || !email.trim() ? 0.5 : 1 }}
        >
          Invite
        </button>
      </div>
      {msg && <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 11 }}>{msg}</div>}
    </div>
  );
}

interface ShareModalProps {
  spaceId: string;
  open: boolean;
  onClose: () => void;
}

export default function ShareModal({ spaceId, open, onClose }: ShareModalProps) {
  const spaces = useWorkflowStore((s) => s.spaces);
  const setSpacePublic = useWorkflowStore((s) => s.setSpacePublic);
  const space = spaces.find((sp) => sp.id === spaceId);
  const isPublic = space?.isPublic ?? false;

  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publicUrl = typeof window !== "undefined"
    ? `${window.location.origin}/public/workflow/${spaceId}`
    : `/public/workflow/${spaceId}`;

  useEffect(() => {
    if (!open) { setError(null); setCopied(false); }
  }, [open]);

  if (!open) return null;

  async function togglePublic() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/spaces/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: spaceId, isPublic: !isPublic }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSpacePublic(spaceId, !isPublic);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setLoading(false);
    }
  }

  function copyLink() {
    navigator.clipboard.writeText(publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 420, maxWidth: "90vw",
          background: "rgba(13,13,15,0.97)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16,
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          padding: "24px",
          display: "flex", flexDirection: "column", gap: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>Share Workflow</span>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: "rgba(255,255,255,0.4)", padding: 4, borderRadius: 6,
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "color 150ms",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.8)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.4)")}
          >
            <X size={16} />
          </button>
        </div>

        {/* Status + toggle */}
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 16px",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {isPublic
              ? <Globe size={16} style={{ color: "#2DD4BF" }} />
              : <Lock size={16} style={{ color: "rgba(255,255,255,0.4)" }} />
            }
            <div>
              <div style={{ color: "#fff", fontSize: 13, fontWeight: 500 }}>
                {isPublic ? "Public" : "Private"}
              </div>
              <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 2 }}>
                {isPublic
                  ? "Anyone with the link can view"
                  : "Not public. Only you and your team can open it"}
              </div>
            </div>
          </div>
          <button
            onClick={togglePublic}
            disabled={loading}
            style={{
              height: 28, padding: "0 14px",
              borderRadius: 8, border: "none", cursor: loading ? "wait" : "pointer",
              fontSize: 12, fontWeight: 500,
              transition: "background 150ms, color 150ms, opacity 150ms",
              opacity: loading ? 0.6 : 1,
              background: isPublic ? "rgba(255,255,255,0.08)" : "rgba(45,212,191,0.15)",
              color: isPublic ? "rgba(255,255,255,0.7)" : "#2DD4BF",
            }}
          >
            {loading ? "…" : isPublic ? "Make Private" : "Make Public"}
          </button>
        </div>

        {error && (
          <div style={{ color: "#f87171", fontSize: 12, padding: "0 4px" }}>{error}</div>
        )}

        {process.env.NEXT_PUBLIC_GUEST_MODE !== "true" && <TeamSection spaceId={spaceId} ownerEmail={space?.ownerEmail} />}

        {/* Link copy — only visible when public */}
        {isPublic && (
          <div style={{ display: "flex", gap: 8 }}>
            <div
              style={{
                flex: 1, padding: "10px 12px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 10, fontSize: 12,
                color: "rgba(255,255,255,0.6)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {publicUrl}
            </div>
            <button
              onClick={copyLink}
              title={copied ? "Copied!" : "Copy link"}
              style={{
                width: 40, borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.07)",
                background: copied ? "rgba(45,212,191,0.15)" : "rgba(255,255,255,0.06)",
                color: copied ? "#2DD4BF" : "rgba(255,255,255,0.7)",
                cursor: "pointer", display: "flex", alignItems: "center",
                justifyContent: "center", transition: "background 150ms, color 150ms",
                flexShrink: 0,
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        )}

        {/* Footer note */}
        <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, margin: 0 }}>
          The public view is read-only — visitors can pan and zoom but cannot edit or generate.
        </p>
      </div>
    </div>
  );
}
