/**
 * Claude through Kie.ai with automatic retry and model fallback.
 *
 * Kie pools upstream accounts per model; when a pool is empty it answers
 * "no_available_account" (sometimes inside the SSE stream). Those capacity errors
 * are temporary, so we retry briefly and then try the next model in the chain.
 */

const ENDPOINT = "https://api.kie.ai/claude/v1/messages";

/** Tried in order. Sonnet first (fast, cheap); Opus has its own pool. */
export const CLAUDE_CHAIN = ["claude-sonnet-4-6", "claude-opus-4-7"];

export interface ClaudeMsg { role: "user" | "assistant"; content: string }

class CapacityError extends Error {}

const CAPACITY = /no_available_account|overloaded|rate.?limit|capacity|temporarily|try again/i;

/** Where the time went on one call — logged and returned with the job result. */
export interface ClaudeStats {
  model: string;
  /** Seconds until the HTTP response started */
  firstByte: number;
  /** Seconds until the first visible text */
  firstText: number | null;
  /** Total seconds */
  total: number;
  thinkingChars: number;
  textChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Progress during a call; `partial` is the reply text so far (for live step logs). */
type Progress = (p: { textChars: number; thinkingChars: number; seconds: number; partial: string }) => void;

/** Read an Anthropic-style SSE stream (or a plain JSON reply) into text, measuring as it goes. */
export async function readReply(res: Response, t0 = Date.now(), onProgress?: Progress): Promise<{ text: string; stats: Omit<ClaudeStats, "model" | "firstByte"> }> {
  const fail = (msg: string) => { throw CAPACITY.test(msg) ? new CapacityError(msg) : new Error(msg); };
  const stats = { firstText: null as number | null, total: 0, thinkingChars: 0, textChars: 0, inputTokens: null as number | null, outputTokens: null as number | null };
  const secs = () => Math.round((Date.now() - t0) / 100) / 10;
  let text = "";
  let raw = "";
  let buf = "";
  let lastReport = 0;

  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let p: {
      type?: string;
      delta?: { type?: string; text?: string; thinking?: string };
      error?: { message?: string } | string;
      message?: { usage?: { input_tokens?: number } };
      usage?: { output_tokens?: number };
    } | null = null;
    try { p = JSON.parse(payload); } catch { return; }
    if (p?.type === "content_block_delta") {
      if (p.delta?.type === "text_delta") {
        if (stats.firstText === null) stats.firstText = secs();
        text += p.delta.text ?? "";
        stats.textChars = text.length;
      } else if (p.delta?.type === "thinking_delta") {
        stats.thinkingChars += (p.delta.thinking ?? "").length;
      }
    } else if (p?.type === "message_start") {
      stats.inputTokens = p.message?.usage?.input_tokens ?? null;
    } else if (p?.type === "message_delta") {
      stats.outputTokens = p.usage?.output_tokens ?? stats.outputTokens;
    } else if (p?.type === "error") {
      fail(typeof p.error === "string" ? p.error : p.error?.message ?? "Model error");
    }
  };

  const reader = res.body?.getReader();
  if (reader) {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (raw.length < 4000) raw += chunk;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      if (onProgress && Date.now() - lastReport > 3000) {
        lastReport = Date.now();
        onProgress({ textChars: stats.textChars, thinkingChars: stats.thinkingChars, seconds: secs(), partial: text });
      }
    }
    if (buf) handle(buf);
  } else {
    raw = await res.text();
    for (const line of raw.split("\n")) handle(line);
  }
  stats.total = secs();

  // Non-streamed JSON reply
  if (!text && raw.trim().startsWith("{")) {
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(raw.trim()); } catch { /* not JSON */ }
    if (j) {
      const blocks = (j.content ?? []) as Array<{ type: string; text?: string }>;
      text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (!text) {
        const err = j.error ?? j.msg ?? j.message;
        if (err) fail(typeof err === "string" ? err : JSON.stringify(err));
      }
      stats.textChars = text.length;
    }
  }
  if (!text && CAPACITY.test(raw)) throw new CapacityError(raw.slice(0, 200));
  return { text, stats };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send messages to Claude via Kie; retries capacity errors and falls back across CLAUDE_CHAIN. */
export async function askClaude(
  apiKey: string,
  messages: ClaudeMsg[],
  maxTokens: number,
  onProgress?: Progress,
): Promise<{ text: string; model: string; stats: ClaudeStats }> {
  let last = "";
  let thinkingOff = true;
  for (const model of CLAUDE_CHAIN) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(attempt * 4000);
      const t0 = Date.now();
      const res = await fetch(ENDPOINT, {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // Kie runs Sonnet with hidden extended thinking by default (~85% of output tokens
        // on builds); structured JSON doesn't need it. Dropped if Kie rejects the field.
        body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, ...(thinkingOff ? { thinking: { type: "disabled" } } : {}) }),
      });
      if (!res.ok) {
        const t = (await res.text()).slice(0, 300);
        if (thinkingOff && res.status === 400 && /thinking/i.test(t)) { thinkingOff = false; attempt--; continue; }
        if (res.status === 429 || res.status >= 500 || CAPACITY.test(t)) { last = `${model}: ${res.status} ${t}`; continue; }
        throw new Error(`Model request failed (${res.status}): ${t}`);
      }
      const firstByte = Math.round((Date.now() - t0) / 100) / 10;
      try {
        const { text, stats: st } = await readReply(res, t0, onProgress);
        const stats: ClaudeStats = { model, firstByte, ...st };
        console.log(`[kieClaude] ${model} first byte ${firstByte}s, first text ${st.firstText ?? "-"}s, total ${st.total}s, thinking ${st.thinkingChars} chars, text ${st.textChars} chars, tokens in ${st.inputTokens ?? "?"} / out ${st.outputTokens ?? "?"}`);
        return { text, model, stats };
      } catch (e) {
        if (e instanceof CapacityError) { last = `${model}: ${e.message}`; continue; }
        throw e;
      }
    }
    console.warn(`[kieClaude] ${model} unavailable, trying next model — ${last}`);
  }
  throw new Error(`Kie.ai has no Claude capacity right now (${last}). Try again in a few minutes.`);
}
