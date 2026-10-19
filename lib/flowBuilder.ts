// ─────────────────────────────────────────────────────────────────────────────
// FLOW BUILDER — turns a plain-language request into canvas nodes and edges.
//
// The language model returns a FlowPlan (JSON). This file:
//   1. describes what the canvas supports (catalogText → system prompt),
//   2. validates a plan against the real model configs (validatePlan),
//   3. converts a valid plan into React Flow nodes and edges (planToGraph).
//
// The builder never runs a generation. It only creates and connects nodes.
// ─────────────────────────────────────────────────────────────────────────────
import type { Node, Edge } from "@xyflow/react";
import type { NodeData } from "./store";
import { IMAGE_MODELS, VIDEO_MODELS } from "./modelConfig";
import { VOICE_MODELS, VOICES, VOICE_SETTINGS } from "./voiceConfig";
import { edgeStyle } from "./edgeStyles";

// ── Plan types ────────────────────────────────────────────────────────────────

export type PlanNodeType = "text" | "image_ref" | "image_gen" | "video_gen" | "voice";

/** A prompt is a list of parts joined with a blank line. "@NAME" inserts blocks[NAME]. */
export type PromptParts = string[];

export interface PlanNode {
  key: string;
  type: PlanNodeType;
  label?: string;
  col?: number;
  row?: number;
  /** image_ref only */
  url?: string;
  /** text, image_gen, video_gen, voice */
  prompt?: PromptParts;
  settings?: Record<string, unknown>;
}

export interface PlanEdge {
  from: string;
  to: string;
  input: "prompt" | "image" | "startFrame" | "endFrame" | "resource" | "audioRef" | "referenceVideo";
}

export interface FlowPlan {
  message?: string;
  problems?: string[];
  notes?: string[];
  blocks?: Record<string, string>;
  nodes: PlanNode[];
  edges: PlanEdge[];
  /** Repeated structures, expanded in code by expandSeries (keeps the model's reply short). */
  series?: PlanSeries[];
}

/** A node/edge pattern repeated `count` times. "{n}" = zero-padded number, "{i}" = plain number. */
export interface PlanSeries {
  from?: number;
  count: number;
  pad?: number;
  rowStart?: number;
  nodes: PlanNode[];
  edges?: PlanEdge[];
}

const MAX_SERIES_NODES = 400;

function substitute<T>(v: T, n: string, i: string): T {
  if (typeof v === "string") return v.replace(/\{n\}/g, n).replace(/\{i\}/g, i) as T;
  if (Array.isArray(v)) return v.map((x) => substitute(x, n, i)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, substitute(x, n, i)])) as T;
  }
  return v;
}

/** Expand plan.series into plain nodes and edges (in place). Returns the same object. */
export function expandSeries<T extends { nodes?: PlanNode[]; edges?: PlanEdge[]; series?: PlanSeries[] }>(plan: T): T {
  plan.nodes ??= [];
  plan.edges ??= [];
  let made = 0;
  for (const s of plan.series ?? []) {
    const from = Number.isFinite(Number(s.from)) ? Number(s.from) : 1;
    const count = Math.max(0, Math.floor(Number(s.count) || 0));
    const pad = Math.max(1, Math.floor(Number(s.pad) || String(from + count - 1).length));
    const templates = Array.isArray(s.nodes) ? s.nodes : [];
    const rowsPer = templates.reduce((m, t) => Math.max(m, (t.row ?? 0) + 1), 1);
    for (let k = 0; k < count && made < MAX_SERIES_NODES; k++) {
      const num = from + k;
      const n = String(num).padStart(pad, "0");
      const i = String(num);
      for (const t of templates) {
        const node = substitute(t, n, i);
        node.row = (s.rowStart ?? 0) + k * rowsPer + (t.row ?? 0);
        plan.nodes.push(node);
        made++;
      }
      for (const e of s.edges ?? []) plan.edges.push(substitute(e, n, i));
    }
  }
  delete plan.series;
  return plan;
}

