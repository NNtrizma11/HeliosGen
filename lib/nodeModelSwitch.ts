"use client";
// Switching a node's model: keeps settings that the new model supports, drops the rest,
// and removes connections the new model can't use. Shared by the nodes and the settings panel.
import { useWorkflowStore } from "./store";
import { IMAGE_MODELS, VIDEO_MODELS } from "./modelConfig";

export function switchVideoModel(nodeId: string, modelId: string) {
  const st = useWorkflowStore.getState();
  const node = st.nodes.find((n) => n.id === nodeId);
  const m = VIDEO_MODELS.find((x) => x.id === modelId);
  if (!node || !m) return;
  const d = node.data;
  const cfg = VIDEO_MODELS.find((x) => x.id === ((d.videoModel as string | undefined) ?? "kling-3.0")) ?? VIDEO_MODELS[0];
  const aspectRatio = (d.aspectRatio as string | undefined) ?? cfg.defaultRatio;
  const duration = (d.duration as number | undefined) ?? cfg.defaultDuration;
  const resolution = (d.grokResolution as string | undefined) ?? cfg.defaultResolution;

  const validRatio = m.ratios.includes(aspectRatio) ? aspectRatio : m.defaultRatio;
  const validDur = m.durations.includes(duration) ? duration : m.defaultDuration;
  const validRes = m.resolutions
    ? (resolution && m.resolutions.includes(resolution) ? resolution : (m.defaultResolution ?? m.resolutions[0]))
    : undefined;
  st.updateNodeData(nodeId, {
    videoModel: m.id, aspectRatio: validRatio, duration: validDur,
    ...(validRes !== undefined && { grokResolution: validRes }),
    ...(m.modes?.length && !m.modes.some((x) => x.value === d.klingMode) ? { klingMode: m.defaultMode ?? m.modes[0].value } : {}),
  });

  const removed = (cfg.handles as string[]).filter((h) => !(m.handles as string[]).includes(h));
  if (cfg.apiInput.useMotionControl !== m.apiInput.useMotionControl && !removed.includes("startFrame")) removed.push("startFrame");
  const oldVideoRef = (cfg.handles as string[]).includes("videoRef");
  const newVideoRef = (m.handles as string[]).includes("videoRef");
  const oldRefVideo = (cfg.handles as string[]).includes("referenceVideo");
  const newRefVideo = (m.handles as string[]).includes("referenceVideo");
  if (oldVideoRef && !newVideoRef && newRefVideo) {
    st.remapTargetHandle(nodeId, "videoRef", "referenceVideo");
    removed.splice(removed.indexOf("videoRef"), 1);
  } else if (oldRefVideo && !newRefVideo && newVideoRef) {
    st.remapTargetHandle(nodeId, "referenceVideo", "videoRef");
    removed.splice(removed.indexOf("referenceVideo"), 1);
  }
  if (removed.length) st.killEdgesForHandles(nodeId, removed);
}

export function imageQualityOptions(m: (typeof IMAGE_MODELS)[number]): string[] {
  return m.supportsQuality ? ((m.apiInput.qualityOptions as string[] | undefined) ?? ["1k", "2k", "4k"]) : [];
}

export function switchImageModel(nodeId: string, modelId: string) {
  const st = useWorkflowStore.getState();
  const node = st.nodes.find((n) => n.id === nodeId);
  const m = IMAGE_MODELS.find((x) => x.id === modelId);
  if (!node || !m) return;
  const aspectRatio = (node.data.aspectRatio as string | undefined) ?? "9:16";
  const quality = node.data.quality as string | undefined;
  const q = imageQualityOptions(m);
  st.updateNodeData(nodeId, {
    model: m.id,
    aspectRatio: m.ratios.includes(aspectRatio) ? aspectRatio : "1:1",
    quality: q.length && !(quality && q.includes(quality)) ? q[0] : quality,
  });
  if (!m.supportsImages) st.removeEdgesForHandle(nodeId, "image");
}

/** Ask a node to run its own Generate (same as clicking its button). */
export function requestGenerate(nodeId: string) {
  window.dispatchEvent(new CustomEvent("helios:generate", { detail: { id: nodeId } }));
}
