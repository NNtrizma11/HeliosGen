/**
 * POST /api/flow-builder
 *
 * Turns a plain-language request into a FlowPlan (nodes + connections) using
 * Claude through the user's Kie key. Never starts any generation.
 *
 * Body: { messages: { role: "user" | "assistant"; content: string }[], rules?: string,
 *         mode?: "edit", targets?: EditTarget[] }
 * Returns: { plan, validation } — or in edit mode { edit, validation } — or { error }
 *
 * The model call can run for several minutes on big workflows. Browsers and the
 * proxy drop a request that sends nothing for ~5 minutes ("upstream error"), so the
 * response starts immediately and sends a space every 10 s while the model works;
 * the JSON follows at the end (leading whitespace is valid JSON). Errors from that
 * phase are reported as { error } in the body, since the status is already sent.
 */
import { NextRequest, NextResponse } from "next/server";
import { getKieToken } from "@/lib/getKieToken";
import { FLOW_BUILDER_RULES, catalogText, extractJson, validatePlan, type FlowPlan } from "@/lib/flowBuilder";
import { askClaude, type ClaudeMsg } from "@/lib/kieClaude";
import { NODE_EDIT_RULES, validateEdit, type EditPlan, type EditTarget } from "@/lib/nodeEdit";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

type Msg = ClaudeMsg;

/** Stream the response: headers now, a space every 10 s, then the JSON result. */
function keepAlive(work: () => Promise<object>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const beat = setInterval(() => { try { controller.enqueue(enc.encode(" ")); } catch { /* closed */ } }, 10_000);
      let result: object;
      try {
        result = await work();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[flow-builder]", msg);
        result = { error: msg };
      }
      clearInterval(beat);
      try { controller.enqueue(enc.encode(JSON.stringify(result))); controller.close(); } catch { /* client left */ }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
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

    return keepAlive(async () => {
    const { text: reply } = await askClaude(apiKey, messages, 32000);

    if (editing) {
      let edit: EditPlan;
      try {
        edit = extractJson(reply) as EditPlan;
      } catch {
        return { error: "The model did not return a usable edit. Try again or rephrase.", raw: reply.slice(0, 2000) };
      }
      edit.changes ??= [];
      edit.delete ??= [];
      if (edit.add) { edit.add.nodes ??= []; edit.add.edges ??= []; }
      return { edit, validation: validateEdit(body.targets!, edit) };
    }

    let plan: FlowPlan;
    try {
      plan = extractJson(reply) as FlowPlan;
    } catch {
      return { error: "The model did not return a usable plan. Try again or rephrase.", raw: reply.slice(0, 2000) };
    }
    plan.nodes ??= [];
    plan.edges ??= [];

    const validation = validatePlan(plan);
    return { plan, validation };
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[flow-builder]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