// ── User lines ────────────────────────────────────────────────────────────────

const LABEL_LINE = /^\s*(?:[-*•]\s*)?\**([A-Za-z]{1,8}[_-]?\d{1,3}[a-z]?)\**\s*[:—–.)\-](?:\s+(\S.*))?\s*$/;

/**
 * Labeled passages in the user's messages ("V24: She sips…", "S01 — …") become blocks
 * named by their label, so the model references "@V24" instead of retyping the text.
 * A passage is the rest of its line; only a label alone on its line ("S01:") takes the
 * following lines, up to a blank line or the next label. Needs at least 2 labels.
 */
export function userBlocks(texts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const text of texts) {
    let cur: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(LABEL_LINE);
      if (m) {
        const name = m[1].replace(/-/g, "_");
        out[name] = (m[2] ?? "").trimEnd();
        cur = m[2] ? null : name;
      } else if (!line.trim()) {
        cur = null;
      } else if (cur) {
        out[cur] = out[cur] ? `${out[cur]}\n${line.trimEnd()}` : line.trimEnd();
      }
    }
    for (const k of Object.keys(out)) if (!out[k].trim()) delete out[k];
  }
  return Object.keys(out).length >= 2 ? out : {};
}

/** Instructions telling the model which user lines are pre-stored as blocks. */
export function userBlocksText(blocks: Record<string, string>): string {
  const names = Object.keys(blocks);
  if (!names.length) return "";
  return `\n\nSTORED USER LINES — these labeled passages from the user's messages are ALREADY stored as blocks under exactly these names: ${names.join(", ")}.
Reference them as "@NAME" (e.g. "@${names[0]}") wherever a prompt should contain that passage. Do NOT copy their text and do NOT redefine them in "blocks". Inside a series match the label's numbering: "{n}" for zero-padded labels like ${names.find((x) => /\D0\d/.test(x)) ?? "S01"}, "{i}" for plain ones like ${names.find((x) => /\D[1-9]\d*$/.test(x)) ?? "V1"}.`;
}

// ── Catalog (what the canvas supports) ───────────────────────────────────────

export function catalogText(): string {
  const img = IMAGE_MODELS.map((m) => {
    const q = m.supportsQuality ? (m.apiInput.qualityOptions ?? ["1k", "2k", "4k"]) : [];
    const qLabel = m.apiInput.qualityMap
      ? q.map((v) => `${v} (= "${m.apiInput.qualityMap![v] ?? v}")`).join(", ")
      : q.join(", ");
    return `- ${m.id} — "${m.name}". aspectRatio: ${m.ratios.join(", ")}. quality: ${qLabel || "none"}. reference images (input "image"): ${m.supportsImages ? `up to ${m.maxImages}` : "not supported"}. prompt max ${m.apiInput.promptMaxLength} chars.`;
  }).join("\n");

  const vid = VIDEO_MODELS.map((m) => {
    const modes = m.modes?.length ? `mode: ${m.modes.map((x) => `${x.value} (= "${x.label}")`).join(", ")}` : "";
    const res = m.resolutions?.length ? `resolution: ${m.resolutions.join(", ")}` : "";
    return `- ${m.id} — "${m.name}". aspectRatio: ${m.ratios.join(", ")}. duration (seconds): ${m.durations.join(", ")}. ${[modes, res].filter(Boolean).join(". ")}${modes || res ? ". " : ""}sound: ${m.sound ? "on/off" : "not supported"}. inputs: ${m.handles.join(", ")}. prompt max ${m.apiInput.promptMaxLength ?? "?"} chars.`;
  }).join("\n");

  const voice = VOICE_MODELS.map((m) => `- ${m.id} — "${m.name}". text max ${m.maxChars} chars. Language follows the text (multilingual).`).join("\n");
  const voices = VOICES.map((v) => `${v.id} (${v.name})`).join(", ");

  return `IMAGE MODELS (node type "image_gen", settings: model, aspectRatio, quality):
${img}

VIDEO MODELS (node type "video_gen", settings: model, aspectRatio, duration, mode, resolution, sound):
${vid}

VOICE MODELS (node type "voice", settings: model, voice, speed ${VOICE_SETTINGS.speed.min}–${VOICE_SETTINGS.speed.max}):
${voice}
Voices: ${voices}

NOT AVAILABLE ON THIS CANVAS: "Enhance Prompt" (prompts are always sent unchanged, so it is effectively off), negative prompts, batch size above 1 at build time (batch size is chosen when the user runs a node).`;
}

