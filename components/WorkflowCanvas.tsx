"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  BackgroundVariant,
  Panel,
  Node,
  NodeChange,
  Connection,
  Edge,
  Viewport,
  OnNodeDrag,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useWorkflowStore, NodeData } from "@/lib/store";
import { requestWorkflowSync } from "@/lib/workflowSyncBus";
import { VIDEO_MODELS } from "@/lib/modelConfig";
import CuttableEdge from "@/components/edges/CuttableEdge";
import { topoSort, resolveInputs } from "@/lib/executor";
import { NODES, NODE_META, NODE_SIZE, FALLBACK_SIZE, getLastNodeSettings, getDefaultNodeSize } from "@/lib/nodeTypes";
import { edgeStyle } from "@/lib/edgeStyles";
import { createClient } from "@/lib/supabase/client";
import { sha256Hex } from "@/lib/assetHash";

import { motion } from "motion/react";
import TypewriterHeading from "@/components/ui/TypewriterHeading";
import PromptNode from "./nodes/PromptNode";
import ImageInputNode from "./nodes/ImageInputNode";
import VideoInputNode from "./nodes/VideoInputNode";
import GenerateNode from "./nodes/GenerateNode";
import VideoGeneratorNode from "./nodes/VideoGeneratorNode";
import AssistantNode from "./nodes/AssistantNode";
import VoiceNode from "@/components/nodes/VoiceNode";
import FlowBuilderPanel from "@/components/FlowBuilderPanel";
import AssetPickerPanel from "@/components/AssetPickerPanel";
import NodeInspector from "@/components/NodeInspector";
import BatchRunPanel from "@/components/BatchRunPanel";
import GroupNode from "./nodes/GroupNode";
import NodePickerMenu, { DropState } from "./NodePickerMenu";
import SelectionToolbar from "./SelectionToolbar";
import CanvasToolbar from "./CanvasToolbar";
import AddNodeMenu from "./AddNodeMenu";
import CanvasContextMenu, { type MenuEntry, mod } from "./CanvasContextMenu";
import ShareModal from "./ShareModal";
import { MessageSquare, Sparkles, Clapperboard } from "lucide-react";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

async function getAccessToken(): Promise<string | undefined> {
  if (process.env.NEXT_PUBLIC_GUEST_MODE === "true") return "guest";
  try {
    const { data } = await createClient().auth.getSession();
    return data.session?.access_token;
  } catch {
    return undefined;
  }
}

function authHeaders(token: string | undefined): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const nodeTypes = {
  promptNode: PromptNode,
  imageInputNode: ImageInputNode,
  videoInputNode: VideoInputNode,
  generateNode: GenerateNode,
  videoGeneratorNode: VideoGeneratorNode,
  assistantNode: AssistantNode,
  voiceNode: VoiceNode,
  groupNode: GroupNode,
};

const edgeTypes = {
  default: CuttableEdge,
};

// ── Connection types ─────────────────────────────────────────────────────────
// Outputs sit on the right of a node, inputs on the left. A wire is only allowed
// from an output into an input that takes the same kind of media.
type MediaType = "text" | "image" | "video" | "audio";

/** What a node's output handle produces. Undefined = the node has no outputs. */
function outputTypeOf(nodeType: string | undefined, sourceHandle: string | null | undefined): MediaType | undefined {
  switch (nodeType) {
    case "promptNode":
    case "assistantNode":
      return "text";
    case "imageInputNode":
    case "generateNode":
      return "image";
    case "voiceNode":
      return "audio";
    case "videoInputNode":
    case "videoGeneratorNode":
      if (sourceHandle === "startFrameOut" || sourceHandle === "endFrameOut" || sourceHandle === "imagePickOut") return "image";
      if (sourceHandle === "audioRefOut") return "audio";
      return "video";
    default:
      return undefined;
  }
}

