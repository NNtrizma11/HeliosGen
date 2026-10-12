import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getKieTokenForUser } from "@/lib/getKieToken";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import {
  VOICE_MODELS,
  DEFAULT_VOICE_MODEL,
  VOICES,
  DEFAULT_VOICE,
  clampSetting,
} from "@/lib/voiceConfig";
import { audioCostSpec } from "@/lib/pricing";

const CREATE = "https://api.kie.ai/api/v1/jobs/createTask";

/**
 * Text-to-speech through Kie's ElevenLabs endpoints.
 * Same async pattern as images and videos: create the task, return its taskId,
 * and let /api/callback store the finished audio in R2.
 */
export async function POST(req: NextRequest) {
  try {
    if (GUEST_MODE) {
      return NextResponse.json({ error: "Voice generation needs the hosted (cloud) mode." }, { status: 400 });
    }

    const body = await req.json();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const modelId: string = body.model || DEFAULT_VOICE_MODEL;
    const voice: string = body.voice || DEFAULT_VOICE;

    const cfg = VOICE_MODELS.find((m) => m.id === modelId);
    if (!cfg) return NextResponse.json({ error: `Unknown voice model: ${modelId}` }, { status: 400 });
    if (!VOICES.some((v) => v.id === voice)) {
      return NextResponse.json({ error: `Unknown voice: ${voice}` }, { status: 400 });
    }
    if (!text) return NextResponse.json({ error: "Text is required to generate a voiceover." }, { status: 400 });
    if (text.length > cfg.maxChars) {
      return NextResponse.json(
        { error: `Text is ${text.length} characters; ${cfg.name} accepts up to ${cfg.maxChars}.` },
        { status: 400 },
      );
    }

    const userId = await resolveUserId(req);
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const apiKey = (await getKieTokenForUser(userId)) ?? process.env.KIE_API_TOKEN ?? null;
    if (!apiKey) return NextResponse.json({ error: "No Kie.ai API key configured. Add one in Settings." }, { status: 401 });

    const callbackBase = process.env.CALLBACK_BASE_URL;
    if (!callbackBase) return NextResponse.json({ error: "CALLBACK_BASE_URL is not set" }, { status: 500 });
    const callBackUrl = `${callbackBase.replace(/\/$/, "")}/api/callback`;

    const input = {
      text,
      voice,
      speed:            clampSetting("speed", body.speed),
      stability:        clampSetting("stability", body.stability),
      similarity_boost: clampSetting("similarity_boost", body.similarityBoost),
      style:            clampSetting("style", body.style),
      timestamps:       false,
    };

    const res = await fetch(CREATE, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.apiId, callBackUrl, input }),
    });

    if (res.status === 401) {
      return NextResponse.json({ error: "Invalid Kie.ai API key — please update it in Settings." }, { status: 401 });
    }
    const raw = await res.text();
    let created: { code?: number; msg?: string; data?: { taskId?: string } };
    try {
      created = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: `Upstream returned non-JSON: ${raw.slice(0, 200)}` }, { status: 500 });
    }
    if (created.code !== 200) {
      console.error("[generate-audio] kie.ai error:", created.code, created.msg);
      return NextResponse.json({ error: created.msg ?? "Task creation failed" }, { status: 500 });
    }

    const taskId = created.data?.taskId;
    if (!taskId) return NextResponse.json({ error: "No taskId returned" }, { status: 500 });

    jobStore.set(taskId, { status: "pending", type: "audio", userId });

    // Needs supabase-audio.sql (adds the "audio" type and audio_url column).
    const { error } = await supabaseAdmin.from("generations").insert({
      task_id:         taskId,
      user_id:         userId,
      generation_type: "audio",
      status:          "pending",
      model:           modelId,
      prompt:          text,
      cost_key:        audioCostSpec(modelId, text.length).key,
      cost_units:      audioCostSpec(modelId, text.length).units,
    });
    if (error) console.error("[generate-audio] supabase insert error:", error.message);

    return NextResponse.json({ taskId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[generate-audio] unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
