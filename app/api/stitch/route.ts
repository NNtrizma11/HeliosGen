/**
 * POST /api/stitch
 * Body: { clips: string[], audioUrl?: string, clipAudio?: "keep" | "mute" }
 *
 * Joins video clips in order into one MP4 (re-encoded to a common size and
 * frame rate so mixed clips concatenate cleanly), optionally lays a voiceover
 * over the whole video, uploads the result to R2 and returns its URL.
 * Needs ffmpeg/ffprobe on the server (RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg).
 */
import { NextRequest, NextResponse } from "next/server";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { uploadBuffer } from "@/lib/r2";
import { resolveUserId } from "@/lib/guestMode";

const run = promisify(execFile);
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_CLIPS = 60;

function allowedSource(url: string): boolean {
  const r2 = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (r2 && url.startsWith(r2 + "/")) return true;
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".kie.ai") || host.endsWith(".aiquickdraw.com") || host.endsWith(".r2.dev");
  } catch {
    return false;
  }
}

async function download(url: string, path: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

async function probe(path: string): Promise<{ width: number; height: number; duration: number; hasAudio: boolean }> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", path,
  ]);
  const j = JSON.parse(stdout) as { streams?: Array<{ codec_type: string; width?: number; height?: number }>; format?: { duration?: string } };
  const v = j.streams?.find((s) => s.codec_type === "video");
  return {
    width: v?.width ?? 720,
    height: v?.height ?? 1280,
    duration: Number(j.format?.duration) || 0,
    hasAudio: !!j.streams?.some((s) => s.codec_type === "audio"),
  };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let dir = "";
  try {
    const body = (await req.json()) as { clips?: string[]; audioUrl?: string; clipAudio?: "keep" | "mute" };
    const clips = (body.clips ?? []).filter((u) => typeof u === "string" && u);
    if (clips.length < 1) return NextResponse.json({ error: "No clips to join." }, { status: 400 });
    if (clips.length > MAX_CLIPS) return NextResponse.json({ error: `Up to ${MAX_CLIPS} clips at a time.` }, { status: 400 });
    const bad = [...clips, ...(body.audioUrl ? [body.audioUrl] : [])].find((u) => !allowedSource(u));
    if (bad) return NextResponse.json({ error: `Unsupported media source: ${bad}` }, { status: 400 });
    const keepClipAudio = body.clipAudio !== "mute";

    dir = await mkdtemp(join(tmpdir(), "stitch-"));

    // 1. Download and probe
    const inputs: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const p = join(dir, `in${i}.mp4`);
      await download(clips[i], p);
      inputs.push(p);
    }
    const first = await probe(inputs[0]);
    const W = even(first.width), H = even(first.height);

    // 2. Normalise every clip to the first clip's size, 30 fps, with an audio track
    const parts: string[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const info = await probe(inputs[i]);
      const out = join(dir, `part${i}.mp4`);
      const useOwnAudio = keepClipAudio && info.hasAudio;
      await run("ffmpeg", [
        "-y", "-i", inputs[i],
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-filter_complex",
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v]`,
        "-map", "[v]", "-map", useOwnAudio ? "0:a:0" : "1:a:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "160k",
        "-shortest", out,
      ], { maxBuffer: 16 * 1024 * 1024 });
      parts.push(out);
    }

    // 3. Join
    const list = join(dir, "list.txt");
    await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
    const joined = join(dir, "joined.mp4");
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", joined]);
    const joinedInfo = await probe(joined);

    // 4. Voiceover
    let finalPath = joined;
    const warnings: string[] = [];
    if (body.audioUrl) {
      const vo = join(dir, "voice.mp3");
      await download(body.audioUrl, vo);
      const voInfo = await probe(vo);
      if (voInfo.duration > joinedInfo.duration + 0.25) {
        warnings.push(`The voiceover (${voInfo.duration.toFixed(1)}s) is longer than the video (${joinedInfo.duration.toFixed(1)}s); its end was cut.`);
      }
      finalPath = join(dir, "final.mp4");
      const filter = keepClipAudio
        ? "[0:a]volume=0.25[a0];[1:a]apad[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]"
        : "[1:a]apad[a]";
      await run("ffmpeg", [
        "-y", "-i", joined, "-i", vo,
        "-filter_complex", filter,
        "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-t", String(joinedInfo.duration),
        "-movflags", "+faststart", finalPath,
      ], { maxBuffer: 16 * 1024 * 1024 });
    }

    const buffer = await readFile(finalPath);
    const url = await uploadBuffer(buffer, "video/mp4", "stitched");
    return NextResponse.json({ url, duration: joinedInfo.duration, width: W, height: H, clips: clips.length, warnings });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[stitch]", msg);
    const missingFfmpeg = /ENOENT/.test(msg) && /ff(mpeg|probe)/.test(msg);
    return NextResponse.json(
      { error: missingFfmpeg ? "ffmpeg is not installed on the server." : `Stitching failed: ${msg.slice(0, 400)}` },
      { status: 500 },
    );
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