/** What each input handle accepts. Handles not listed here accept nothing. */
const INPUT_ACCEPTS: Record<string, MediaType[]> = {
  prompt: ["text"],
  image: ["image"],
  startFrame: ["image"],
  endFrame: ["image"],
  resource: ["image"],
  videoRef: ["video"],
  referenceVideo: ["video"],
  audioRef: ["audio"],
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const isMacPlatform = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const SNAP_THRESHOLD = 8; // canvas units

interface SnapGuide { type: "h" | "v"; canvasPos: number }

// Runs inside the ReactFlow provider so it can call useReactFlow()
function ViewportSyncer() {
  const { setViewport } = useReactFlow();
  const activeSpaceId = useWorkflowStore((s) => s.activeSpaceId);
  const spaces = useWorkflowStore((s) => s.spaces);

  useEffect(() => {
    const space = spaces.find((sp) => sp.id === activeSpaceId);
    if (space?.viewport) {
      setViewport(space.viewport, { duration: 0 });
    } else {
      // No saved viewport — let ReactFlow keep its current state (fitView handled elsewhere)
      setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
    }
    // Only run when the active space changes, not on every spaces update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpaceId]);

  return null;
}

/** Hands the React Flow instance to WorkflowCanvas (which renders <ReactFlow> itself). */
function FlowInstanceBridge({ instanceRef }: { instanceRef: React.MutableRefObject<ReturnType<typeof useReactFlow> | null> }) {
  const rf = useReactFlow();
  useEffect(() => { instanceRef.current = rf; }, [rf, instanceRef]);
  return null;
}

/** Nodes that don't draw their own lock overlay get a small badge from CSS. */
const DRAWS_OWN_LOCK = new Set(["generateNode", "videoGeneratorNode", "voiceNode", "groupNode"]);
function lockBadgeClass(n: Node<NodeData>): string | null {
  return n.data?.locked && !DRAWS_OWN_LOCK.has(n.type ?? "") ? "node-locked-badge" : null;
}

/** First media URL a node holds (shown output or uploaded input), for "Copy link". */
function nodeMediaUrl(n: Node<NodeData> | undefined): string | undefined {
  if (!n) return undefined;
  const d = n.data as Record<string, unknown>;
  for (const k of ["videoUrl", "imageUrl", "audioUrl", "r2Url", "inputVideo", "inputImage"]) {
    const v = d[k];
    if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
  }
  return undefined;
}

/** Dashed group-preview outline shown when selecting a non-grouped node.
 *  Must be rendered inside <ReactFlow> to access useViewport / useReactFlow. */
function GroupPreviewOverlay({ groupIds }: { groupIds: Set<string> | null }) {
  const { getNodes } = useReactFlow();
  const { x: vpX, y: vpY, zoom } = useViewport();

  if (!groupIds || groupIds.size === 0) return null;

  const allNodes = getNodes();
  const relevant = allNodes.filter((n) => groupIds.has(n.id));
  if (relevant.length === 0) return null;

  const PAD = 28;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of relevant) {
    const w = (n.measured?.width  ?? NODE_SIZE[n.type ?? ""]?.w ?? FALLBACK_SIZE.w);
    const h = (n.measured?.height ?? NODE_SIZE[n.type ?? ""]?.h ?? FALLBACK_SIZE.h);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }

  const sx = (minX - PAD) * zoom + vpX;
  const sy = (minY - PAD) * zoom + vpY;
  const sw = (maxX - minX + PAD * 2) * zoom;
  const sh = (maxY - minY + PAD * 2) * zoom;

  return (
    <div
      style={{
        position: "absolute",
        left: sx,
        top: sy,
        width: sw,
        height: sh,
        border: "2px dashed rgba(150, 150, 150, 0.45)",
        borderRadius: Math.max(10, 14 * zoom),
        background: "transparent",
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}

/** Human-readable label with auto-incrementing counter per type */
function nodeLabel(type: string, existingNodes: Node<NodeData>[]): string {
  const count = existingNodes.filter((n) => n.type === type).length + 1;
  const names: Record<string, string> = {
    videoInputNode: "VIDEO",
    imageInputNode: "IMAGE",
    promptNode: "TEXT",
    generateNode: "IMAGE GEN",
    videoGeneratorNode: "VIDEO GEN",
    assistantNode: "ASSISTANT",
    voiceNode: "VOICE",
  };
  if (type === "assistantNode") return "ASSISTANT";
  return `${names[type] ?? type} #${count}`;
}

/** True if `node` has a free "prompt" input handle that a pasted text node can connect into. */
function nodeAcceptsPromptInput(node: Node<NodeData>, edges: Edge[]): boolean {
  const taken = edges.some((e) => e.target === node.id && e.targetHandle === "prompt");
  if (taken) return false;

  if (node.type === "generateNode") return true;

  if (node.type === "videoGeneratorNode") {
    const videoModelId = (node.data?.videoModel as string | undefined) ?? "kling-3.0";
    const videoCfg = VIDEO_MODELS.find((m) => m.id === videoModelId);
    return videoCfg?.handles.includes("prompt" as never) ?? false;
  }

  return false;
}

export default function WorkflowCanvas() {
  const {
    nodes, edges,
    onNodesChange: _onNodesChange, onEdgesChange, onConnect,
    addNode, insertEdge,
    updateNodeData, isRunning, setIsRunning, debugMode, toggleDebug,
    setConnectingHandleType,
    saveViewport: _saveViewport,
    pushUndoSnapshot, undo, redo,
    undoStack, redoStack,
  } = useWorkflowStore();

  // Debounce viewport saves so zoom/pan doesn't trigger a Zustand update every frame
  const saveViewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveViewport = useCallback((vp: { x: number; y: number; zoom: number }) => {
    if (saveViewportTimerRef.current) clearTimeout(saveViewportTimerRef.current);
    saveViewportTimerRef.current = setTimeout(() => _saveViewport(vp), 300);
  }, [_saveViewport]);
  const updateNodeDataRef = useRef(updateNodeData);
  updateNodeDataRef.current = updateNodeData;
  const [activeTool, setActiveTool] = useState<"select" | "hand">("select");

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  const [dyingEdgeIds, setDyingEdgeIds] = useState<Set<string>>(new Set());
  const [dyingNodeIds, setDyingNodeIds] = useState<Set<string>>(new Set());
  const [ancestorIds, setAncestorIds] = useState<Set<string>>(new Set());
  const [ancestorEdgeIds, setAncestorEdgeIds] = useState<Set<string>>(new Set());
  const [potentialGroupIds, setPotentialGroupIds] = useState<Set<string> | null>(null);
  // Ref so the nodes map always reads the latest selected IDs in the same render
  const selectedIdsRef = useRef<Set<string>>(new Set());
  // True while the rubber-band drag is in progress — skip BFS and dimming to prevent blinking
  const isRubberBandSelectingRef = useRef(false);
  // Edge IDs that will be removed by our delayed node-delete handler — suppress RF's auto-remove
  const suppressedEdgeRemovesRef = useRef<Set<string>>(new Set());

  const handleUndo = useCallback(() => {
    undo();
    setDyingNodeIds(new Set());
    setDyingEdgeIds(new Set());
    suppressedEdgeRemovesRef.current = new Set();
  }, [undo]);

  const handleRedo = useCallback(() => {
    redo();
    setDyingNodeIds(new Set());
    setDyingEdgeIds(new Set());
    suppressedEdgeRemovesRef.current = new Set();
  }, [redo]);

  // BFS helper: compute ancestor nodes/edges for the current selectedIdsRef and update state
  const runAncestorBFS = useCallback(() => {
    const selectedIds = selectedIdsRef.current;
    if (selectedIds.size === 0) {
      setAncestorIds(new Set());
      setAncestorEdgeIds(new Set());
      return;
    }
    const visitedNodes = new Set<string>();
    const visitedEdges = new Set<string>();
    const queue = [...selectedIds];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const edge of edges) {
        if (edge.target !== id) continue;
        visitedEdges.add(edge.id);
        if (!selectedIds.has(edge.source) && !visitedNodes.has(edge.source)) {
          visitedNodes.add(edge.source);
          queue.push(edge.source);
        }
      }
    }
    setAncestorIds(visitedNodes);
    setAncestorEdgeIds(visitedEdges);
  }, [edges]);

  // Walk edges upstream from selected nodes, collecting all ancestor node + edge IDs
  const onSelectionChange = useCallback(
    ({ nodes: selected }: { nodes: Node[] }) => {
      // Update ref synchronously — visible to the render triggered by setAncestorIds below
      selectedIdsRef.current = new Set(selected.map((n) => n.id));

      // During rubber-band drag: skip BFS and state updates to prevent per-frame re-renders
      // and blinking. Ancestor highlighting is applied once when the drag ends.
      if (isRubberBandSelectingRef.current) return;

      // When a group node is selected, also select all its members
      const selectedGroups = selected.filter((n) => n.type === "groupNode");
      if (selectedGroups.length > 0) {
        const toSelect: string[] = [];
        for (const g of selectedGroups) {
          const memberIds = g.data?.memberIds as string[] | undefined;
          memberIds?.forEach((mid) => { if (!selectedIdsRef.current.has(mid)) toSelect.push(mid); });
        }
        if (toSelect.length > 0) {
          _onNodesChange(toSelect.map((id) => ({ type: "select" as const, id, selected: true })));
        }
      }

      if (selected.length === 0) {
        setAncestorIds(new Set());
        setAncestorEdgeIds(new Set());
        return;
      }
      runAncestorBFS();
    },
    [edges, runAncestorBFS],
  );

  const handleEdgesChange = useCallback((changes: Parameters<typeof onEdgesChange>[0]) => {
    const filtered = changes.filter(
      (c) => c.type !== "remove" || !suppressedEdgeRemovesRef.current.has(c.id)
    );

    // Clear capturedFrameUrl from source nodes when their frame-bearing edge is removed
    for (const c of filtered) {
      if (c.type !== "remove") continue;
      const edge = edges.find((e) => e.id === c.id);
      if (!edge) continue;
      const isFrameEdge =
        (edge.targetHandle === "image" && nodes.find((n) => n.id === edge.target)?.type === "generateNode") ||
        (edge.targetHandle === "startFrame" && nodes.find((n) => n.id === edge.target)?.type === "videoGeneratorNode") ||
        (edge.targetHandle === "endFrame" && nodes.find((n) => n.id === edge.target)?.type === "videoGeneratorNode") ||
        edge.sourceHandle === "imagePickOut";
      if (!isFrameEdge) continue;
      const srcNode = nodes.find((n) => n.id === edge.source);
      if (srcNode?.type !== "videoInputNode" && srcNode?.type !== "videoGeneratorNode") continue;
      // Only clear if no other frame-bearing edges from this source remain
      const remaining = edges.filter((e) =>
        e.id !== edge.id &&
        e.source === edge.source &&
        (e.targetHandle === "image" || e.targetHandle === "startFrame" || e.targetHandle === "endFrame" || e.sourceHandle === "imagePickOut")
      );
      if (remaining.length === 0) {
        updateNodeData(edge.source, { capturedFrameUrl: undefined });
      }
    }

    if (filtered.length > 0) onEdgesChange(filtered);
  }, [onEdgesChange, edges, nodes, updateNodeData]);

  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    pushUndoSnapshot();
    setDyingEdgeIds((prev) => new Set([...prev, edge.id]));
    setTimeout(() => {
      handleEdgesChange([{ type: "remove", id: edge.id }]);
      setDyingEdgeIds((prev) => { const s = new Set(prev); s.delete(edge.id); return s; });
    }, 450);
  }, [handleEdgesChange, pushUndoSnapshot]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // ── Node deletion animation ──────────────────────────────────────────────────
    const removeChanges = changes.filter((c) => c.type === "remove");
    if (removeChanges.length > 0) {
      pushUndoSnapshot();
      const removingIds = new Set(removeChanges.map((c) => c.id));
      const connectedEdgeIds = edges
        .filter((e) => removingIds.has(e.source) || removingIds.has(e.target))
        .map((e) => e.id);

      // Suppress RF's auto-fired edge removes so we control the timing
      connectedEdgeIds.forEach((id) => suppressedEdgeRemovesRef.current.add(id));

      setDyingNodeIds((prev) => new Set([...prev, ...removingIds]));
      setDyingEdgeIds((prev) => new Set([...prev, ...connectedEdgeIds]));

      setTimeout(() => {
        _onNodesChange(removeChanges);
        onEdgesChange(connectedEdgeIds.map((id) => ({ type: "remove" as const, id })));
        connectedEdgeIds.forEach((id) => suppressedEdgeRemovesRef.current.delete(id));
        setDyingNodeIds((prev) => { const s = new Set(prev); removingIds.forEach((id) => s.delete(id)); return s; });
        setDyingEdgeIds((prev) => { const s = new Set(prev); connectedEdgeIds.forEach((id) => s.delete(id)); return s; });
      }, 300);
    }

    // Only pass non-remove changes through the snap logic
    const nonRemoveChanges = changes.filter((c) => c.type !== "remove");
    if (nonRemoveChanges.length === 0) return;

    // ── Alignment snap (edge-to-edge + center magnetic effect) ─────────────────
    const newGuides: SnapGuide[] = [];

    const snappedChanges = nonRemoveChanges.map((change) => {
      if (change.type !== "position" || !change.position) return change;

      // On drag-stop: lock in the last snapped position
      if (!change.dragging) {
        const t = snapTargetRef.current;
        if (t && t.id === change.id) return { ...change, position: { x: t.x, y: t.y } };
        return change;
      }

      const dragged = nodes.find((n) => n.id === change.id);
      if (!dragged) return change;

      const dw = dragged.measured?.width ?? (NODE_SIZE[dragged.type ?? ""] ?? FALLBACK_SIZE).w;
      const dh = dragged.measured?.height ?? (NODE_SIZE[dragged.type ?? ""] ?? FALLBACK_SIZE).h;
      const { x, y } = change.position;

      let snapX: number | null = null, guideX: number | null = null, minDX = SNAP_THRESHOLD;
      let snapY: number | null = null, guideY: number | null = null, minDY = SNAP_THRESHOLD;

      for (const other of nodes) {
        if (other.id === change.id) continue;
        const ow = other.measured?.width ?? (NODE_SIZE[other.type ?? ""] ?? FALLBACK_SIZE).w;
        const oh = other.measured?.height ?? (NODE_SIZE[other.type ?? ""] ?? FALLBACK_SIZE).h;

        // Check left / right borders of dragged vs left / right borders of other
        for (const [dx, offsetX] of [[x, 0], [x + dw, dw]] as [number, number][]) {
          for (const ox of [other.position.x, other.position.x + ow]) {
            const dist = Math.abs(dx - ox);
            if (dist < minDX) { minDX = dist; snapX = ox - offsetX; guideX = ox; }
          }
        }

        // Check top / bottom borders of dragged vs top / bottom borders of other
        for (const [dy, offsetY] of [[y, 0], [y + dh, dh]] as [number, number][]) {
          for (const oy of [other.position.y, other.position.y + oh]) {
            const dist = Math.abs(dy - oy);
            if (dist < minDY) { minDY = dist; snapY = oy - offsetY; guideY = oy; }
          }
        }
      }

      if (guideX !== null) newGuides.push({ type: "v", canvasPos: guideX });
      if (guideY !== null) newGuides.push({ type: "h", canvasPos: guideY });

      const snappedX = snapX ?? x;
      const snappedY = snapY ?? y;
      snapTargetRef.current = (guideX !== null || guideY !== null)
        ? { id: change.id, x: snappedX, y: snappedY }
        : null;

      return { ...change, position: { x: snappedX, y: snappedY } };
    });

    // ── Alignment guides during resize ────────────────────────────────────────
    let hasEndedResize = false;
    for (const change of nonRemoveChanges) {
      if (change.type !== "dimensions" || !change.dimensions) continue;
      if (!change.resizing) { hasEndedResize = true; continue; }

      const resized = nodes.find((n) => n.id === change.id);
      if (!resized) continue;

      const { x, y } = resized.position;
      const dw = change.dimensions.width;
      const dh = change.dimensions.height;

      for (const other of nodes) {
        if (other.id === change.id) continue;
        const ow = other.measured?.width ?? (NODE_SIZE[other.type ?? ""] ?? FALLBACK_SIZE).w;
        const oh = other.measured?.height ?? (NODE_SIZE[other.type ?? ""] ?? FALLBACK_SIZE).h;

        for (const dx of [x, x + dw]) {
          for (const ox of [other.position.x, other.position.x + ow]) {
            if (Math.abs(dx - ox) < SNAP_THRESHOLD) newGuides.push({ type: "v", canvasPos: ox });
          }
        }

        for (const dy of [y, y + dh]) {
          for (const oy of [other.position.y, other.position.y + oh]) {
            if (Math.abs(dy - oy) < SNAP_THRESHOLD) newGuides.push({ type: "h", canvasPos: oy });
          }
        }
      }
    }
    if (hasEndedResize && newGuides.length === 0) setSnapGuides([]);

    // When a group node moves, also move its members by the same delta
    const extraMemberChanges: NodeChange[] = [];
    for (const change of snappedChanges) {
      if (change.type !== "position" || !change.position) continue;
      const node = nodes.find((n) => n.id === change.id);
      if (node?.type !== "groupNode") continue;
      const memberIds = node.data?.memberIds as string[] | undefined;
      if (!memberIds?.length) continue;
      const dx = change.position.x - node.position.x;
      const dy = change.position.y - node.position.y;
      for (const memberId of memberIds) {
        const member = nodes.find((n) => n.id === memberId);
        if (!member) continue;
        extraMemberChanges.push({
          type: "position" as const,
          id: memberId,
          position: { x: member.position.x + dx, y: member.position.y + dy },
          dragging: change.dragging,
        });
      }
    }

    setSnapGuides(newGuides);
    _onNodesChange(extraMemberChanges.length > 0 ? [...snappedChanges, ...extraMemberChanges] : snappedChanges);
  }, [nodes, edges, _onNodesChange, pushUndoSnapshot]);

  // ── Sidebar drag-and-drop ────────────────────────────────────────────────────
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 });

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const hasFiles = e.dataTransfer.types.includes("Files");
    e.dataTransfer.dropEffect = hasFiles ? "copy" : "copy";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();

    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { x: panX, y: panY, zoom } = viewportRef.current;

    // ── File drop (images / videos dragged from OS or browser) ─────────────
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith("image/") || f.type.startsWith("video/")
    );
    if (files.length > 0) {
      if (DEMO_MODE) { useWorkflowStore.getState().setAuthModalOpen(true); return; }
      const dropX = (e.clientX - rect.left - panX) / zoom;
      const dropY = (e.clientY - rect.top - panY) / zoom;

      // Lay out multiple files in a row, centred on the drop point.
      // Gap between node edges (canvas units).
      const GAP = 24;

      // First pass: compute per-file node type + size so we can centre the row.
      const lastNodeSize = useWorkflowStore.getState().lastNodeSize;
      const fileMeta = files.map((f) => {
        const type = f.type.startsWith("image/") ? "imageInputNode" : "videoInputNode";
        const size = getDefaultNodeSize(type, lastNodeSize);
        return { file: f, type, size } as { file: File; type: string; size: { w: number; h: number } };
      });

      const totalWidth = fileMeta.reduce((sum, m, i) =>
        sum + m.size.w + (i < fileMeta.length - 1 ? GAP : 0), 0
      );
      let cursorX = dropX - totalWidth / 2;

      for (const { file, type, size } of fileMeta) {
        const nodeId = `${type}-${uid()}`;
        const current = useWorkflowStore.getState().nodes;
        const blobUrl = URL.createObjectURL(file);
        const posX = cursorX;
        const posY = dropY - size.h / 2;
        cursorX += size.w + GAP;

        if (type === "imageInputNode") {
          // Add node immediately with blob URL so the image shows at once
          addNode({
            id: nodeId, type,
            position: { x: posX, y: posY },
            style: { width: size.w },
            data: { label: nodeLabel(type, current), status: "idle", inputImage: blobUrl },
          });

          // Measure natural dimensions
          const img = new window.Image();
          img.onload = () =>
            updateNodeDataRef.current(nodeId, {
              imageNaturalRatio: `${img.naturalWidth} / ${img.naturalHeight}`,
            });
          img.src = blobUrl;

          // Hash + lookup + upload in background
          (async () => {
            try {
              const bytes = await file.arrayBuffer();
              const hash = await sha256Hex(bytes);
              const { data: authData } = await (await import("@/lib/supabase/client")).createClient().auth.getSession();
              const token = authData.session?.access_token;
              const authHdr: Record<string, string> = {};
              if (token) authHdr["Authorization"] = `Bearer ${token}`;

              try {
                const lk = await fetch(`/api/lookup-asset?hash=${hash}`, { headers: authHdr });
                const { cdnUrl } = await lk.json() as { cdnUrl: string | null };
                if (cdnUrl) { updateNodeDataRef.current(nodeId, { inputImage: cdnUrl, r2Url: cdnUrl }); return; }
              } catch { /* fall through */ }

              const res = await fetch("/api/upload-asset", {
                method: "POST",
                headers: { "Content-Type": file.type || "image/jpeg", ...authHdr },
                body: bytes,
              });
              const { cdnUrl } = await res.json() as { cdnUrl?: string };
              if (cdnUrl) updateNodeDataRef.current(nodeId, { inputImage: cdnUrl, r2Url: cdnUrl });
            } catch { /* blob URL stays as fallback */ }
          })();

        } else {
          // videoInputNode
          addNode({
            id: nodeId, type,
            position: { x: posX, y: posY },
            style: { width: size.w },
            data: { label: nodeLabel(type, current), status: "idle", videoUrl: blobUrl },
          });

          (async () => {
            try {
              const bytes = await file.arrayBuffer();
              const hash = await sha256Hex(bytes);
              const { data: authData } = await (await import("@/lib/supabase/client")).createClient().auth.getSession();
              const token = authData.session?.access_token;
              const authHdr: Record<string, string> = {};
              if (token) authHdr["Authorization"] = `Bearer ${token}`;

              try {
                const lk = await fetch(`/api/lookup-asset?hash=${hash}`, { headers: authHdr });
                const { cdnUrl } = await lk.json() as { cdnUrl: string | null };
                if (cdnUrl) { updateNodeDataRef.current(nodeId, { videoUrl: cdnUrl }); return; }
              } catch { /* fall through */ }

              const res = await fetch("/api/upload-asset", {
                method: "POST",
                headers: { "Content-Type": file.type || "video/mp4", ...authHdr },
                body: bytes,
              });
              const { cdnUrl } = await (await res.json()) as { cdnUrl?: string };
              if (cdnUrl) updateNodeDataRef.current(nodeId, { videoUrl: cdnUrl });
            } catch { /* blob URL stays as fallback */ }
          })();
        }
      }
      return;
    }

    // ── Sidebar node-type drop ───────────────────────────────────────────────
    const type = e.dataTransfer.getData("application/reactflow-node");
    if (!type) return;

    const position = {
      x: (e.clientX - rect.left - panX) / zoom,
      y: (e.clientY - rect.top - panY) / zoom,
    };


    const size = getDefaultNodeSize(type, useWorkflowStore.getState().lastNodeSize);
    // Read nodes fresh from the store (not from stale closure)
    const currentNodes = useWorkflowStore.getState().nodes;
    const label = nodeLabel(type, currentNodes);
    addNode({
      id: `${type}-${uid()}`,
      type,
      position,
      style: type === "imageInputNode" || type === "videoInputNode" ? { width: size.w } : { width: size.w, height: size.h },
      data: { label, status: "idle" },
    });
  }, [addNode, insertEdge]);

  // ── Copy / Paste ─────────────────────────────────────────────────────────────
  const clipboardRef = useRef<{ nodes: Node<NodeData>[]; edges: Edge[] } | null>(null);
  // Written to the OS clipboard when nodes are copied, so Ctrl+V can tell the
  // difference between "paste my nodes" and "paste real external text".
  const nodeSentinelRef = useRef<string | null>(null);
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const handleCopy = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return;
    const selectedIds = new Set(selected.map((n) => n.id));

    // Always include group member nodes even if auto-selection hasn't processed yet
    for (const n of selected) {
      if (n.type === "groupNode") {
        ((n.data?.memberIds as string[] | undefined) ?? []).forEach((mid) => selectedIds.add(mid));
      }
    }

    const allNodes = nodes.filter((n) => selectedIds.has(n.id));
    const selectedEdges = edges.filter(
      (e) => selectedIds.has(e.source) && selectedIds.has(e.target)
    );
    clipboardRef.current = { nodes: allNodes, edges: selectedEdges };
    // Write a sentinel to the OS clipboard so Ctrl+V knows this was a node copy,
    // not real external text the user wants to paste as a prompt node.
    const sentinel = `__rf_nodes_${Date.now()}__`;
    nodeSentinelRef.current = sentinel;
    navigator.clipboard.writeText(sentinel).catch(() => { });
  }, [nodes, edges]);

  const handlePaste = useCallback(() => {
    if (!clipboardRef.current) return;
    const { nodes: copied, edges: copiedEdges } = clipboardRef.current;

    // Convert current mouse screen position → canvas position
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { x: panX, y: panY, zoom } = viewportRef.current;
    const cursorCanvas = {
      x: (mousePosRef.current.x - rect.left - panX) / zoom,
      y: (mousePosRef.current.y - rect.top - panY) / zoom,
    };

    // Find the bounding-box center of the copied group
    const xs = copied.map((n) => n.position.x);
    const ys = copied.map((n) => n.position.y);
    const groupCenter = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };

    const idMap = new Map<string, string>();
    for (const n of copied) {
      idMap.set(n.id, `${n.type}-${uid()}`);
    }

    for (const n of copied) {
      const newId = idMap.get(n.id)!;
      const data: NodeData = { ...n.data, status: n.data.status === "running" ? "idle" : n.data.status };
      if (n.type === "groupNode") {
        data.memberIds = ((n.data.memberIds as string[] | undefined) ?? []).map(
          (mid) => idMap.get(mid) ?? mid
        );
      }
      addNode({
        ...n,
        id: newId,
        selected: false,
        position: {
          x: cursorCanvas.x + (n.position.x - groupCenter.x),
          y: cursorCanvas.y + (n.position.y - groupCenter.y),
        },
        data,
      });
    }

    for (const e of copiedEdges) {
      const src = idMap.get(e.source);
      const tgt = idMap.get(e.target);
      if (!src || !tgt) continue;
      insertEdge({ ...e, id: `edge-${uid()}`, source: src, target: tgt });
    }
  }, [addNode, insertEdge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in an input / textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "v" || e.key === "V") setActiveTool("select");
        if (e.key === "h" || e.key === "H") setActiveTool("hand");
      }

      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) handleRedo(); else handleUndo();
      }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); handleRedo(); }
      if (mod && e.key === "c") { e.preventDefault(); handleCopy(); }
      if (mod && e.key === "v") {
        e.preventDefault();
        // OS clipboard text takes priority — if it has content, create a prompt node.
        // Fall back to internal node clipboard only when the OS clipboard is empty.
        navigator.clipboard.readText?.().then((raw) => {
          const text = raw.trim();
          // If the OS clipboard contains our node-copy sentinel, paste nodes.
          // Otherwise treat non-empty text as external content → prompt node.
          if (text && text !== nodeSentinelRef.current) {
            const currentState = useWorkflowStore.getState();
            const currentNodes = currentState.nodes;
            const currentEdges = currentState.edges;
            const size = getDefaultNodeSize("promptNode", currentState.lastNodeSize);

            // If exactly one node is selected, and it has an unconnected "prompt"
            // input handle, drop the new text node next to it and wire it in.
            const selected = currentNodes.filter((n) => n.selected);
            const target = selected.length === 1 ? selected[0] : null;
            const targetAcceptsPrompt = target ? nodeAcceptsPromptInput(target, currentEdges) : false;

            const newId = `promptNode-${uid()}`;
            let position: { x: number; y: number };
            const gap = 60;
            if (target && targetAcceptsPrompt) {
              const targetSize = {
                w: target.measured?.width ?? (typeof target.style?.width === "number" ? target.style.width : undefined) ?? NODE_SIZE[target.type ?? ""]?.w ?? FALLBACK_SIZE.w,
                h: target.measured?.height ?? (typeof target.style?.height === "number" ? target.style.height : undefined) ?? NODE_SIZE[target.type ?? ""]?.h ?? FALLBACK_SIZE.h,
              };
              position = {
                x: target.position.x - size.w - gap,
                y: target.position.y + (targetSize.h - size.h) / 2,
              };
            } else {
              const rect = wrapperRef.current?.getBoundingClientRect();
              if (!rect) return;
              const { x: panX, y: panY, zoom } = viewportRef.current;
              const cx = (mousePosRef.current.x - rect.left - panX) / zoom;
              const cy = (mousePosRef.current.y - rect.top - panY) / zoom;
              position = { x: cx - size.w / 2, y: cy - size.h / 2 };
            }

            addNode({
              id: newId,
              type: "promptNode",
              position,
              style: { width: size.w, height: size.h },
              data: { label: nodeLabel("promptNode", currentNodes), prompt: text },
            });

            if (target && targetAcceptsPrompt) {
              insertEdge({
                id: `edge-${uid()}`,
                source: newId,
                target: target.id,
                targetHandle: "prompt",
                animated: false,
                style: edgeStyle("prompt"),
              });
            }
          } else if (clipboardRef.current) {
            handlePaste();
          }
        }).catch(() => {
          // Clipboard read denied (e.g. no permission) — fall back to node paste
          if (clipboardRef.current) handlePaste();
        });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleCopy, handlePaste, handleUndo, handleRedo, addNode, insertEdge]);

  // ── Context menu + node commands (duplicate, lock, layer order) ──────────────
  const rfRef = useRef<ReturnType<typeof useReactFlow> | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string | null } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  /** Selected nodes, plus the members of any selected group. */
  const selectionWithMembers = useCallback(() => {
    const all = useWorkflowStore.getState().nodes;
    const ids = new Set(all.filter((n) => n.selected).map((n) => n.id));
    for (const n of all) {
      if (ids.has(n.id) && n.type === "groupNode") ((n.data?.memberIds as string[] | undefined) ?? []).forEach((m) => ids.add(m));
    }
    return { all, ids };
  }, []);

  const duplicateSelection = useCallback(() => {
    const { all, ids } = selectionWithMembers();
    if (ids.size === 0) return;
    const curEdges = useWorkflowStore.getState().edges;
    const idMap = new Map<string, string>();
    const picked = all.filter((n) => ids.has(n.id));
    picked.forEach((n) => idMap.set(n.id, `${n.type}-${uid()}`));
    onNodesChange(all.filter((n) => n.selected).map((n) => ({ type: "select" as const, id: n.id, selected: false })));
    for (const n of picked) {
      const data: NodeData = { ...n.data, status: n.data.status === "running" ? "idle" : n.data.status, locked: false };
      if (n.type === "groupNode") data.memberIds = ((n.data.memberIds as string[] | undefined) ?? []).map((m) => idMap.get(m) ?? m);
      addNode({ ...n, id: idMap.get(n.id)!, selected: true, position: { x: n.position.x + 40, y: n.position.y + 40 }, data });
    }
    for (const e of curEdges) {
      const src = idMap.get(e.source), tgt = idMap.get(e.target);
      if (src && tgt) insertEdge({ ...e, id: `edge-${uid()}`, source: src, target: tgt });
    }
  }, [selectionWithMembers, onNodesChange, addNode, insertEdge]);

  const deleteSelection = useCallback(() => {
    const { all, ids } = selectionWithMembers();
    const removable = all.filter((n) => ids.has(n.id) && n.deletable !== false && !n.data?.locked);
    if (removable.length) onNodesChange(removable.map((n) => ({ type: "remove" as const, id: n.id })));
  }, [selectionWithMembers, onNodesChange]);

  /** Lock or unlock the selection (a group locks together with its members). */
  const setSelectionLocked = useCallback((locked: boolean) => {
    const { ids } = selectionWithMembers();
    pushUndoSnapshot();
    ids.forEach((id) => updateNodeData(id, { locked }));
    requestWorkflowSync();
  }, [selectionWithMembers, pushUndoSnapshot, updateNodeData]);

  const unlockAll = useCallback(() => {
    const locked = useWorkflowStore.getState().nodes.filter((n) => n.data?.locked);
    if (!locked.length) return;
    pushUndoSnapshot();
    locked.forEach((n) => updateNodeData(n.id, { locked: false }));
    requestWorkflowSync();
  }, [pushUndoSnapshot, updateNodeData]);

  /** Bring to front / send to back, stored on the node so it persists. */
  const reorderSelection = useCallback((where: "front" | "back") => {
    const { all, ids } = selectionWithMembers();
    if (!ids.size) return;
    const orders = all.filter((n) => n.type !== "groupNode").map((n) => (n.data?.zOrder as number | undefined) ?? 0);
    const next = where === "front" ? Math.max(0, ...orders) + 1 : Math.min(0, ...orders) - 1;
    all.filter((n) => ids.has(n.id) && n.type !== "groupNode").forEach((n) => updateNodeData(n.id, { zOrder: next }));
    requestWorkflowSync();
  }, [selectionWithMembers, updateNodeData]);

  const selectAll = useCallback(() => {
    onNodesChange(useWorkflowStore.getState().nodes.map((n) => ({ type: "select" as const, id: n.id, selected: true })));
  }, [onNodesChange]);

  /** Add a node with its top-left at a screen point (right-click → Add node). */
  const addNodeAtScreen = useCallback((type: string, sx: number, sy: number) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { x: panX, y: panY, zoom } = viewportRef.current;
    const state = useWorkflowStore.getState();
    const size = getDefaultNodeSize(type, state.lastNodeSize);
    addNode({
      id: `${type}-${uid()}`,
      type,
      position: { x: (sx - rect.left - panX) / zoom, y: (sy - rect.top - panY) / zoom },
      style: type === "imageInputNode" || type === "videoInputNode" ? { width: size.w } : { width: size.w, height: size.h },
      data: { label: nodeLabel(type, state.nodes), status: "idle", ...getLastNodeSettings(type, state.nodes) },
    });
  }, [addNode]);

  /**
   * Swap product: Kling 4.0 edits the source video and replaces its product with the
   * chosen image, keeping the motion. Adds a prompt node + Kling 4.0 node next to the
   * video and wires video → reference video, image → reference image, prompt → prompt.
   * With no image chosen, an empty image node is added for the user to upload into.
   */
  const swapProduct = useCallback((videoNodeId: string, imageNodeId: string | null) => {
    const state = useWorkflowStore.getState();
    const src = state.nodes.find((n) => n.id === videoNodeId);
    if (!src) return;
    const d = src.data as Record<string, unknown>;
    const w = (src.measured?.width ?? (src.style?.width as number | undefined) ?? 320);
    const x0 = src.position.x + w + 80;
    const y0 = src.position.y;

    let imgId = imageNodeId;
    if (!imgId) {
      imgId = `imageInputNode-${uid()}`;
      addNode({ id: imgId, type: "imageInputNode", position: { x: x0, y: y0 + 300 }, style: { width: 160 }, data: { label: "", status: "idle" } });
    }
    const imgLabel = (useWorkflowStore.getState().nodes.find((n) => n.id === imgId)?.data?.label as string | undefined) || "Product";

    // Duration follows the clip (Kling 4.0: 3–30 s); ratio follows its shape
    const rawDur = Number(d.videoDuration ?? d.duration ?? 5);
    const duration = Math.min(30, Math.max(3, Math.round(rawDur || 5)));
    const ratioStr = String(d.videoAspectRatio ?? d.imageNaturalRatio ?? "");
    const [rw, rh] = ratioStr.split("/").map((s) => Number(s.trim()));
    const r = rw && rh ? rw / rh : 9 / 16;
    const aspectRatio = r < 0.8 ? "9:16" : r > 1.25 ? "16:9" : "1:1";

    // The image mention comes first: unlabeled @words take the next free image slot.
    const prompt =
      `Take the product from @${imgLabel}. Edit @video_1: replace the main product or object in the video with that exact product ` +
      `(same shape, label, colours, logo and text; the label stays sharp and readable in every frame). ` +
      `The new product must perform exactly the same motion as the original object, frame for frame: every spin, flip, rotation, bounce and trajectory, at the same speed and timing. ` +
      `Keep everything else unchanged: camera movement, timing, lighting, background, environment and effects. Do not add text or people.`;

    const promptId = `promptNode-${uid()}`;
    const genId = `videoGeneratorNode-${uid()}`;
    addNode({ id: promptId, type: "promptNode", position: { x: x0, y: y0 - 40 }, style: { width: 420, height: 230 }, data: { label: "", status: "idle", prompt } });
    addNode({
      id: genId, type: "videoGeneratorNode", position: { x: x0 + 480, y: y0 },
      style: { width: 320, height: 569 },
      data: { label: "", status: "idle", videoModel: "kling-4.0", duration, aspectRatio, grokResolution: "720p", sound: false },
    });
    insertEdge({ id: `edge-${uid()}`, source: promptId, target: genId, targetHandle: "prompt" });
    insertEdge({ id: `edge-${uid()}`, source: imgId, target: genId, targetHandle: "resource" });
    insertEdge({ id: `edge-${uid()}`, source: videoNodeId, sourceHandle: "videoRefOut", target: genId, targetHandle: "referenceVideo" });
    requestWorkflowSync();
  }, [addNode, insertEdge]);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    // Right-clicking outside the current selection acts on that node alone
    if (!node.selected) {
      const all = useWorkflowStore.getState().nodes;
      onNodesChange(all.map((n) => ({ type: "select" as const, id: n.id, selected: n.id === node.id })));
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, [onNodesChange]);

  const onSelectionContextMenu = useCallback((e: React.MouseEvent, sel: Node[]) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: sel[0]?.id ?? null });
  }, []);

  const onPaneContextMenu = useCallback((e: MouseEvent | React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: null });
  }, []);

  const ctxItems = useMemo<MenuEntry[]>(() => {
    if (!ctxMenu) return [];
    const pasteHere = () => { mousePosRef.current = { x: ctxMenu.x, y: ctxMenu.y }; handlePaste(); };
    if (ctxMenu.nodeId) {
      const node = nodes.find((n) => n.id === ctxMenu.nodeId);
      const selectedCount = nodes.filter((n) => n.selected).length || 1;
      const locked = !!node?.data?.locked;
      const url = selectedCount === 1 ? nodeMediaUrl(node) : undefined;
      const swapSrc = selectedCount === 1 && node && (node.type === "videoInputNode" || node.type === "videoGeneratorNode")
        && typeof node.data?.videoUrl === "string" && /^https?:\/\//.test(node.data.videoUrl as string) ? node : null;
      const productNodes = swapSrc
        ? nodes.filter((n) => (n.type === "imageInputNode" && /^https?:\/\//.test(String(n.data?.r2Url ?? "")))
            || (n.type === "generateNode" && /^https?:\/\//.test(String(n.data?.imageUrl ?? ""))))
        : [];
      return [
        { label: selectedCount > 1 ? `Copy ${selectedCount} nodes` : "Copy", shortcut: mod("C"), onClick: handleCopy },
        { label: "Paste", shortcut: mod("V"), onClick: pasteHere, disabled: !clipboardRef.current },
        { label: "Duplicate", shortcut: mod("D"), onClick: duplicateSelection },
        ...(url ? [{ label: "Copy link to media", onClick: () => { navigator.clipboard.writeText(url).catch(() => {}); } }] : []),
        ...(swapSrc ? ["divider" as const, {
          label: "Swap product (Kling 4.0)",
          submenu: [
            ...productNodes.map((p) => ({ label: String(p.data?.label || "Image"), onClick: () => swapProduct(swapSrc.id, p.id) })),
            { label: "New product image…", onClick: () => swapProduct(swapSrc.id, null) },
          ],
        }] : []),
        "divider",
        { label: "Bring to front", shortcut: "]", onClick: () => reorderSelection("front") },
        { label: "Send to back", shortcut: "[", onClick: () => reorderSelection("back") },
        "divider",
        { label: locked ? "Unlock" : "Lock", shortcut: mod("L", true), onClick: () => setSelectionLocked(!locked) },
        "divider",
        { label: selectedCount > 1 ? `Delete ${selectedCount} nodes` : "Delete", shortcut: "⌫", danger: true, disabled: locked, onClick: deleteSelection },
      ];
    }
    const anyLocked = nodes.some((n) => n.data?.locked);
    return [
      { label: "Paste", shortcut: mod("V"), onClick: pasteHere, disabled: !clipboardRef.current },
      {
        label: "Add node",
        submenu: NODES.map((n) => ({
          label: n.label,
          icon: <span style={{ color: NODE_META[n.type]?.accent }}>{n.icon}</span>,
          onClick: () => addNodeAtScreen(n.type, ctxMenu.x, ctxMenu.y),
        })),
      },
      "divider",
      { label: "Select all", shortcut: mod("A"), onClick: selectAll, disabled: nodes.length === 0 },
      { label: "Fit view", shortcut: "⇧1", onClick: () => rfRef.current?.fitView({ duration: 300, padding: 0.15 }), disabled: nodes.length === 0 },
      { label: "Undo", shortcut: mod("Z"), onClick: handleUndo, disabled: !canUndo },
      { label: "Redo", shortcut: mod("Z", true), onClick: handleRedo, disabled: !canRedo },
      "divider",
      { label: "Unlock all objects", shortcut: isMacPlatform() ? "⌥⇧⌘L" : "Ctrl+Alt+Shift+L", onClick: unlockAll, disabled: !anyLocked },
    ];
  }, [ctxMenu, nodes, handleCopy, handlePaste, duplicateSelection, reorderSelection, setSelectionLocked, deleteSelection, addNodeAtScreen, selectAll, handleUndo, handleRedo, canUndo, canRedo, unlockAll, swapProduct]);

  // Keyboard: duplicate, lock, layer order, select all, fit view
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const m = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (m && !e.shiftKey && k === "d") { e.preventDefault(); duplicateSelection(); }
      else if (m && e.shiftKey && e.altKey && k === "l") { e.preventDefault(); unlockAll(); }
      else if (m && e.shiftKey && !e.altKey && k === "l") {
        e.preventDefault();
        const sel = useWorkflowStore.getState().nodes.filter((n) => n.selected);
        if (sel.length) setSelectionLocked(!sel.every((n) => n.data?.locked));
      }
      else if (m && !e.shiftKey && k === "a") { e.preventDefault(); selectAll(); }
      else if (!m && !e.altKey && e.key === "]") reorderSelection("front");
      else if (!m && !e.altKey && e.key === "[") reorderSelection("back");
      else if (!m && e.shiftKey && (e.key === "!" || e.code === "Digit1")) rfRef.current?.fitView({ duration: 300, padding: 0.15 });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [duplicateSelection, unlockAll, setSelectionLocked, selectAll, reorderSelection]);

  // Reference nodes used to have decorative input bubbles that accepted wires but did
  // nothing. Those inputs are gone; drop any saved wires that still point at them.
  useEffect(() => {
    const stale = edges.filter((e) => e.targetHandle === "decorativeText" || e.targetHandle === "decorativeImage");
    if (stale.length) onEdgesChange(stale.map((e) => ({ type: "remove" as const, id: e.id })));
  }, [edges, onEdgesChange]);

  // ── Auto-trim + frame-extract on new connections ─────────────────────────────
  const handleConnect = useCallback((connection: Connection) => {
    onConnect(connection);

    // Extract frame immediately when a Video source is wired to an image-consuming handle.
    // Exception: imagePickOut → user picks manually via the frame picker, no auto-extraction.
    const th = connection.targetHandle;
    const sh = connection.sourceHandle;
    const IMAGE_TARGET_HANDLES = new Set(["image", "startFrame", "endFrame", "resource"]);
    const isImageTarget = !th || IMAGE_TARGET_HANDLES.has(th);

    if (isImageTarget && sh !== "imagePickOut") {
      const srcNode = nodes.find((n) => n.id === connection.source);
      const tgtNode = nodes.find((n) => n.id === connection.target);
      const validTarget =
        (th === "image" && tgtNode?.type === "generateNode") ||
        (th === "startFrame" && tgtNode?.type === "videoGeneratorNode") ||
        (th === "endFrame" && tgtNode?.type === "videoGeneratorNode") ||
        (th === "resource" && tgtNode?.type === "videoGeneratorNode") ||
        (!th && tgtNode?.type === "imageInputNode");

      if ((srcNode?.type === "videoInputNode" || srcNode?.type === "videoGeneratorNode") && validTarget) {
        const videoUrl = (srcNode.data.videoUrl ?? srcNode.data.r2Url) as string | undefined;
        // For startFrame/endFrame always re-extract (user is declaring which frame they want).
        // For image handle, skip if already extracted to avoid redundant uploads.
        const alreadyExtracted = !!(srcNode.data.capturedFrameUrl as string | undefined);
        const shouldExtract = videoUrl && !videoUrl.startsWith("blob:") &&
          (th === "startFrame" || th === "endFrame" || !alreadyExtracted);

        if (shouldExtract) {
          const trimEnd = srcNode.data.trimEnd as number | undefined;
          const trimStart = srcNode.data.trimStart as number | undefined;
          let extractBody: Record<string, unknown>;
          if (th === "startFrame") {
            extractBody = { videoUrl, timeSeconds: trimStart ?? 0 };
          } else if (th === "endFrame") {
            extractBody = trimEnd !== undefined
              ? { videoUrl, timeSeconds: trimEnd }
              : { videoUrl, lastFrame: true };
          } else {
            extractBody = trimEnd !== undefined
              ? { videoUrl, timeSeconds: trimEnd }
              : { videoUrl, timeSeconds: trimStart ?? 0 };
          }
          const srcId = srcNode.id;
          const tgtId = tgtNode?.id;
          updateNodeDataRef.current(srcId, { extractingFrame: true });
          getAccessToken().then((token) => {
            if (!token) { updateNodeDataRef.current(srcId, { extractingFrame: false }); return; }
            fetch("/api/extract-frame", {
              method: "POST",
              headers: authHeaders(token),
              body: JSON.stringify(extractBody),
            }).then((r) => r.json()).then((j) => {
              if (j.cdnUrl) {
                updateNodeDataRef.current(srcId, { capturedFrameUrl: j.cdnUrl });
                if (tgtNode?.type === "imageInputNode" && tgtId) {
                  updateNodeDataRef.current(tgtId, { r2Url: j.cdnUrl, inputImage: j.cdnUrl });
                }
              }
            }).catch(() => { }).finally(() => {
              updateNodeDataRef.current(srcId, { extractingFrame: false });
            });
          });
        } else if (videoUrl && (th === "startFrame" || th === "endFrame" || alreadyExtracted)) {
          // If already extracted or using existing frame, and target is ImageInputNode, update it immediately
          if (tgtNode?.type === "imageInputNode") {
            const frameUrl = srcNode.data.capturedFrameUrl as string | undefined;
            if (frameUrl) {
              updateNodeDataRef.current(tgtNode.id, { r2Url: frameUrl, inputImage: frameUrl });
            }
          }
        }
      }
    }

    // HappyHorse: startFrame and resource are mutually exclusive
    if (connection.targetHandle === "startFrame" || connection.targetHandle === "resource") {
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (targetNode?.type === "videoGeneratorNode") {
        const videoModelId = (targetNode.data?.videoModel as string | undefined) ?? "";
        if (videoModelId === "happyhorse") {
          const conflictHandle = connection.targetHandle === "startFrame" ? "resource" : "startFrame";
          const toRemove = edges.filter(
            (e) => e.target === connection.target && e.targetHandle === conflictHandle
          );
          if (toRemove.length > 0) {
            onEdgesChange(toRemove.map((e) => ({ type: "remove" as const, id: e.id })));
          }
        }
      }
    }

    const h = connection.targetHandle;
    if (h !== "resource" && h !== "videoRef") return;

    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (sourceNode?.type !== "videoInputNode") return;
    if (targetNode?.type !== "videoGeneratorNode") return;

    const videoModelId = (targetNode.data?.videoModel as string | undefined) ?? "kling-3.0";
    const cfg = VIDEO_MODELS.find((m) => m.id === videoModelId);
    if (!cfg) return;

    // Pick the right cap: videoRef uses videoRefMaxDuration, resource uses durationMax
    const maxDuration = h === "videoRef"
      ? cfg.apiInput.videoRefMaxDuration
      : cfg.apiInput.durationMax > 0 ? cfg.apiInput.durationMax : undefined;
    if (!maxDuration) return;

    const videoDuration = sourceNode.data?.videoDuration as number | undefined;
    if (!videoDuration) return;

    // If a trim is already applied, use the trimmed duration — not the full video length
    const trimStart = sourceNode.data?.trimStart as number | undefined;
    const trimEnd = sourceNode.data?.trimEnd as number | undefined;
    const effectiveDuration = (trimStart !== undefined && trimEnd !== undefined)
      ? trimEnd - trimStart
      : videoDuration;

    if (effectiveDuration <= maxDuration) return;

    // Video exceeds model limit — ask the VideoInputNode to open the trimmer
    updateNodeData(connection.source, { triggerTrimMaxDuration: maxDuration });
  }, [onConnect, nodes, updateNodeData]);

  // ── Edge drop → node picker ─────────────────────────────────────────────
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRubberBandSelecting, setIsRubberBandSelecting] = useState(false);
  const [dropState, setDropState] = useState<DropState | null>(null);
  const [log, setLog] = useState<{ text: string; ok: boolean }[]>([]);

  // ── Add-node menu (+ button) ─────────────────────────────────────────
  const [addMenuAnchor, setAddMenuAnchor] = useState<DOMRect | null>(null);

  const setSettingsOpen = useWorkflowStore((s) => s.setSettingsOpen);
  const activeSpaceId = useWorkflowStore((s) => s.activeSpaceId);
  const activeSpace = useWorkflowStore((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const builderOpen = useWorkflowStore((s) => s.builderOpen);

  // ── Alignment snap guides ─────────────────────────────────────────────────────
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const snapTargetRef = useRef<{ id: string; x: number; y: number } | null>(null);

  const push = useCallback((text: string, ok = true) => {
    setLog((l) => [...l.slice(-60), { text, ok }]);
  }, []);

  // prompt handle: only promptNode; 1 connection max. image handle: up to 14 (nano-banana-2 limit).
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      // Prevent self-loops
      if (connection.source === connection.target) return false;

      const source = nodes.find((n) => n.id === connection.source);
      const target = nodes.find((n) => n.id === connection.target);

      // Every wire runs from an output into an input of the same kind
      // (text → prompt, image → image inputs, video → video inputs, audio → audio input).
      // Reference nodes (image, video, voice) are pure sources and have no inputs.
      const outType = outputTypeOf(source?.type, connection.sourceHandle);
      const inTypes = connection.targetHandle ? INPUT_ACCEPTS[connection.targetHandle] : undefined;
      if (!outType || !inTypes || !inTypes.includes(outType)) return false;

      if (target?.type === "generateNode") {
        if (connection.targetHandle === "prompt") {
          const taken = edges.some(
            (e) => e.target === connection.target && e.targetHandle === "prompt"
          );
          if (taken) return false;
        }
        if (connection.targetHandle === "image") {
          const count = edges.filter(
            (e) => e.target === connection.target && e.targetHandle === "image"
          ).length;
          if (count >= 14) return false;

          // Same image source cannot be connected twice to the same node
          const duplicate = edges.some(
            (e) =>
              e.source === connection.source &&
              e.target === connection.target &&
              e.targetHandle === "image"
          );
          if (duplicate) return false;
        }
      }

      // Video generator: prompt/startFrame/endFrame accept 1 each; resource accepts up to 3
      if (target?.type === "videoGeneratorNode") {
        const videoModelId = (target.data?.videoModel as string | undefined) ?? "kling-3.0";
        const videoCfg = VIDEO_MODELS.find((m) => m.id === videoModelId);
        const isMotionControl = videoCfg?.apiInput.useMotionControl === true;

        // Only allow handles that the selected model actually supports
        if (connection.targetHandle && !videoCfg?.handles.includes(connection.targetHandle as never)) {
          return false;
        }

        if (
          connection.targetHandle === "prompt" ||
          connection.targetHandle === "startFrame" ||
          connection.targetHandle === "endFrame"
        ) {
          const taken = edges.some(
            (e) => e.target === connection.target && e.targetHandle === connection.targetHandle
          );
          if (taken) return false;
        }
        if (connection.targetHandle === "resource") {
          // Motion control uses videoRef instead — resource is blocked above via handles check
          const maxResources = isMotionControl ? 0 : (videoCfg?.maxResources ?? 3);
          const count = edges.filter(
            (e) => e.target === connection.target && e.targetHandle === "resource"
          ).length;
          if (count >= maxResources) return false;
          // Same source can't connect twice via resource
          const dup = edges.some(
            (e) => e.source === connection.source && e.target === connection.target && e.targetHandle === "resource"
          );
          if (dup) return false;
        }
        if (connection.targetHandle === "videoRef") {
          // Motion control: only 1 reference video allowed
          const taken = edges.some(
            (e) => e.target === connection.target && e.targetHandle === "videoRef"
          );
          if (taken) return false;
        }
      }

      return true;
    },
    [nodes, edges]
  );

  // Tag the ReactFlow container with the output handle type so CSS can filter compatible inputs
  const onConnectStart = useCallback((event: MouseEvent | TouchEvent) => {
    const handle = (event.target as HTMLElement)?.closest?.(".react-flow__handle") as HTMLElement | null;
    const rf = (event.target as HTMLElement)?.closest?.(".react-flow") as HTMLElement | null;
    if (!handle || !rf) return;
    let type = "unknown";
    if (handle.classList.contains("node-handle-icon-out-text")) type = "prompt";
    else if (handle.classList.contains("node-handle-icon-out-image")) type = "image";
    else if (handle.classList.contains("node-handle-icon-out-video")) type = "video";
    else if (handle.classList.contains("node-handle-icon-out-audio")) type = "audio";
    else if (handle.classList.contains("node-handle-prompt")) type = "prompt";
    else if (handle.classList.contains("node-handle-source")) type = "image";
    else if (handle.classList.contains("node-handle-video")) type = "video";
    rf.setAttribute("data-connecting-type", type);
    setConnectingHandleType(type);
    setIsConnecting(true);
    handle.classList.add("node-handle-connecting");
  }, [setConnectingHandleType]);

  // Show node-picker when an edge is dragged and released on empty canvas
  const onConnectEnd = useCallback(
    (
      event: MouseEvent | TouchEvent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connectionState: any,
    ) => {
      // Remove connecting-type tag and handle highlight
      const rf = (event.target as HTMLElement)?.closest?.(".react-flow") as HTMLElement | null;
      rf?.removeAttribute("data-connecting-type");
      document.querySelectorAll(".node-handle-connecting").forEach((el) => el.classList.remove("node-handle-connecting"));
      setConnectingHandleType(null);
      setIsConnecting(false);

      // toHandle is set whenever the drag landed on any handle (valid or blocked).
      // isValid is true when the connection was accepted.
      // Either condition means the user wasn't dropping on empty canvas → skip picker.
      if (connectionState.toHandle || connectionState.isValid) return;
      // No source node → drag started from canvas, skip
      if (!connectionState.fromNode) return;

      const { clientX, clientY } =
        "changedTouches" in event
          ? (event as TouchEvent).changedTouches[0]
          : (event as MouseEvent);

      setDropState({
        screenX: clientX,
        screenY: clientY,
        sourceNodeId: connectionState.fromNode.id,
        sourceNodeType: connectionState.fromNode.type,
        sourceHandleId: connectionState.fromHandle?.id ?? null,
        isInputHandle: connectionState.fromHandle?.type === "target",
      });
    },
    [],
  );

  const setAuthModalOpen = useWorkflowStore((s) => s.setAuthModalOpen);
  const addToast   = useWorkflowStore((s) => s.addToast);
  const kieKeySet  = useWorkflowStore((s) => s.kieKeySet);

  const runAll = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setAuthModalOpen(true);
      return;
    }

    setIsRunning(true);
    setLog([]);
    push("Running workflow…");
    const order = topoSort(nodes, edges);

    for (const nodeId of order) {
      const node = nodes.find((n) => n.id === nodeId) as Node<NodeData> | undefined;
      if (!node) continue;

      // ── Image generator ─────────────────────────────────────────────────────
      if (node.type === "generateNode") {
        // Extract frames from VideoInputNodes on the image handle that lack a capturedFrameUrl.
        // Uses trimEnd if set (end frame), otherwise trimStart ?? 0 (start / first frame).
        const videoImageEdges = edges.filter(
          (e) => e.target === nodeId && e.targetHandle === "image" &&
            useWorkflowStore.getState().nodes.find((n) => n.id === e.source)?.type === "videoInputNode"
        );
        for (const edge of videoImageEdges) {
          const src = useWorkflowStore.getState().nodes.find((n) => n.id === edge.source);
          if (!src || (src.data.capturedFrameUrl as string | undefined)) continue;
          const videoUrl = (src.data.videoUrl ?? src.data.r2Url) as string | undefined;
          if (!videoUrl || videoUrl.startsWith("blob:")) continue;
          const trimStart = src.data.trimStart as number | undefined;
          const trimEnd = src.data.trimEnd as number | undefined;
          const extractBody = trimEnd !== undefined
            ? { videoUrl, timeSeconds: trimEnd }
            : { videoUrl, timeSeconds: trimStart ?? 0 };
          try {
            const r = await fetch("/api/extract-frame", {
              method: "POST",
              headers: authHeaders(token),
              body: JSON.stringify(extractBody),
            });
            const j = await r.json();
            if (j.cdnUrl) updateNodeData(src.id, { capturedFrameUrl: j.cdnUrl });
          } catch { /* proceed without */ }
        }

        const upstream = resolveInputs(nodeId, useWorkflowStore.getState().nodes as Node<NodeData>[], edges);
        const prompt = upstream.prompt;
        const imageUrls = upstream.imageUrls;
        const aspectRatio = node.data.aspectRatio ?? "1:1";
        const quality = node.data.quality ?? "1k";
        const payload = { prompt, imageUrls, model: node.data.model, aspectRatio, quality };

        if (!prompt?.trim()) {
          const promptNodeId = edges.find(
            (e) => e.target === nodeId && e.targetHandle === "prompt"
          )?.source;
          if (promptNodeId) updateNodeData(promptNodeId, { hasError: true });
          push(`[${node.id}] skipped — prompt is empty`, false);
          continue;
        }

        if (debugMode) {
          console.log(`[DEBUG] node=${node.id}`, payload);
          push(`[DEBUG] ${node.id} — logged to console`);
          continue;
        }

        push(`[${node.id}] ${aspectRatio} · ${imageUrls.length} image(s)…`);
        updateNodeData(nodeId, { status: "running", imageUrl: undefined });

        try {
          // Submit job
          const res = await fetch("/api/generate", {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);

          const { taskId, referenceImageUrls } = data as {
            taskId: string;
            referenceImageUrls?: string[];
          };

          // If reference images were uploaded to R2, update those nodes immediately
          if (referenceImageUrls?.length) {
            const imageEdges = edges.filter(
              (e) => e.target === nodeId && e.targetHandle === "image"
            );
            referenceImageUrls.forEach((cdnUrl, i) => {
              const srcId = imageEdges[i]?.source;
              if (srcId) updateNodeData(srcId, { r2Url: cdnUrl });
            });
          }

          // Poll /api/job-status until done (image generate is async/callback-based)
          push(`[${node.id}] waiting for result…`);
          let imageUrl: string | undefined;
          for (let attempt = 0; attempt < 120; attempt++) {
            await new Promise((r) => setTimeout(r, 3000));
            const poll = await fetch(`/api/job-status?taskId=${taskId}`);
            const result = await poll.json();
            if (result.status === "done") { imageUrl = result.imageUrl; break; }
            if (result.status === "error") throw new Error(result.error ?? "Generation failed");
            if (attempt > 0 && attempt % 5 === 0) push(`[${node.id}] still waiting…`);
          }

          if (!imageUrl) throw new Error("Timed out waiting for generation result");
          updateNodeData(nodeId, { status: "done", imageUrl });
          push(`[${node.id}] done`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          updateNodeData(nodeId, { status: "error", errorMsg: msg });
          push(`[${node.id}] error: ${msg}`, false);
        }
      }

      // ── Assistant (text-to-text LLM) ────────────────────────────────────────
      if (node.type === "assistantNode") {
        const upstream = resolveInputs(nodeId, nodes as Node<NodeData>[], edges);
        const prompt = upstream.prompt ?? (node.data.localPrompt as string | undefined) ?? "";

        if (!prompt.trim()) {
          push(`[${node.id}] skipped — prompt is empty`, false);
          continue;
        }

        if (debugMode) {
          console.log(`[DEBUG] assistantNode=${node.id}`, { prompt, model: node.data.model });
          push(`[DEBUG] ${node.id} — logged to console`);
          continue;
        }

        push(`[${node.id}] generating text…`);
        updateNodeData(nodeId, { status: "running", outputText: "", errorMsg: undefined });

        try {
          const res = await fetch("/api/assistant", {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify({
              prompt,
              model: node.data.model ?? "claude-sonnet-4-6",
              systemPrompt: "You are an expert prompt engineer. Rewrite the user's prompt to be clearer, more specific, and more effective for an AI model. Output only the improved prompt — no explanation, no preamble, no quotes, no commentary of any kind.",
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "Generation failed" }));
            throw new Error(err.error ?? "Generation failed");
          }

          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let accumulated = "";
          outer: while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value, { stream: true }).split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") break outer;
              try {
                const parsed = JSON.parse(payload);
                if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
                  const delta = parsed.delta.text ?? "";
                  if (delta) { accumulated += delta; updateNodeData(nodeId, { outputText: accumulated }); }
                }
              } catch { /* skip */ }
            }
          }
          updateNodeData(nodeId, { status: "done", outputText: accumulated });
          push(`[${node.id}] done`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          updateNodeData(nodeId, { status: "error", errorMsg: msg });
          push(`[${node.id}] error: ${msg}`, false);
        }
      }

      // ── Video generator (Kling 3.0) ─────────────────────────────────────────
      if (node.type === "videoGeneratorNode") {
        const upstream = resolveInputs(nodeId, useWorkflowStore.getState().nodes as Node<NodeData>[], edges);
        const prompt = upstream.prompt ?? "";
        const duration = node.data.duration ?? 5;
        const aspectRatio = node.data.aspectRatio ?? "16:9";
        const klingMode = node.data.klingMode ?? "pro";
        const sound = node.data.sound ?? false;
        const payload = {
          prompt,
          startFrameUrl: upstream.startFrameUrl,
          endFrameUrl: upstream.endFrameUrl,
          resources: upstream.resources,
          sound, duration, aspectRatio,
          mode: klingMode,
        };

        if (!prompt.trim()) {
          const promptNodeId = edges.find(
            (e) => e.target === nodeId && e.targetHandle === "prompt"
          )?.source;
          if (promptNodeId) updateNodeData(promptNodeId, { hasError: true });
          push(`[${node.id}] skipped — prompt is empty`, false);
          continue;
        }

        if (debugMode) {
          console.log(`[DEBUG] videoNode=${node.id}`, payload);
          push(`[DEBUG] ${node.id} — logged to console`);
          continue;
        }

        push(`[${node.id}] Kling 3.0 · ${klingMode} · ${duration}s…`);
        updateNodeData(nodeId, { status: "running", videoUrl: undefined });

        try {
          const res = await fetch("/api/generate-video", {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          updateNodeData(nodeId, { status: "done", videoUrl: data.videoUrl });
          push(`[${node.id}] done`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          updateNodeData(nodeId, { status: "error", errorMsg: msg });
          push(`[${node.id}] error: ${msg}`, false);
        }
      }
    }

    push("Complete");
    setIsRunning(false);
  }, [nodes, edges, updateNodeData, setIsRunning, debugMode, push, kieKeySet, addToast]);

  // ── Place a node at the viewport center (used by the empty-state picker) ────
  const addNodeAtCenter = useCallback((type: string) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { x: panX, y: panY, zoom } = viewportRef.current;
    const cx = (rect.width / 2 - panX) / zoom;
    const cy = (rect.height / 2 - panY) / zoom;
    const currentState = useWorkflowStore.getState();
    const size = getDefaultNodeSize(type, currentState.lastNodeSize);

    const currentNodes = currentState.nodes;
    addNode({
      id: `${type}-${uid()}`,
      type,
      position: { x: cx - size.w / 2, y: cy - size.h / 2 },
      style: type === "imageInputNode" || type === "videoInputNode"
        ? { width: size.w }
        : { width: size.w, height: size.h },
      data: { label: nodeLabel(type, currentNodes), status: "idle", ...getLastNodeSettings(type, currentNodes) },
    });
  }, [addNode, insertEdge]);

  const clear = useCallback(() => {
    const { activeSpaceId, spaces } = useWorkflowStore.getState();
    useWorkflowStore.setState({
      nodes: [],
      edges: [],
      spaces: spaces.map((sp) =>
        sp.id === activeSpaceId ? { ...sp, nodes: [], edges: [] } : sp
      ),
    });
    setLog([]);
  }, []);

  const handleNodeDragStop = useCallback(() => {
    setSnapGuides([]);
    snapTargetRef.current = null;
    requestWorkflowSync(); // new position is a discrete edit — persist now
  }, []);

  // When a member node inside a selected group is clicked or dragged,
  // break the group selection so only that member moves.
  const breakGroupSelection = useCallback((node: Node) => {
    if (node.type === "groupNode") return;
    const state = useWorkflowStore.getState();
    const selectedGroups = state.nodes.filter((n) => n.type === "groupNode" && n.selected);
    const isMember = selectedGroups.some((g) =>
      (g.data?.memberIds as string[] | undefined)?.includes(node.id)
    );
    if (!isMember) return;
    const newNodes = state.nodes.map((n) =>
      n.id === node.id ? n : { ...n, selected: false }
    );
    useWorkflowStore.setState((s) => ({
      nodes: newNodes,
      spaces: s.spaces.map((sp) =>
        sp.id === s.activeSpaceId ? { ...sp, nodes: newNodes } : sp
      ),
    }));
  }, []);

  const handleNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    breakGroupSelection(node);

    // Group nodes and nodes already in a group don't show a preview
    if (node.type === "groupNode") {
      setPotentialGroupIds(null);
      return;
    }
    const isInGroup = nodes.some(
      (n) => n.type === "groupNode" && (n.data?.memberIds as string[] | undefined)?.includes(node.id)
    );
    if (isInGroup) {
      setPotentialGroupIds(null);
      return;
    }

    // Bidirectional BFS — collect all connected non-group nodes
    const visited = new Set<string>([node.id]);
    const queue = [node.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const edge of edges) {
        const next =
          edge.source === cur ? edge.target :
          edge.target === cur ? edge.source : null;
        if (!next || visited.has(next)) continue;
        const nextNode = nodes.find((n) => n.id === next);
        if (!nextNode || nextNode.type === "groupNode") continue;
        visited.add(next);
        queue.push(next);
      }
    }

    // Only show when there are actual connections
    setPotentialGroupIds(visited.size > 1 ? visited : null);
  }, [breakGroupSelection, nodes, edges]);

  const handleNodeDragStart: OnNodeDrag = useCallback((_e, node) => {
    pushUndoSnapshot();
    breakGroupSelection(node);
    setPotentialGroupIds(null);
  }, [breakGroupSelection, pushUndoSnapshot]);

  const handlePaneClick = useCallback(() => {
    setPotentialGroupIds(null);
  }, []);

  const canRun = !isRunning && nodes.some(
    (n) => n.type === "generateNode" || n.type === "videoGeneratorNode" || n.type === "assistantNode" || n.type === "voiceNode"
  );

  const computedNodes = useMemo(() => {
    // During rubber-band: return nodes as-is so only actually-changed nodes (selected state)
    // get new references. Wrapping every node in a new object causes ReactFlow to re-render
    // ALL nodes on every mousemove frame, which is the source of the blinking.
    // CSS class .is-rubber-band-selecting suppresses handle/card animations.
    if (isRubberBandSelecting && dyingNodeIds.size === 0) return nodes;

    const selIds = selectedIdsRef.current;
    const anySelected = selIds.size > 0;
    const lockedMemberIds = new Set<string>();
    nodes.filter((n) => n.type === "groupNode" && n.data?.locked).forEach((g) => {
      (g.data?.memberIds as string[] | undefined)?.forEach((mid) => lockedMemberIds.add(mid));
    });
    const hasPotentialGroup = potentialGroupIds !== null && potentialGroupIds.size > 0;
    return nodes.map((n) => {
      const isInGroup = hasPotentialGroup && potentialGroupIds!.has(n.id);
      const isHighlighted = selIds.has(n.id) || ancestorIds.has(n.id) || isInGroup;
      const isDimmed = !isRubberBandSelecting && (anySelected || hasPotentialGroup) && !isHighlighted && !isConnecting;
      const ancestorClass = ancestorIds.has(n.id) ? "node-ancestor" : null;
      const groupPreviewClass = (isInGroup && !selIds.has(n.id) && !ancestorIds.has(n.id)) ? "node-group-preview" : null;
      const isLockedMember = lockedMemberIds.has(n.id);
      const isLockedGroup = n.type === "groupNode" && !!n.data?.locked;
      const isDying = dyingNodeIds.has(n.id);
      const dyingClass = isDying ? "node-dying" : null;
      return {
        ...n,
        draggable: (isLockedMember || isLockedGroup || !!n.data?.locked) ? false : undefined,
        ...(n.data?.locked ? { deletable: false } : {}),
        ...(typeof n.data?.zOrder === "number" && n.type !== "groupNode" ? { zIndex: n.data.zOrder as number } : {}),
        className: [n.className, ancestorClass, groupPreviewClass, dyingClass, lockBadgeClass(n)].filter(Boolean).join(" ") || undefined,
        style: {
          ...n.style,
          opacity: isDying ? undefined : (isDimmed ? 0.25 : undefined),
          transition: isDying || isRubberBandSelecting ? undefined : ((anySelected || hasPotentialGroup) ? "opacity 150ms" : undefined),
        },
      };
    });
  }, [nodes, ancestorIds, potentialGroupIds, dyingNodeIds, isConnecting, isRubberBandSelecting]);

  const computedEdges = useMemo(() => {
    const selIds = selectedIdsRef.current;
    const anySelected = selIds.size > 0;
    const hasPotentialGroup = potentialGroupIds !== null && potentialGroupIds.size > 0;
    return edges.map((e) => {
      const isAncestorEdge = ancestorEdgeIds.has(e.id);
      const isGroupEdge = hasPotentialGroup && potentialGroupIds!.has(e.source) && potentialGroupIds!.has(e.target);
      const isDimmed = (anySelected || hasPotentialGroup) && !isAncestorEdge && !isGroupEdge;
      return {
        ...e,
        className: isAncestorEdge ? [e.className, "edge-ancestor"].filter(Boolean).join(" ") : e.className,
        data: { ...e.data, dying: dyingEdgeIds.has(e.id) || e.data?.dying === true, dimmed: isDimmed },
      };
    });
  }, [edges, ancestorEdgeIds, potentialGroupIds, dyingEdgeIds]);

  return (
    <div className="relative flex-1 flex flex-col min-w-0 h-full" style={{ background: "#0B0E14" }}>
      <div
        ref={wrapperRef}
        className={`relative flex-1 flex flex-col min-h-0 min-w-0${activeTool === "hand" ? " canvas-hand-mode" : ""}`}
        style={{ background: "transparent" }}
        onMouseMoveCapture={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          e.currentTarget.style.setProperty("--mouse-x", `${x}px`);
          e.currentTarget.style.setProperty("--mouse-y", `${y}px`);
          mousePosRef.current = { x: e.clientX, y: e.clientY };
        }}
      >
        <ReactFlow
          nodes={computedNodes}
          edges={computedEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={handleEdgesChange}
          onEdgeClick={handleEdgeClick}
          onSelectionChange={onSelectionChange}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onConnect={handleConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onSelectionStart={() => { isRubberBandSelectingRef.current = true; setIsRubberBandSelecting(true); }}
          onSelectionEnd={() => {
            isRubberBandSelectingRef.current = false;
            setIsRubberBandSelecting(false);
            runAncestorBFS();
          }}
          onMove={(_, vp) => { viewportRef.current = vp; saveViewport(vp); }}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.05}
          colorMode="dark"
          className={`flex-1${isRubberBandSelecting ? " is-rubber-band-selecting" : ""}`}
          style={{ background: "transparent" }}
          // Hand mode: left-click pans; Select mode: right-click pans + left-click selects
          panOnDrag={activeTool === "hand" ? [0] : [2]}
          selectionOnDrag={activeTool !== "hand"}
          nodesDraggable={activeTool !== "hand"}
          deleteKeyCode={["Delete", "Backspace"]}
          multiSelectionKeyCode="Shift"
          panOnScroll
          defaultEdgeOptions={{ animated: false }}
          connectionLineStyle={{
            stroke: "#555555",
            strokeWidth: 2,
            strokeDasharray: "6 3",
            strokeLinecap: "round",
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="#888888" />
          <ViewportSyncer />
          <FlowInstanceBridge instanceRef={rfRef} />
          <GroupPreviewOverlay groupIds={potentialGroupIds} />
          <SelectionToolbar />

          {dropState && (
            <NodePickerMenu
              dropState={dropState}
              onClose={() => setDropState(null)}
            />
          )}

          {/* ── Add-node menu (+ button) — needs to be inside ReactFlow for useReactFlow() ── */}
          {addMenuAnchor && (
            <AddNodeMenu
              anchorRect={addMenuAnchor}
              onClose={() => setAddMenuAnchor(null)}
            />
          )}

          {ctxMenu && (
            <CanvasContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={closeCtxMenu} />
          )}

          <FlowBuilderPanel />
          <NodeInspector />
          <AssetPickerPanel open={assetsOpen} onClose={() => setAssetsOpen(false)} />
          <BatchRunPanel />

          <Controls
            showInteractive={false}
            className="[&>button]:!bg-[#0B0E14] [&>button]:!border-[#1A2030] [&>button]:!text-[#A0A0A0] [&>button:hover]:!text-white"
          />

        </ReactFlow>

        {/* ── Left-middle toolbar ───────────────────────────────────────────── */}
        <CanvasToolbar
          activeTool={activeTool}
          onToolChange={(tool) => setActiveTool(tool as "select" | "hand")}
          onAddNode={(rect) => setAddMenuAnchor(rect)}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={canUndo}
          canRedo={canRedo}
          onOpenSettings={() => setSettingsOpen(true)}
          onShare={() => setShareModalOpen(true)}
          isPublic={activeSpace?.isPublic ?? false}
          onOpenAssets={() => setAssetsOpen((v) => !v)}
          assetsOpen={assetsOpen}
        />

        {shareModalOpen && (
          <ShareModal
            spaceId={activeSpaceId}
            open={shareModalOpen}
            onClose={() => setShareModalOpen(false)}
          />
        )}


        {/* ── Alignment guide lines ────────────────────────────────────────────── */}
        {snapGuides.length > 0 && (
          <svg
            className="absolute inset-0 pointer-events-none z-20"
            style={{ width: "100%", height: "100%" }}
          >
            {snapGuides.map((guide, i) => {
              const { x: panX, y: panY, zoom } = viewportRef.current;
              if (guide.type === "h") {
                const sy = guide.canvasPos * zoom + panY;
                return (
                  <line key={i} x1={-100000} y1={sy} x2={100000} y2={sy}
                    stroke="#555" strokeWidth={1} opacity={0.8} />
                );
              }
              const sx = guide.canvasPos * zoom + panX;
              return (
                <line key={i} x1={sx} y1={-100000} x2={sx} y2={100000}
                  stroke="#555" strokeWidth={1} opacity={0.8} />
              );
            })}
          </svg>
        )}

        {/* ── Welcome screen (empty state) ─────────────────────────────────────── */}
        {nodes.length === 0 && (
          <div
            className="absolute inset-y-0 left-0 flex flex-col items-center justify-center pointer-events-none z-10 transition-[right] duration-300"
            style={{ right: builderOpen ? 430 : 0 }}
          >
            {/* Ambient glow */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: "radial-gradient(ellipse 70% 50% at 50% 52%, rgba(45,212,191,0.06) 0%, transparent 70%)",
              }}
            />

            <div className="flex flex-col items-center gap-12">
              {/* Logo + title */}
              <div className="flex flex-col items-center gap-4 pointer-events-none">
                {/* Helios star icon */}
                <svg width="44" height="44" viewBox="0 0 20 20" fill="#2DD4BF" stroke="none">
                  <path d="M11.8525 4.21651L11.7221 3.2387C11.6906 3.00226 11.4889 2.82568 11.2504 2.82568C11.0118 2.82568 10.8102 3.00226 10.7786 3.23869L10.6483 4.21651C10.2658 7.0847 8.00939 9.34115 5.14119 9.72358L4.16338 9.85396C3.92694 9.88549 3.75037 10.0872 3.75037 10.3257C3.75037 10.5642 3.92694 10.7659 4.16338 10.7974L5.14119 10.9278C8.00938 11.3102 10.2658 13.5667 10.6483 16.4349L10.7786 17.4127C10.8102 17.6491 11.0118 17.8257 11.2504 17.8257C11.4889 17.8257 11.6906 17.6491 11.7221 17.4127L11.8525 16.4349C12.2349 13.5667 14.4913 11.3102 17.3595 10.9278L18.3374 10.7974C18.5738 10.7659 18.7504 10.5642 18.7504 10.3257C18.7504 10.0872 18.5738 9.88549 18.3374 9.85396L17.3595 9.72358C14.4913 9.34115 12.2349 7.0847 11.8525 4.21651Z" />
                </svg>

                <TypewriterHeading text="Build awesome workflows" />
                <motion.p
                  initial={{ filter: "blur(8px)", opacity: 0 }}
                  animate={{ filter: "blur(0px)", opacity: 1 }}
                  transition={{ duration: 0.9, delay: 0.15 }}
                  style={{ color: "rgba(255,255,255,0.35)", fontSize: "14px", margin: 0 }}
                >
                  Pick a node below to start building
                </motion.p>
              </div>

              {/* Node cards */}
              <motion.div
                className="flex flex-wrap justify-center items-stretch gap-4 pointer-events-auto px-6"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.25 }}
              >
                {[
                  {
                    type: "promptNode",
                    label: "Text",
                    desc: "Write & refine prompts",
                    accent: "#4ee5b7",
                    icon: <MessageSquare size={20} strokeWidth={1.6} />,
                  },
                  {
                    type: "generateNode",
                    label: "Image Generator",
                    desc: "Generate images from a text prompt",
                    accent: "#ff955a",
                    icon: <Sparkles size={20} strokeWidth={1.6} />,
                  },
                  {
                    type: "videoGeneratorNode",
                    label: "Video Generator",
                    desc: "Generate videos from a text prompt",
                    accent: "#a78bfa",
                    icon: <Clapperboard size={20} strokeWidth={1.6} />,
                  },
                ].map(({ type, label, desc, icon, accent }) => (
                  <button
                    key={type}
                    onClick={() => addNodeAtCenter(type)}
                    style={{
                      position: "relative",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "16px",
                      width: "210px",
                      padding: "24px 22px 26px",
                      borderRadius: "18px",
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.03)",
                      cursor: "pointer",
                      outline: "none",
                      transition: "transform 200ms ease, box-shadow 220ms ease, border-color 220ms ease, background 220ms ease",
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget;
                      el.style.transform = "translateY(-4px)";
                      el.style.boxShadow = `0 0 0 1px ${accent}35, 0 16px 40px rgba(0,0,0,0.4)`;
                      el.style.borderColor = `${accent}35`;
                      el.style.background = `rgba(255,255,255,0.05)`;
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget;
                      el.style.transform = "translateY(0)";
                      el.style.boxShadow = "";
                      el.style.borderColor = "rgba(255,255,255,0.08)";
                      el.style.background = "rgba(255,255,255,0.03)";
                    }}
                  >
                    {/* Icon badge */}
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "44px",
                      height: "44px",
                      borderRadius: "12px",
                      background: `${accent}22`,
                      color: accent,
                      flexShrink: 0,
                    }}>
                      {icon}
                    </div>

                    {/* Label + desc */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "7px" }}>
                      <span style={{
                        fontSize: "15px", fontWeight: 700,
                        color: "rgba(255,255,255,0.92)",
                        letterSpacing: "-0.2px",
                        lineHeight: 1.2,
                      }}>
                        {label}
                      </span>
                      <span style={{ fontSize: "12.5px", color: "rgba(255,255,255,0.42)", fontWeight: 400, lineHeight: 1.4 }}>
                        {desc}
                      </span>
                    </div>
                  </button>
                ))}
              </motion.div>

              <motion.p
                className="text-[11px] tracking-wide pointer-events-none select-none"
                style={{ color: "rgba(255,255,255,0.15)" }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, delay: 0.5 }}
              >
                or drag &amp; drop images and videos onto the canvas
              </motion.p>
            </div>
          </div>
        )}

        {log.length > 0 && (
          <div className="h-24 bg-[#0B0E14] border-t border-[#1A2030] overflow-y-auto px-4 py-2 shrink-0">
            {log.map((l, i) => (
              <p key={i} className={`text-[11px] font-mono leading-5 ${l.ok ? "text-[#A0A0A0]" : "text-red-500"}`}>
                {l.text}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
