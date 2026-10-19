// What each video model actually does with its inputs, for the model picker.
import type { VideoModel } from "./modelConfig";

type Cfg = Pick<VideoModel, "handles" | "requiredHandles" | "maxResources" | "maxReferenceVideos" | "maxReferenceAudios">;

export const HANDLE_LABEL: Record<string, string> = {
  prompt: "prompt",
  startFrame: "start frame",
  endFrame: "end frame",
  resource: "reference images",
  referenceVideo: "reference video",
  videoRef: "motion video",
  audioRef: "audio",
};

/** Short capability tags, e.g. ["Edit video ×10", "Images ×30", "Audio"]. */
export function videoCaps(m: Cfg): { label: string; title: string; strong?: boolean }[] {
  const h = m.handles as string[];
  const req = (m.requiredHandles ?? []) as string[];
  const tags: { label: string; title: string; strong?: boolean }[] = [];
  if (h.includes("referenceVideo")) {
    const n = m.maxReferenceVideos ?? 3;
    tags.push(req.includes("referenceVideo")
      ? { label: `Edit video${n > 1 ? ` ×${n}` : ""}`, title: "Edits the connected video: keeps the shot, changes what you describe", strong: true }
      : { label: `Video ref ×${n}`, title: "Uses connected videos as reference for motion, style and pacing", strong: true });
  }
  if (h.includes("videoRef")) tags.push({ label: "Motion transfer", title: "Copies the movement in the connected video onto the start-frame character", strong: true });
  if (h.includes("startFrame") && h.includes("endFrame")) tags.push({ label: "Start/End frame", title: "Accepts a first and a last frame" });
  else if (h.includes("startFrame")) tags.push({ label: "Start frame", title: "Accepts a first frame" });
  if (h.includes("resource")) tags.push({ label: `Images${m.maxResources ? ` ×${m.maxResources}` : ""}`, title: "Accepts reference images (elements)" });
  if (h.includes("audioRef")) tags.push({ label: "Audio", title: "Accepts reference audio" });
  return tags;
}

/**
 * "Seedance 2.5 Edit needs a reference video: connect a video to its reference video input
 * (left side, glowing red)." Distinguishes not connected vs connected-but-empty.
 */
export function missingInputsMessage(model: string, handles: string[], isConnected: (h: string) => boolean): string {
  const parts = handles.map((h) => {
    const label = HANDLE_LABEL[h] ?? h;
    const kind = h === "referenceVideo" || h === "videoRef" ? "a video" : h === "audioRef" ? "audio" : "an image";
    return isConnected(h)
      ? `the ${label} input is connected but its node has no ${kind === "audio" ? "audio" : kind.replace(/^an? /, "")} yet`
      : `connect ${kind} to the ${label} input`;
  });
  return `${model} needs more: ${parts.join("; ")}. The missing input glows red on the node's left side.`;
}
