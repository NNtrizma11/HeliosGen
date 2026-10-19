"use client";
// Brand asset library — client side: types, a shared cache, upload helper.
import { create } from "zustand";
import { createClient } from "./supabase/client";

export interface Asset {
  id: string;
  user_id: string;
  brand: string;
  category: string;
  name: string;
  tags: string[];
  url: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  notes: string | null;
  created_at: string;
}

export const DEFAULT_BRANDS = ["Nutrizma", "CogniCup", "Peak Purity"];
export const CATEGORIES = ["Packaging", "Product", "Logo", "Characters", "Backgrounds", "Other"];

async function token(): Promise<string | null> {
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token ?? null;
}

async function api(path: string, init: RequestInit = {}) {
  const t = await token();
  if (!t) throw new Error("Sign in first.");
  const res = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j;
}

/** Read an image's pixel size (skipped for non-images). */
function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith("image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/** File name → readable asset name: "strawberry_pouch-front.png" → "strawberry pouch front". */
export function nameFromFile(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

interface AssetStore {
  assets: Asset[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  upload: (file: File, meta: { brand: string; category: string; tags?: string[]; name?: string }) => Promise<Asset>;
  update: (id: string, patch: Partial<Pick<Asset, "name" | "brand" | "category" | "tags" | "notes">>) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useAssetStore = create<AssetStore>()((set, get) => ({
  assets: [],
  loaded: false,
  loading: false,
  error: null,

  load: async (force = false) => {
    if (get().loading || (get().loaded && !force)) return;
    set({ loading: true, error: null });
    try {
      const j = await api("/api/assets");
      set({ assets: j.assets ?? [], loaded: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  upload: async (file, meta) => {
    const t = await token();
    if (!t) throw new Error("Sign in first.");
    const [size, up] = await Promise.all([
      imageSize(file),
      fetch("/api/upload-asset", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", Authorization: `Bearer ${t}` }, body: file })
        .then(async (r) => { const j = await r.json(); if (!r.ok || !j.cdnUrl) throw new Error(j.error ?? "Upload failed."); return j.cdnUrl as string; }),
    ]);
    const j = await api("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: up, name: meta.name ?? nameFromFile(file.name), brand: meta.brand, category: meta.category, tags: meta.tags ?? [], mime: file.type, ...(size ?? {}) }),
    });
    set((s) => ({ assets: [j.asset as Asset, ...s.assets] }));
    return j.asset as Asset;
  },

  update: async (id, patch) => {
    const j = await api("/api/assets", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
    set((s) => ({ assets: s.assets.map((a) => (a.id === id ? (j.asset as Asset) : a)) }));
  },

  remove: async (id) => {
    await api(`/api/assets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }));
  },
}));

/** Brands present in the library plus the defaults, in a stable order. */
export function brandList(assets: Asset[]): string[] {
  const extra = [...new Set(assets.map((a) => a.brand))].filter((b) => !DEFAULT_BRANDS.includes(b)).sort();
  return [...DEFAULT_BRANDS, ...extra];
}

/** Text search over name, brand, category and tags. */
export function matches(a: Asset, q: string): boolean {
  if (!q.trim()) return true;
  const hay = `${a.name} ${a.brand} ${a.category} ${a.tags.join(" ")}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

/** Compact catalog for the AI builder: one line per image asset. */
export function assetCatalog(assets: Asset[], max = 150): string {
  return assets
    .filter((a) => (a.mime ?? "image/").startsWith("image/"))
    .slice(0, max)
    .map((a) => `- ${a.name} [${a.brand} · ${a.category}${a.tags.length ? ` · ${a.tags.join(", ")}` : ""}]${a.notes ? ` (note: ${a.notes.replace(/\s+/g, " ").slice(0, 160)})` : ""}: ${a.url}`)
    .join("\n");
}
