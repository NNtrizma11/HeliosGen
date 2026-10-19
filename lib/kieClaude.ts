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

/** Read an Anthropic-style SSE stream (or a plain JSON reply) into text. */
export async function readReply(res: Response): Promise<string> {
  const raw = await res.text();
  const trimmed = raw.trim();
  const fail = (msg: string) => { throw CAPACITY.test(msg) ? new CapacityError(msg) : new Error(msg); };
  if (trimmed.startsWith("{")) {
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(trimmed); } catch { /* fall through to SSE parsing */ }
    if (j) {
      const blocks = (j.content ?? []) as Array<{ type: string; text?: string }>;
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (text) return text;
      const err = j.error ?? j.msg ?? j.message;
      if (err) fail(typeof err === "string" ? err : JSON.stringify(err));
    }
  }
  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let p: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } | string } | null = null;
    try { p = JSON.parse(payload); } catch { continue; }
    if (p?.type === "content_block_delta" && p.delta?.type === "text_delta") text += p.delta.text ?? "";
    else if (p?.type === "error") fail(typeof p.error === "string" ? p.error : p.error?.message ?? "Model error");
  }
  if (!text && CAPACITY.test(raw)) throw new CapacityError(raw.slice(0, 200));
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send messages to Claude via Kie; retries capacity errors and falls back across CLAUDE_CHAIN. */
export async function askClaude(apiKey: string, messages: ClaudeMsg[], maxTokens: number): Promise<{ text: string; model: string }> {
  let last = "";
  for (const model of CLAUDE_CHAIN) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(attempt * 4000);
      const res = await fetch(ENDPOINT, {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }),
      });
      if (!res.ok) {
        const t = (await res.text()).slice(0, 300);
        if (res.status === 429 || res.status >= 500 || CAPACITY.test(t)) { last = `${model}: ${res.status} ${t}`; continue; }
        throw new Error(`Model request failed (${res.status}): ${t}`);
      }
      try {
        return { text: await readReply(res), model };
      } catch (e) {
        if (e instanceof CapacityError) { last = `${model}: ${e.message}`; continue; }
        throw e;
      }
    }
    console.warn(`[kieClaude] ${model} unavailable, trying next model — ${last}`);
  }
  throw new Error(`Kie.ai has no Claude capacity right now (${last}). Try again in a few minutes.`);
}