export const FLOW_BUILDER_RULES = `You build node workflows on a visual canvas for AI image, video and voice generation. You never run anything; you only describe nodes and connections as JSON.

Reply with ONE JSON object and nothing else (no markdown fences), shaped like:
{
  "message": "one or two sentences for the user about what you built",
  "problems": [],
  "notes": [],
  "blocks": { "BIBLE": "long text reused in several prompts" },
  "nodes": [
    { "key": "hero", "type": "image_gen", "label": "HERO", "col": 0, "row": 0,
      "settings": { "model": "seedream-4-5", "aspectRatio": "9:16", "quality": "2k" },
      "prompt": ["@BIBLE", "SHOT: ...", "@SUFFIX"] },
    { "key": "product", "type": "image_ref", "label": "PRODUCT", "col": 0, "row": 1, "url": "https://..." },
    { "key": "vid01", "type": "video_gen", "label": "VID 01", "col": 2, "row": 0,
      "settings": { "model": "kling-3.0", "aspectRatio": "9:16", "duration": 5, "mode": "std", "sound": false },
      "prompt": ["..."] },
    { "key": "vo", "type": "voice", "label": "VOICEOVER", "col": 0, "row": 2,
      "settings": { "model": "elevenlabs-multilingual-v2", "voice": "<voice id>", "speed": 1 },
      "prompt": ["script text"] }
  ],
  "edges": [ { "from": "hero", "to": "img01", "input": "image" } ]
}

Node types:
- "image_gen": image generation. Its prompt becomes a connected text node automatically.
- "video_gen": video generation. Its prompt becomes a connected text node automatically.
- "voice": text-to-speech. Its prompt is the script and becomes a connected text node automatically.
- "image_ref": a reference image loaded from "url". If no URL is given, omit "url" and the user uploads it.
- "text": a standalone text node (only when the user asks for one; prompts of generators do NOT need separate text nodes).

Edge inputs:
- "image": reference image into an image_gen (from image_ref or image_gen).
- "startFrame" / "endFrame": first or last frame of a video_gen (from image_ref or image_gen).
- "resource": reference image (element) into a video_gen, only if that model lists "resource".
- "audioRef": audio into a video_gen, only if that model lists "audioRef" (from a voice node).
- "prompt": only from a "text" node; generators get their prompts automatically, so do not add prompt edges for them.

Prompts:
- "prompt" is an array of parts, joined with a blank line. A part "@NAME" inserts blocks.NAME verbatim.
- Put any text that repeats in several prompts into "blocks" once and reference it, instead of repeating it.
- Copy every text the user gives you EXACTLY, character for character. Never rewrite, shorten, enhance, translate or fix it. If the user asks for a variant of a block (for example "without its first sentence"), create a separate block containing exactly that variant.
- Write new prompt text yourself only when the user asks you to create it.

Settings:
- Use only model ids and values listed in the catalog. Map the user's wording to catalog values (e.g. "720p" → the mode whose label is 720p; "Basic" quality on Seedream → "2k").
- If the user requires a model, setting, input or connection that the catalog does not offer, do NOT substitute: return "nodes": [] and "edges": [], and explain each missing item in "problems". Exception: a setting the catalog marks as not available but harmless (like Enhance Prompt off) goes in "notes", and you continue.
- If the user leaves a setting open, pick a sensible default and mention it in "notes".

Layout:
- "col" and "row" are grid positions starting at 0. Follow the user's layout instructions. Default: inputs in column 0, images in column 1, videos in column 2, one row per shot.

Keys must be unique, short and use only letters, digits and underscores.

Repeated structures — SPEED MATTERS, the user waits while you write:
- Whenever 3 or more nodes follow the same pattern, describe the pattern ONCE in "series" instead of listing every node:
  "series": [ { "from": 1, "count": 27, "pad": 2, "rowStart": 0,
    "nodes": [ { "key": "img{n}", "type": "image_gen", "label": "IMG {n}", "col": 1, "settings": { ... }, "prompt": ["@BIBLE", "@S{n}"] },
               { "key": "vid{n}", "type": "video_gen", "label": "VID {n}", "col": 2, "settings": { ... }, "prompt": ["@V{i}"] } ],
    "edges": [ { "from": "product", "to": "img{n}", "input": "image" }, { "from": "img{n}", "to": "vid{n}", "input": "startFrame" } ] } ]
- In a series template, "{n}" becomes the number zero-padded to "pad" digits (01, 02…) and "{i}" the plain number (1, 2…), in keys, labels, prompts and edges.
- Each repetition gets its own row(s), starting at "rowStart"; a template's "row" is an offset inside one repetition.
- Series nodes may connect to normal nodes (fixed keys) and normal "edges" may point at series keys (e.g. "img07").
- Per-item text that is not a stored user line goes into "blocks" (e.g. "S01"…"S27") and the template references "@S{n}". Keep "message" and "notes" short.

Costs: never calculate or estimate credit costs. The app adds exact costs after building; if the user asks for costs, say they are shown below.`;

