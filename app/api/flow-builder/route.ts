/**
 * POST /api/flow-builder
 *
 * Turns a plain-language request into a FlowPlan (nodes + connections) using
 * Claude through the user's Kie key. Never starts any generation.
 *
 * Body: { messages: { role: "user" | "assistant"; content: string }[], rules?: string,
 *         mode?: "edit", targets?: EditTarget[] }
 * Returns { jobId } (poll GET ?job=) — the job result is { plan, validation },
 * in edit mode { edit, validation }, or { error }. Guest mode streams that JSON directly.
 *
 * The model call can run for several minutes on big workflows. Browsers and the
 * proxy drop a request that sends nothing for ~5 minutes ("upstream error"), so the
 * response starts immediately and sends a space every 10 s while the model works;
 * the JSON follows at the end (leading whitespace is valid JSON). Errors from that
 * phase are reported as { error } in the body, since the status is already sent.
 */
import { NextRequest, NextResponse } from "next/server";
import { getKieToken } from "@/lib/getKieToken";
import { FLOW_BUILDER_RULES, catalogText, extractJson, validatePlan, expandSeries, userBlocks, userBlocksText, type FlowPlan } from "@/lib/flowBuilder";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
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

interface Body { messages?: Msg[]; rules?: string; mode?: "build" | "edit"; targets?: EditTarget[] }

/** The model call plus parsing. Returns the JSON the panel receives. */
async function runBuilder(apiKey: string, body: Body): Promise<object> {
  const editing = body.mode === "edit" && Array.isArray(body.targets) && body.targets.length > 0;
  const history = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
  );

  // Labeled lines the user wrote ("V24: …") are stored as blocks so the model never retypes them.
  const stored = userBlocks(history.filter((m) => m.role === "user").map((m) => m.content));

  const standing = body.rules?.trim()
    ? `\n\nTHE USER'S STANDING RULES (apply unless the request says otherwise):\n${body.rules.trim()}`
    : "";
  const catalog = `CATALOG — the only models and settings that exist on this canvas:\n${catalogText()}`;
  const system = editing
    ? `${NODE_EDIT_RULES}\n\nFLOW BUILDER FORMAT — use it only for the contents of "add" (ignore its top-level reply shape; your reply shape is the one above; "add" may also contain "series"):\n${FLOW_BUILDER_RULES}\n\n${catalog}${standing}${userBlocksText(stored)}\n\nSELECTED NODES:\n${JSON.stringify(body.targets, null, 2)}`
    : `${FLOW_BUILDER_RULES}\n\n${catalog}${standing}${userBlocksText(stored)}`;

  // Kie's Claude endpoint takes the instructions as an opening exchange.
  const messages: Msg[] = [
    { role: "user", content: system },
    { role: "assistant", content: `Understood. I will reply with one JSON ${editing ? "edit" : "plan"} and nothing else, using "series" for repeated nodes.` },
    ...history,
  ];

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
    if (edit.add) {
      expandSeries(edit.add);
      edit.add.blocks = { ...stored, ...(edit.add.blocks ?? {}) };
    }
    return { edit, validation: validateEdit(body.targets!, edit) };
  }

  let plan: FlowPlan;
  try {
    plan = extractJson(reply) as FlowPlan;
  } catch {
    return { error: "The model did not return a usable plan. Try again or rephrase.", raw: reply.slice(0, 2000) };
  }
  expandSeries(plan);
  plan.blocks = { ...stored, ...(plan.blocks ?? {}) };
  const validation = validatePlan(plan);
  return { plan, validation };
}

async function safeRun(apiKey: string, body: Body): Promise<object> {
  try {
    return await runBuilder(apiKey, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[flow-builder]", msg);
    return { error: msg };
  }
}

/**
 * POST starts a build. Signed-in users get { jobId } at once; the build runs on the
 * server and is stored in flow_builder_jobs, so a refresh or a dropped connection
 * loses nothing — the panel polls GET ?job=<id>. Guest mode streams the result.
 */
export async function POST(req: NextRequest) {
  try {
    const apiKey = await getKieToken(req);
    if (!apiKey) return NextResponse.json({ error: "No Kie.ai API key configured. Add one in Settings." }, { status: 401 });

    const body = (await req.json()) as Body;
    const history = (body.messages ?? []).filter((m) => typeof m?.content === "string" && m.content.trim());
    if (!history.length || history[history.length - 1].role !== "user") {
      return NextResponse.json({ error: "Send a request first." }, { status: 400 });
    }

    if (GUEST_MODE) return keepAlive(() => safeRun(apiKey, body));

    const userId = await resolveUserId(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: job, error } = await supabaseAdmin.from("flow_builder_jobs")
      .insert({ user_id: userId, mode: body.mode === "edit" ? "edit" : "build" })
      .select("id").single();
    if (error || !job) return keepAlive(() => safeRun(apiKey, body)); // table unavailable: fall back to streaming

    // Runs after the response; the Node server keeps it alive until it finishes.
    void safeRun(apiKey, body).then(async (result) => {
      const failed = "error" in result;
      const { error: saveErr } = await supabaseAdmin.from("flow_builder_jobs")
        .update({ status: failed ? "error" : "done", result, finished_at: new Date().toISOString() })
        .eq("id", job.id);
      if (saveErr) console.error("[flow-builder] saving job", job.id, saveErr.message);
    }).catch((e) => console.error("[flow-builder] job", job.id, e));

    return NextResponse.json({ jobId: job.id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[flow-builder]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET ?job=<id> → { status: "running" | "done" | "error", result?, createdAt } */
export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("job");
  if (!id) return NextResponse.json({ error: "job required" }, { status: 400 });
  const { data, error } = await supabaseAdmin.from("flow_builder_jobs")
    .select("status,result,created_at").eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ status: "missing" });
  // A job still "running" after 20 minutes was lost (e.g. the server restarted during a deploy).
  if (data.status === "running" && Date.now() - new Date(data.created_at).getTime() > 20 * 60_000) {
    return NextResponse.json({ status: "error", result: { error: "The build was interrupted (the server restarted). Please send it again." } });
  }
  return NextResponse.json({ status: data.status, result: data.result, createdAt: data.created_at });
}
