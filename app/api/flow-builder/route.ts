/**
 * POST /api/flow-builder
 *
 * Turns a plain-language request into a FlowPlan (nodes + connections) using
 * Claude through the user's Kie key. Never starts any generation.
 *
 * Body: { messages: { role: "user" | "assistant"; content: string }[], rules?: string,
 *         mode?: "edit", targets?: EditTarget[] }
 * Returns: { plan, validation } — or in edit mode { edit, validation } — or { error }
 */
import { NextRequest, NextResponse } from "next/server";
import { getKieToken } from "@/lib/getKieToken";
import { FLOW_BUILDER_RULES, catalogText, extractJson, validatePlan, type FlowPlan } from "@/lib/flowBuilder";
import { NODE_EDIT_RULES, validateEdit, type EditPlan, type EditTarget } from "@/lib/nodeEdit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL = "claude-sonnet-4-6";
const ENDPOINT = "https://api.kie.ai/claude/v1/messages";

interface Msg { role: "user" | "assistant"; content: string }

/** Read an Anthropic-style SSE stream (or a plain JSON reply) into text. */
async function readReply(res: Response): Promise<string> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      const blocks = (j.content ?? []) as Array<{ type: string; text?: string }>;
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (text) return text;
      if (j.error) throw new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error));
    } catch (e) {
      if (e instanceof SyntaxError) { /* fall through to SSE parsing */ } else throw e;
    }
  }
  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const p = JSON.parse(payload);
      if (p.type === "content_block_delta" && p.delta?.type === "text_delta") text += p.delta.text ?? "";
      else if (p.type === "error") throw new Error(p.error?.message ?? "Model error");
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return text;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = await getKieToken(req);
    if (!apiKey) return NextResponse.json({ error: "No Kie.ai API key configured. Add one in Settings." }, { status: 401 });

    const body = (await req.json()) as { messages?: Msg[]; rules?: string; mode?: "build" | "edit"; targets?: EditTarget[] };
    const editing = body.mode === "edit" && Array.isArray(body.targets) && body.targets.length > 0;
    const history = (body.messages ?? []).filter(
      (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
    );
    if (!history.length || history[history.length - 1].role !== "user") {
      return NextResponse.json({ error: "Send a request first." }, { status: 400 });
    }

    const standing = body.rules?.trim()
      ? `\n\nTHE USER'S STANDING RULES (apply unless the request says otherwise):\n${body.rules.trim()}`
      : "";
    const catalog = `CATALOG — the only models and settings that exist on this canvas:\n${catalogText()}`;
    const system = editing
      ? `${NODE_EDIT_RULES}\n\nFLOW BUILDER FORMAT — use it only for the contents of "add" (ignore its top-level reply shape; your reply shape is the one above):\n${FLOW_BUILDER_RULES}\n\n${catalog}${standing}\n\nSELECTED NODES:\n${JSON.stringify(body.targets, null, 2)}`
      : `${FLOW_BUILDER_RULES}\n\n${catalog}${standing}`;

    // Kie's Claude endpoint takes the instructions as an opening exchange.
    const messages: Msg[] = [
      { role: "user", content: system },
      { role: "assistant", content: `Understood. I will reply with one JSON ${editing ? "edit" : "plan"} and nothing else.` },
      ...history,
    ];

    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, stream: true, max_tokens: 32000 }),
    });
    if (!upstream.ok) {
      const t = await upstream.text();
      return NextResponse.json({ error: `Model request failed (${upstream.status}): ${t.slice(0, 300)}` }, { status: 502 });
    }

    const reply = await readReply(upstream);

    if (editing) {
      let edit: EditPlan;
      try {
        edit = extractJson(reply) as EditPlan;
      } catch {
        return NextResponse.json({ error: "The model did not return a usable edit. Try again or rephrase.", raw: reply.slice(0, 2000) }, { status: 502 });
      }
      edit.changes ??= [];
      edit.delete ??= [];
      if (edit.add) { edit.add.nodes ??= []; edit.add.edges ??= []; }
      return NextResponse.json({ edit, validation: validateEdit(body.targets!, edit) });
    }

    let plan: FlowPlan;
    try {
      plan = extractJson(reply) as FlowPlan;
    } catch {
      return NextResponse.json({ error: "The model did not return a usable plan. Try again or rephrase.", raw: reply.slice(0, 2000) }, { status: 502 });
    }
    plan.nodes ??= [];
    plan.edges ??= [];

    const validation = validatePlan(plan);
    return NextResponse.json({ plan, validation });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[flow-builder]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
