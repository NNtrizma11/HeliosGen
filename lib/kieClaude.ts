/**
 * LLM calls through Kie.ai with automatic retry and model fallback.
 *
 * Kie pools upstream accounts per model; when a pool is empty it answers
 * "no_available_account" (sometimes inside the SSE stream). Those capacity errors
 * are temporary, so we retry briefly and then try the next model in the chain.
 * Claude pools tend to run dry together, so the chain ends with Gemini and GPT,
 * which sit on separate upstream providers.
 */

const CLAUDE_ENDPOINT = "https://api.kie.ai/claude/v1/messages";

type Provider = { model: string; kind: "claude" } | { model: string; kind: "openai"; endpoint: string };

/** Tried in order. Sonnet first (fast, cheap); Opus has its own pool; then other providers. */
export const MODEL_CHAIN: Provider[] = [
  { model: "claude-sonnet-4-6", kind: "claude" },
  { model: "claude-opus-4-7", kind: "claude" },
  { model: "gemini-3.1-pro", kind: "openai", endpoint: "https://api.kie.ai/gemini-3.1-pro/v1/chat/completions" },
  { model: "gpt-5-2", kind: "openai", endpoint: "https://api.kie.ai/gpt-5-2/v1/chat/completions" },
];
export const CLAUDE_CHAIN = MODEL_CHAIN.map((p) => p.model);

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
      usage?: { output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
      code?: number;
      msg?: string;
    } | null = null;
    try { p = JSON.parse(payload); } catch { return; }
    if (Array.isArray(p?.choices)) {
      // OpenAI chat-completions stream (Gemini / GPT on Kie)
      const d = p.choices[0]?.delta;
      if (d?.content) {
        if (stats.firstText === null) stats.firstText = secs();
        text += d.content;
        stats.textChars = text.length;
      }
      if (d?.reasoning_content) stats.thinkingChars += d.reasoning_content.length;
      if (p.usage) {
        stats.inputTokens = p.usage.prompt_tokens ?? stats.inputTokens;
        stats.outputTokens = p.usage.completion_tokens ?? stats.outputTokens;
      }
    } else if (p?.usage && !p.type) {
      stats.inputTokens = p.usage.prompt_tokens ?? stats.inputTokens;
      stats.outputTokens = p.usage.completion_tokens ?? stats.outputTokens;
    } else if (typeof p?.code === "number" && p.code !== 200 && !p.type) {
      fail(`${p.code} ${p.msg ?? "Model error"}`);
    } else if (p?.type === "content_block_delta") {
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
      // Keep a sample of SSE for error sniffing, but all of a plain JSON body (it may be long).
      if (raw.length < 4000 || !raw.includes("data:")) raw += chunk;
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
      // Kie reports errors as HTTP 200 + { code, msg }
      if (typeof j.code === "number" && j.code !== 200) {
        const m = `${j.code} ${typeof j.msg === "string" ? j.msg : "Model error"}`;
        throw j.code === 429 || j.code >= 500 || CAPACITY.test(m) ? new CapacityError(m) : new Error(m);
      }
      const choices = j.choices as Array<{ message?: { content?: string } }> | undefined;
      const blocks = (j.content ?? []) as Array<{ type: string; text?: string }>;
      text = Array.isArray(choices)
        ? choices.map((c) => c.message?.content ?? "").join("")
        : blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
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

function request(p: Provider, apiKey: string, messages: ClaudeMsg[], maxTokens: number, thinkingOff: boolean): Promise<Response> {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (p.kind === "openai") {
    // Same body the assistant panel already uses against these endpoints.
    return fetch(p.endpoint, {
      method: "POST",
      cache: "no-store",
      headers,
      body: JSON.stringify({
        messages: messages.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] })),
        stream: true,
      }),
    });
  }
  return fetch(CLAUDE_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers,
    // Kie runs Sonnet with hidden extended thinking by default (~85% of output tokens
    // on builds); structured JSON doesn't need it. Dropped if Kie rejects the field.
    body: JSON.stringify({ model: p.model, messages, stream: true, max_tokens: maxTokens, ...(thinkingOff ? { thinking: { type: "disabled" } } : {}) }),
  });
}

/** Send messages via Kie; retries capacity errors and falls back across MODEL_CHAIN. */
export async function askClaude(
  apiKey: string,
  messages: ClaudeMsg[],
  maxTokens: number,
  onProgress?: Progress,
): Promise<{ text: string; model: string; stats: ClaudeStats }> {
  const tried: string[] = [];
  let thinkingOff = true;
  for (const p of MODEL_CHAIN) {
    const { model } = p;
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(attempt * 4000);
      const t0 = Date.now();
      let res: Response;
      try {
        res = await request(p, apiKey, messages, maxTokens, thinkingOff);
      } catch (e) {
        last = `${model}: network ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      if (!res.ok) {
        const t = (await res.text()).slice(0, 300);
        if (p.kind === "claude" && thinkingOff && res.status === 400 && /thinking/i.test(t)) { thinkingOff = false; attempt--; continue; }
        if (res.status === 429 || res.status >= 500 || CAPACITY.test(t)) { last = `${model}: ${res.status} ${t}`; continue; }
        // A hard error on one provider (bad request, auth) shouldn't stop the others.
        last = `${model}: ${res.status} ${t}`;
        break;
      }
      const firstByte = Math.round((Date.now() - t0) / 100) / 10;
      try {
        const { text, stats: st } = await readReply(res, t0, onProgress);
        if (!text.trim()) { last = `${model}: empty reply`; continue; }
        const stats: ClaudeStats = { model, firstByte, ...st };
        console.log(`[kieClaude] ${model} first byte ${firstByte}s, first text ${st.firstText ?? "-"}s, total ${st.total}s, thinking ${st.thinkingChars} chars, text ${st.textChars} chars, tokens in ${st.inputTokens ?? "?"} / out ${st.outputTokens ?? "?"}`);
        return { text, model, stats };
      } catch (e) {
        if (e instanceof CapacityError) { last = `${model}: ${e.message}`; continue; }
        last = `${model}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
    tried.push(last);
    console.warn(`[kieClaude] ${model} unavailable, trying next model — ${last}`);
  }
  throw new Error(`No model on Kie.ai could answer right now (${tried.join(" | ")}). Try again in a few minutes.`);
}