// ── Prompt assembly ───────────────────────────────────────────────────────────

export function assemblePrompt(parts: PromptParts | undefined, blocks: Record<string, string> | undefined): {
  text: string;
  missing: string[];
} {
  const missing: string[] = [];
  const out = (parts ?? []).map((p) => {
    if (typeof p !== "string") return "";
    const m = p.match(/^@([A-Za-z0-9_]+)$/);
    if (!m) return p;
    const b = blocks?.[m[1]];
    if (b === undefined) { missing.push(m[1]); return ""; }
    return b;
  });
  return { text: out.filter((s) => s.length > 0).join("\n\n"), missing };
}

// ── Validation ────────────────────────────────────────────────────────────────

const VIDEO_INPUTS = new Set(["startFrame", "endFrame", "resource", "audioRef", "referenceVideo"]);

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validatePlan(plan: FlowPlan): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byKey = new Map<string, PlanNode>();

  if (!Array.isArray(plan.nodes)) errors.push("The plan has no node list.");
  if (!Array.isArray(plan.edges)) errors.push("The plan has no connection list.");
  if (errors.length) return { errors, warnings };

  for (const n of plan.nodes) {
    const name = n.label ?? n.key;
    if (!n.key || byKey.has(n.key)) { errors.push(`Node key "${n.key}" is missing or used twice.`); continue; }
    byKey.set(n.key, n);
    const s = n.settings ?? {};

    if (n.prompt !== undefined || n.type === "text") {
      const { text, missing } = assemblePrompt(n.prompt, plan.blocks);
      if (missing.length) errors.push(`${name}: prompt refers to unknown block(s) ${missing.join(", ")}.`);
      if (!text.trim() && n.type !== "image_ref") warnings.push(`${name}: prompt is empty.`);
      n.settings = { ...s, __promptLength: text.length };
    }

    if (n.type === "image_gen") {
      const m = IMAGE_MODELS.find((x) => x.id === s.model);
      if (!m) { errors.push(`${name}: image model "${String(s.model)}" is not available.`); continue; }
      if (s.aspectRatio !== undefined && !m.ratios.includes(String(s.aspectRatio)))
        errors.push(`${name}: aspect ratio ${String(s.aspectRatio)} is not available on ${m.name}.`);
      if (s.quality !== undefined) {
        const opts = m.supportsQuality ? (m.apiInput.qualityOptions ?? ["1k", "2k", "4k"]) : [];
        if (!opts.includes(String(s.quality)))
          errors.push(`${name}: quality "${String(s.quality)}" is not available on ${m.name}.`);
      }
      const len = (n.settings?.__promptLength as number | undefined) ?? 0;
      if (len > m.apiInput.promptMaxLength)
        warnings.push(`${name}: prompt is ${len} characters; ${m.name} accepts ${m.apiInput.promptMaxLength}.`);
    } else if (n.type === "video_gen") {
      const m = VIDEO_MODELS.find((x) => x.id === s.model);
      if (!m) { errors.push(`${name}: video model "${String(s.model)}" is not available.`); continue; }
      if (s.aspectRatio !== undefined && !m.ratios.includes(String(s.aspectRatio)))
        errors.push(`${name}: aspect ratio ${String(s.aspectRatio)} is not available on ${m.name}.`);
      if (s.duration !== undefined && !m.durations.includes(Number(s.duration)))
        errors.push(`${name}: duration ${String(s.duration)}s is not available on ${m.name}.`);
      if (s.mode !== undefined && !m.modes?.some((x) => x.value === s.mode))
        errors.push(`${name}: mode "${String(s.mode)}" is not available on ${m.name}.`);
      if (s.resolution !== undefined && !m.resolutions?.includes(String(s.resolution)))
        errors.push(`${name}: resolution "${String(s.resolution)}" is not available on ${m.name}.`);
      if (s.sound === true && !m.sound)
        errors.push(`${name}: ${m.name} does not support sound.`);
      const len = (n.settings?.__promptLength as number | undefined) ?? 0;
      const max = m.apiInput.promptMaxLength;
      if (max && len > max) warnings.push(`${name}: prompt is ${len} characters; ${m.name} accepts ${max}.`);
    } else if (n.type === "voice") {
      const m = VOICE_MODELS.find((x) => x.id === (s.model ?? VOICE_MODELS[0].id));
      if (!m) { errors.push(`${name}: voice model "${String(s.model)}" is not available.`); continue; }
      if (s.voice !== undefined && !VOICES.some((v) => v.id === s.voice))
        errors.push(`${name}: voice "${String(s.voice)}" is not available.`);
      const len = (n.settings?.__promptLength as number | undefined) ?? 0;
      if (len > m.maxChars) errors.push(`${name}: script is ${len} characters; the limit is ${m.maxChars}.`);
    } else if (n.type === "image_ref") {
      if (n.url !== undefined && !/^https?:\/\//.test(n.url))
        errors.push(`${name}: image URL must start with http:// or https://.`);
    } else if (n.type !== "text") {
      errors.push(`${name}: unknown node type "${String(n.type)}".`);
    }
  }

  const imageCounts = new Map<string, number>();
  const single = new Set<string>();
  for (const e of plan.edges) {
    const a = byKey.get(e.from);
    const b = byKey.get(e.to);
    const where = `${a?.label ?? e.from} → ${b?.label ?? e.to}`;
    if (!a || !b) { errors.push(`Connection ${where} refers to a node that does not exist.`); continue; }

    if (e.input === "prompt") {
      if (a.type !== "text") errors.push(`${where}: only text nodes can feed a prompt.`);
      if (b.prompt !== undefined) errors.push(`${where}: ${b.label ?? b.key} already has its own prompt.`);
    } else if (e.input === "image") {
      if (b.type !== "image_gen") errors.push(`${where}: "image" input exists only on image nodes.`);
      if (a.type !== "image_ref" && a.type !== "image_gen") errors.push(`${where}: only images can be image references.`);
      const m = IMAGE_MODELS.find((x) => x.id === b.settings?.model);
      const c = (imageCounts.get(b.key) ?? 0) + 1;
      imageCounts.set(b.key, c);
      if (m && !m.supportsImages) errors.push(`${where}: ${m.name} does not accept reference images.`);
      else if (m && c > m.maxImages) errors.push(`${b.label ?? b.key}: ${m.name} accepts up to ${m.maxImages} reference images.`);
    } else if (VIDEO_INPUTS.has(e.input)) {
      if (b.type !== "video_gen") { errors.push(`${where}: "${e.input}" exists only on video nodes.`); continue; }
      const m = VIDEO_MODELS.find((x) => x.id === b.settings?.model);
      if (m && !m.handles.includes(e.input as never))
        errors.push(`${where}: ${m.name} has no "${e.input}" input.`);
      if (e.input === "audioRef") {
        if (a.type !== "voice") errors.push(`${where}: only voice nodes can feed audio.`);
      } else if (e.input !== "referenceVideo" && a.type !== "image_ref" && a.type !== "image_gen") {
        errors.push(`${where}: "${e.input}" needs an image.`);
      }
      if (e.input === "startFrame" || e.input === "endFrame") {
        const k = `${b.key}:${e.input}`;
        if (single.has(k)) errors.push(`${b.label ?? b.key}: only one ${e.input} is allowed.`);
        single.add(k);
      }
    } else {
      errors.push(`${where}: unknown input "${String(e.input)}".`);
    }
  }

  return { errors, warnings };
}

