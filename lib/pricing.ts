// ─────────────────────────────────────────────────────────────────────────────
// PRICING — credit estimates for generations.
//
// Kie bills in credits; 1 credit = $0.005 (derived from kie.ai/pricing).
// Estimates come from the most recent REAL charge recorded for the same
// model + settings (see /api/costs/estimates). The starter table below is only
// used for combinations that have never been run; it is marked as an estimate.
// ─────────────────────────────────────────────────────────────────────────────

export const USD_PER_CREDIT = 0.005;

export type CostKind = "image" | "video" | "audio";

export interface CostSpec {
  /** Groups generations that are billed the same way */
  key: string;
  /** Billing units for this job: 1 per image, seconds for video, 1k characters for audio */
  units: number;
}

/** Image price tier: the quality value the API actually receives (e.g. "basic" and "2k" can be the same tier). */
export function imageCostSpec(
  model: string,
  quality: string | undefined,
  cfg: { supportsQuality: boolean; apiInput: { qualityMap?: Record<string, string> } } | undefined,
): CostSpec {
  const q = quality ?? "1k";
  const tier = cfg?.supportsQuality ? (cfg.apiInput.qualityMap?.[q] ?? q) : "-";
  return { key: `img:${model}:${tier}`, units: 1 };
}

/** The setting that drives a video model's price: its mode (e.g. Kling std/pro) or resolution. */
export function videoTier(
  cfg: { modes?: { value: string }[]; resolutions?: string[] } | undefined,
  mode: string | undefined,
  resolution: string | undefined,
): string {
  if (cfg?.modes?.length) return mode || "-";
  if (cfg?.resolutions?.length) return resolution || "-";
  return "-";
}

export function videoCostSpec(model: string, tier: string, sound: boolean, duration: number | undefined): CostSpec {
  return {
    key: `vid:${model}:${tier}:${sound ? "sound" : "silent"}`,
    units: Math.max(1, Number(duration) || 1),
  };
}

export function audioCostSpec(model: string, textLength: number): CostSpec {
  return { key: `tts:${model}`, units: Math.max(0.001, textLength / 1000) };
}

/**
 * Starter prices in credits per unit, used only until a real charge is recorded.
 * Kling 3.0: kie.ai/pricing, per second (720p = std, 1080p = pro).
 * Nano Banana 2 (1K): measured on this account.
 */
export const STARTER_PRICES: Record<string, number> = {
  "vid:kling-3.0:std:silent": 14,
  "vid:kling-3.0:std:sound": 18,
  "vid:kling-3.0:pro:silent": 18,
  "vid:kling-3.0:pro:sound": 23,
  "vid:kling-3.0:4K:silent": 67,
  "vid:kling-3.0:4K:sound": 67,
  "img:nano-banana-2:basic": 8,
};

export interface Estimate {
  /** Credits for the whole job, or null when unknown */
  credits: number | null;
  /** "measured" = from a real charge on this account; "starter" = from the table */
  source: "measured" | "starter" | "unknown";
}

/** perUnit: measured credits per unit, keyed by cost key (from /api/costs/estimates). */
export function estimate(spec: CostSpec, perUnit: Record<string, number> | null | undefined): Estimate {
  const measured = perUnit?.[spec.key];
  if (measured !== undefined) return { credits: measured * spec.units, source: "measured" };
  const starter = STARTER_PRICES[spec.key];
  if (starter !== undefined) return { credits: starter * spec.units, source: "starter" };
  return { credits: null, source: "unknown" };
}

export function creditsToUsd(credits: number): number {
  return credits * USD_PER_CREDIT;
}

/** Compact credit label for node bubbles: "8 cr", "70 cr", "<1 cr". */
export function formatCredits(credits: number): string {
  if (credits > 0 && credits < 1) return "<1 cr";
  if (credits >= 100) return `${Math.round(credits)} cr`;
  return `${Math.round(credits * 10) / 10} cr`;
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