// ── Conversion to canvas nodes ────────────────────────────────────────────────

const TEXT_W = 420;
const TEXT_H = 240;
const GEN_W = 300;
const GAP = 48;
const COL_GAP = 200;
const ROW_GAP = 80;

function ratioHeight(width: number, ratio: unknown): number {
  const r = String(ratio ?? "1:1");
  const m = r.match(/^(\d+):(\d+)$/);
  if (!m) return width;
  return Math.round((width * Number(m[2])) / Number(m[1]));
}

function nodeBox(n: PlanNode): { w: number; h: number } {
  switch (n.type) {
    case "text":      return { w: TEXT_W, h: TEXT_H };
    case "image_ref": return { w: 220, h: 220 };
    case "voice":     return { w: GEN_W, h: 280 };
    case "video_gen": return { w: GEN_W, h: Math.max(240, ratioHeight(GEN_W, n.settings?.aspectRatio) + 60) };
    default:          return { w: GEN_W, h: Math.max(240, ratioHeight(GEN_W, n.settings?.aspectRatio)) };
  }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export interface BuiltGraph {
  nodes: Node<NodeData>[];
  edges: Edge[];
  /** Plan key → created node id */
  ids: Record<string, string>;
  /** image_ref nodes whose URL should be imported into storage */
  imports: Array<{ nodeId: string; url: string }>;
}

export function planToGraph(plan: FlowPlan, origin: { x: number; y: number }): BuiltGraph {
  const hasPrompt = (n: PlanNode) => n.type !== "text" && n.type !== "image_ref" && n.prompt !== undefined;

  // Column widths and row heights from the boxes that land in them
  const colW = new Map<number, number>();
  const rowH = new Map<number, number>();
  for (const n of plan.nodes) {
    const c = n.col ?? 0, r = n.row ?? 0;
    const box = nodeBox(n);
    const w = box.w + (hasPrompt(n) ? TEXT_W + GAP : 0);
    colW.set(c, Math.max(colW.get(c) ?? 0, w));
    rowH.set(r, Math.max(rowH.get(r) ?? 0, Math.max(box.h, hasPrompt(n) ? TEXT_H : 0)));
  }
  const colX = (c: number) => {
    let x = origin.x;
    for (let i = 0; i < c; i++) x += (colW.get(i) ?? 0) + (colW.has(i) ? COL_GAP : 0);
    return x;
  };
  const rowY = (r: number) => {
    let y = origin.y;
    for (let i = 0; i < r; i++) y += (rowH.get(i) ?? 0) + (rowH.has(i) ? ROW_GAP : 0);
    return y;
  };

  const nodes: Node<NodeData>[] = [];
  const edges: Edge[] = [];
  const ids: Record<string, string> = {};
  const imports: BuiltGraph["imports"] = [];

  const addEdge = (source: string, target: string, targetHandle: string, sourceHandle: string | null = null) => {
    edges.push({
      id: `e-${uid()}`,
      source,
      target,
      sourceHandle,
      targetHandle,
      animated: false,
      style: edgeStyle(targetHandle),
    });
  };

  for (const n of plan.nodes) {
    const c = n.col ?? 0, r = n.row ?? 0;
    const box = nodeBox(n);
    const x0 = colX(c);
    const y0 = rowY(r);
    const nodeX = hasPrompt(n) ? x0 + TEXT_W + GAP : x0;
    const s = n.settings ?? {};
    const label = n.label ?? n.key;
    let id: string;

    if (n.type === "text") {
      id = `promptNode-${uid()}`;
      nodes.push({
        id, type: "promptNode", position: { x: x0, y: y0 },
        style: { width: TEXT_W, height: TEXT_H },
        data: { label, status: "idle", prompt: assemblePrompt(n.prompt, plan.blocks).text },
      });
    } else if (n.type === "image_ref") {
      id = `imageInputNode-${uid()}`;
      nodes.push({
        id, type: "imageInputNode", position: { x: x0, y: y0 },
        style: { width: box.w },
        data: { label, status: "idle", ...(n.url ? { inputImage: n.url, r2Url: n.url } : {}) },
      });
      if (n.url) imports.push({ nodeId: id, url: n.url });
    } else if (n.type === "image_gen") {
      id = `generateNode-${uid()}`;
      nodes.push({
        id, type: "generateNode", position: { x: nodeX, y: y0 },
        style: { width: box.w, height: box.h },
        data: {
          label, status: "idle",
          model: s.model as string,
          ...(s.aspectRatio !== undefined ? { aspectRatio: String(s.aspectRatio) } : {}),
          ...(s.quality !== undefined ? { quality: String(s.quality) } : {}),
        },
      });
    } else if (n.type === "video_gen") {
      id = `videoGeneratorNode-${uid()}`;
      nodes.push({
        id, type: "videoGeneratorNode", position: { x: nodeX, y: y0 },
        style: { width: box.w, height: box.h },
        data: {
          label, status: "idle",
          videoModel: s.model as string,
          ...(s.aspectRatio !== undefined ? { aspectRatio: String(s.aspectRatio) } : {}),
          ...(s.duration !== undefined ? { duration: Number(s.duration) } : {}),
          ...(s.mode !== undefined ? { klingMode: String(s.mode) } : {}),
          ...(s.resolution !== undefined ? { grokResolution: String(s.resolution) } : {}),
          sound: s.sound === true,
        },
      });
    } else {
      id = `voiceNode-${uid()}`;
      nodes.push({
        id, type: "voiceNode", position: { x: nodeX, y: y0 },
        style: { width: box.w },
        data: {
          label, status: "idle",
          voiceModel: (s.model as string | undefined) ?? VOICE_MODELS[0].id,
          ...(s.voice !== undefined ? { voice: String(s.voice) } : {}),
          ...(s.speed !== undefined ? { speed: Number(s.speed) } : {}),
        },
      });
    }
    ids[n.key] = id;

    if (hasPrompt(n)) {
      const tid = `promptNode-${uid()}`;
      nodes.push({
        id: tid, type: "promptNode", position: { x: x0, y: y0 },
        style: { width: TEXT_W, height: TEXT_H },
        data: { label: `${label} PROMPT`, status: "idle", prompt: assemblePrompt(n.prompt, plan.blocks).text },
      });
      addEdge(tid, id, "prompt");
    }
  }

  for (const e of plan.edges) {
    const from = plan.nodes.find((n) => n.key === e.from);
    const sourceHandle = from?.type === "voice" ? "audioRefOut" : null;
    addEdge(ids[e.from], ids[e.to], e.input, sourceHandle);
  }

  return { nodes, edges, ids, imports };
}

/** Pull the first JSON object out of a model reply (tolerates code fences and stray text). */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The reply contained no JSON.");
  return JSON.parse(text.slice(start, end + 1));
}
