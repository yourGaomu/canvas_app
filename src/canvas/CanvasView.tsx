import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, BookOpen, Check, ChevronRight, CircleAlert, Download, FileText, Hand, Image as ImageIcon, Images, Layers, Link2, List, LocateFixed, LoaderCircle, Map as MapIcon, Maximize2, Minimize2, MousePointer2, Package, Plus, Redo2, Scan, Search, Share2, Trash2, Type, Undo2, Upload, UsersRound, Video, Wifi, X, ZoomIn, ZoomOut } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { createVideo, editImage, generateImage, waitForVideo, videoResultUrl } from "../api/generation";
import { addCollaborationMember, createCollaborationRoom, getCollaborationRoom } from "../api/collaboration";
import { readCanvasProjects, storeImportedAssets, writeAssets, writeCanvasProjects } from "../storage";
import type { AuthSession, GeneratedAsset, MobileCanvasNode, MobileCanvasProject, Model } from "../types";
import { ApiError } from "../api/client";
import { logger } from "../lib/logger";
import { canvasFileName, createCanvasBundleBlob, createCanvasJsonBlob, deliverCanvasFile, readCanvasTransferFile } from "../lib/canvas-transfer";
import { enterCanvasLandscape, exitCanvasLandscape } from "../lib/canvas-orientation";
import { buildGenerationInputs, canProvideGenerationInput, getConnectionError } from "./canvas-graph";
import ImageStackNode from "./ImageStackNode";
import OptionPicker from "../components/OptionPicker";
import PromptLibrary from "../components/PromptLibrary";
import CollaborationPanel from "../components/CollaborationPanel";
import useCanvasCollaboration from "./use-canvas-collaboration";
import { isCollaborationConfigured } from "../collaboration/config";

type Props = {
  session: AuthSession;
  models: Model[];
  assets: GeneratedAsset[];
  onAssets: (assets: GeneratedAsset[]) => void;
  onProjectNavigation: () => void;
};

type CanvasTool = "select" | "pan";
type Point = { x: number; y: number };
type SelectionBox = { startX: number; startY: number; x: number; y: number };
type ConnectionHandle = "source" | "target";
type ConnectionDraft = { nodeId: string; handle: ConnectionHandle; pointerId: number; point: Point };
type PinchState = { pointerIds: [number, number]; startDistance: number; startZoom: number; worldCenter: Point };
type DragState =
  | { kind: "nodes"; pointerId: number; nodeIds: string[]; startX: number; startY: number; positions: Record<string, Point>; deferSelection?: boolean; tapNodeId?: string; moved?: boolean }
  | { kind: "pan"; pointerId: number; startX: number; startY: number; pan: Point }
  | { kind: "resize"; pointerId: number; nodeId: string; startX: number; startWidth: number }
  | { kind: "marquee"; pointerId: number; startX: number; startY: number };

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function* gridSpiralOffsets(): Generator<Point> {
  yield { x: 0, y: 0 };
  for (let ring = 1; ; ring += 1) {
    for (let x = -ring; x <= ring; x += 1) yield { x, y: -ring };
    for (let y = -ring + 1; y <= ring; y += 1) yield { x: ring, y };
    for (let x = ring - 1; x >= -ring; x -= 1) yield { x, y: ring };
    for (let y = ring - 1; y > -ring; y -= 1) yield { x: -ring, y };
  }
}

function capturePointer(target: HTMLElement | null, pointerId: number) {
  if (!target) return;
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Window-level pointer listeners remain the fallback when capture is unavailable.
  }
}

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 40;

function CanvasProjectCard({ project, onOpen, onDelete, onExport, onShare }: { project: MobileCanvasProject; onOpen: () => void; onDelete: () => void; onExport: () => void; onShare: () => void }) {
  return <article className="canvas-project-card">
    <button className="canvas-project-open" onClick={onOpen}>
      <span className="canvas-project-icon">{project.collaboration ? <UsersRound size={20} /> : <Images size={20} />}</span>
      <span className="canvas-project-info"><strong>{project.title}</strong><small>{project.collaboration ? "共享画布" : "本地画布"} · {project.nodes.length} 个节点 · {project.connections.length} 条连线</small><small>更新于 {new Date(project.updatedAt).toLocaleString()}</small></span>
      <ChevronRight size={17} />
    </button>
    <button className="canvas-project-export" aria-label={`导出${project.title}`} title="导出画布" onClick={onExport}><Download size={15} /></button>
    <button className="canvas-project-share" aria-label={project.collaboration ? "分享协作房间号" : "创建共享画布"} title={project.collaboration ? "分享房间号" : "创建共享画布"} onClick={onShare}><Share2 size={15} /></button>
    <button className="canvas-project-delete" aria-label={`删除${project.title}`} onClick={onDelete}><Trash2 size={15} /></button>
  </article>;
}

export default function CanvasView({ session, models, assets, onAssets, onProjectNavigation }: Props) {
  const [projects, setProjects] = useState<MobileCanvasProject[]>([]);
  const projectsRef = useRef<MobileCanvasProject[]>([]);
  const activeProjectIdRef = useRef<string | null>(null);
  const assetsRef = useRef(assets);
  const [loaded, setLoaded] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [exportTarget, setExportTarget] = useState<MobileCanvasProject | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferNotice, setTransferNotice] = useState("");
  const [transferFailure, setTransferFailure] = useState("");
  const [collaborationPanelOpen, setCollaborationPanelOpen] = useState(false);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [collaborationBusy, setCollaborationBusy] = useState(false);
  const [collaborationNotice, setCollaborationNotice] = useState("");
  const [collaborationFailure, setCollaborationFailure] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetFilter, setAssetFilter] = useState<"all" | GeneratedAsset["kind"]>("all");
  const [checkedAssets, setCheckedAssets] = useState<string[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [nodeDragging, setNodeDragging] = useState(false);
  const [nodePanelOpen, setNodePanelOpen] = useState(false);
  const [nodeSearch, setNodeSearch] = useState("");
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [multiSelect, setMultiSelect] = useState(false);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [livePositions, setLivePositions] = useState<Record<string, Point>>({});
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [connectionDraft, setConnectionDraftState] = useState<ConnectionDraft | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ fromNodeId: string; position: Point; screen: Point } | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [nodeSizes, setNodeSizes] = useState<Record<string, Point>>({});
  const [boardSize, setBoardSize] = useState({ width: 0, height: 0 });
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const [draftCount, setDraftCount] = useState(1);
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [expandedStacks, setExpandedStacks] = useState<string[]>([]);
  const [busyNodeId, setBusyNodeId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [immersiveMode, setImmersiveMode] = useState(false);
  const [rotatedFallback, setRotatedFallback] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const fullscreenRequestedRef = useRef(false);
  const orientationLockedRef = useRef(false);
  const immersiveRequestIdRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const fitProjectRef = useRef<() => void>(() => undefined);
  const fittedProjectIdRef = useRef<string | null>(null);
  const connectionDraftRef = useRef<ConnectionDraft | null>(null);
  const activePointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchState | null>(null);
  const longPressRef = useRef<{ pointerId: number; startX: number; startY: number; nodeId?: string; marquee?: SelectionBox } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const zoomRepeatTimerRef = useRef<number | null>(null);
  const zoomRepeatedRef = useRef(false);
  const zoomPointerDownRef = useRef(false);
  const zoomStepRef = useRef<(direction: 1 | -1) => void>(() => undefined);
  const videoAbortRef = useRef<AbortController | null>(null);
  const pointerHandlersRef = useRef<{ move: (event: PointerEvent) => void; finish: (event: PointerEvent) => void; cancel: (event: PointerEvent) => void } | null>(null);
  const undoRef = useRef(new Map<string, MobileCanvasProject[]>());
  const redoRef = useRef(new Map<string, MobileCanvasProject[]>());
  const collaborationSyncRef = useRef<(project: MobileCanvasProject) => void>(() => undefined);
  const collaborationCanEditRef = useRef(true);
  const collaborationCanWriteRef = useRef<() => boolean>(() => false);
  const [, setHistoryVersion] = useState(0);

  const enterImmersiveMode = async () => {
    if (!project || immersiveMode) return;
    const requestId = ++immersiveRequestIdRef.current;
    let fullscreenRequest: Promise<void> | undefined;
    const requestedFullscreen = !Capacitor.isNativePlatform() && document.fullscreenEnabled && !document.fullscreenElement;
    if (requestedFullscreen) {
      fullscreenRequestedRef.current = true;
      fullscreenRequest = document.documentElement.requestFullscreen().catch(() => {
        fullscreenRequestedRef.current = false;
      });
    }
    const orientationRequest = enterCanvasLandscape();
    setImmersiveMode(true);
    const [orientationLocked] = await Promise.all([orientationRequest, fullscreenRequest || Promise.resolve()]);
    if (requestId !== immersiveRequestIdRef.current) {
      await exitCanvasLandscape();
      if (requestedFullscreen && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // The browser may have exited fullscreen already.
        }
      }
      return;
    }
    orientationLockedRef.current = orientationLocked;
    setRotatedFallback(!orientationLocked && window.matchMedia("(orientation: portrait)").matches);
  };

  const exitImmersiveMode = async () => {
    immersiveRequestIdRef.current += 1;
    setImmersiveMode(false);
    setRotatedFallback(false);
    orientationLockedRef.current = false;
    await exitCanvasLandscape();
    if (fullscreenRequestedRef.current && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // The browser may have exited fullscreen already.
      }
    }
    fullscreenRequestedRef.current = false;
  };

  const normalizePointer = (clientX: number, clientY: number): Point => rotatedFallback
    ? { x: clientY, y: -clientX }
    : { x: clientX, y: clientY };
  const pointInRect = (clientX: number, clientY: number, rect: DOMRect): Point => rotatedFallback
    ? { x: clientY - rect.top, y: rect.right - clientX }
    : { x: clientX - rect.left, y: clientY - rect.top };
  const boardPointFromPointer = (point: Point, rect: DOMRect): Point => rotatedFallback
    ? { x: point.x - rect.top, y: point.y + rect.right }
    : { x: point.x - rect.left, y: point.y - rect.top };
  const elementBoardBounds = (element: HTMLElement, boardRect: DOMRect) => {
    const rect = element.getBoundingClientRect();
    const points = [
      pointInRect(rect.left, rect.top, boardRect),
      pointInRect(rect.right, rect.top, boardRect),
      pointInRect(rect.left, rect.bottom, boardRect),
      pointInRect(rect.right, rect.bottom, boardRect),
    ];
    return {
      left: Math.min(...points.map((point) => point.x)),
      right: Math.max(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      bottom: Math.max(...points.map((point) => point.y)),
    };
  };

  const setConnectionDraft = (next: ConnectionDraft | null) => {
    connectionDraftRef.current = next;
    setConnectionDraftState(next);
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    longPressRef.current = null;
  };

  const beginCanvasPointer = (event: { pointerId: number; clientX: number; clientY: number }) => {
    const pointers = activePointersRef.current;
    pointers.set(event.pointerId, normalizePointer(event.clientX, event.clientY));
    if (pinchRef.current) return true;
    if (pointers.size < 2 || !boardRef.current) return false;
    const pointerIds = [...pointers.keys()].slice(-2) as [number, number];
    const first = pointers.get(pointerIds[0])!;
    const second = pointers.get(pointerIds[1])!;
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const rect = boardRef.current.getBoundingClientRect();
    const boardMidpoint = boardPointFromPointer(midpoint, rect);
    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    pinchRef.current = {
      pointerIds,
      startDistance: distance,
      startZoom: zoom,
      worldCenter: { x: (boardMidpoint.x - pan.x) / zoom, y: (boardMidpoint.y - pan.y) / zoom },
    };
    collaboration.clearDrag();
    dragRef.current = null;
    clearLongPress();
    setLivePositions({});
    setLiveWidths({});
    setSelectionBox(null);
    setNodeDragging(false);
    return true;
  };

  const armLongPress = (pointerId: number, startX: number, startY: number, nodeId?: string, marquee?: SelectionBox) => {
    clearLongPress();
    longPressRef.current = { pointerId, startX, startY, nodeId, marquee };
    longPressTimerRef.current = window.setTimeout(() => {
      const pending = longPressRef.current;
      if (!pending || pending.pointerId !== pointerId || pinchRef.current) return;
      longPressTimerRef.current = null;
      longPressRef.current = null;
      if (pending.nodeId) {
        setSelectedNodeIds([pending.nodeId]);
        setSelectedConnectionId(null);
      } else if (pending.marquee) {
        dragRef.current = { kind: "marquee", pointerId, startX: pending.marquee.startX, startY: pending.marquee.startY };
        setSelectionBox(pending.marquee);
      }
      setMultiSelect(true);
    }, 480);
  };

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    let cancelled = false;
    void readCanvasProjects().then((saved) => {
      if (cancelled) return;
      projectsRef.current = saved;
      setProjects(saved);
    }).finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const saveProjects = (next: MobileCanvasProject[], syncCollaboration = true) => {
    projectsRef.current = next;
    setProjects(next);
    void writeCanvasProjects(next).catch((error) => {
      logger.error("canvas:save:failed", { error: error instanceof Error ? error.message : "storage_write_failed" });
    });
    if (syncCollaboration) {
      const active = activeProjectIdRef.current ? next.find((item) => item.id === activeProjectIdRef.current) : undefined;
      if (active?.collaboration) collaborationSyncRef.current(active);
    }
  };

  const canWriteProject = (target: MobileCanvasProject | null) => {
    // Check the active collaboration session directly so reconnect and room switches fail closed.
    if (!target?.collaboration || collaborationCanWriteRef.current()) return true;
    setError(collaborationCanEditRef.current ? "协作连接尚未同步，暂时不能修改画布" : "你对这个共享画布只有只读权限");
    return false;
  };

  const updateProject = (id: string, update: (project: MobileCanvasProject) => MobileCanvasProject) => {
    const current = projectsRef.current.find((project) => project.id === id);
    if (!current) return;
    if (!canWriteProject(current)) return;
    const history = undoRef.current.get(id) || [];
    undoRef.current.set(id, [...history, current].slice(-50));
    redoRef.current.delete(id);
    setHistoryVersion((version) => version + 1);
    const updated = { ...update(current), updatedAt: Date.now() };
    saveProjects(projectsRef.current.map((project) => project.id === id ? updated : project));
  };

  const undoCanvas = () => {
    if (!project || !canWriteProject(project)) return;
    const history = undoRef.current.get(project.id) || [];
    const previous = history[history.length - 1];
    if (!previous) return;
    undoRef.current.set(project.id, history.slice(0, -1));
    redoRef.current.set(project.id, [...(redoRef.current.get(project.id) || []), project].slice(-50));
    saveProjects(projectsRef.current.map((item) => item.id === project.id ? { ...previous, updatedAt: Date.now() } : item));
    setSelectedNodeIds([]);
    setSelectedConnectionId(null);
    setHistoryVersion((version) => version + 1);
  };

  const redoCanvas = () => {
    if (!project || !canWriteProject(project)) return;
    const history = redoRef.current.get(project.id) || [];
    const next = history[history.length - 1];
    if (!next) return;
    redoRef.current.set(project.id, history.slice(0, -1));
    undoRef.current.set(project.id, [...(undoRef.current.get(project.id) || []), project].slice(-50));
    saveProjects(projectsRef.current.map((item) => item.id === project.id ? { ...next, updatedAt: Date.now() } : item));
    setSelectedNodeIds([]);
    setSelectedConnectionId(null);
    setHistoryVersion((version) => version + 1);
  };

  const project = projects.find((item) => item.id === activeProjectId) || null;
  const collaboration = useCanvasCollaboration({
    project,
    session,
    onRemoteProject: (remoteProject) => {
      const next = projectsRef.current.map((item) => item.id === remoteProject.id ? { ...remoteProject, collaboration: remoteProject.collaboration || item.collaboration } : item);
      saveProjects(next, false);
    },
  });
  collaborationSyncRef.current = collaboration.applyLocalProject;
  collaborationCanEditRef.current = collaboration.canEdit;
  collaborationCanWriteRef.current = collaboration.canWrite;
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset] as const)), [assets]);
  const selectedNode = project?.nodes.find((node) => node.id === selectedNodeIds[0]) || null;
  const selectedAsset = selectedNode?.type === "asset" ? assetById.get(selectedNode.assetId || "") : undefined;
  const connectedInputs = selectedNode && project
    ? project.connections.filter((connection) => connection.toNodeId === selectedNode.id).flatMap((connection) => {
      const node = project.nodes.find((item) => item.id === connection.fromNodeId);
      if (!node) return [];
      const assetIds = node.assetIds?.length ? node.assetIds : node.assetId ? [node.assetId] : [];
      const linkedAssets = assetIds.map((id) => assetById.get(id)).filter((asset): asset is GeneratedAsset => Boolean(asset));
      const asset = linkedAssets[0];
      const inputKind = asset?.kind || (node.type === "image-generation" ? "image" : node.type === "video-generation" ? "video" : node.type === "text" ? "text" : undefined);
      const kindLabel = node.type === "group" ? "节点分组"
        : node.type === "asset" && !asset ? "素材不可用"
          : inputKind === "image" ? "图片参考"
            : inputKind === "video" ? "视频参考"
              : inputKind === "text" ? "文字参考"
                : "画布节点";
      const title = node.title || (assetIds.length > 1 ? `多项素材 · ${assetIds.length}` : asset?.kind === "text" ? asset.content : asset?.prompt || node.prompt) || (node.type === "asset" ? "未命名素材" : kindLabel);
      return [{ connectionId: connection.id, node, asset, assetCount: assetIds.length, inputKind, kindLabel, title }];
    })
    : [];
  const canUndo = project ? Boolean(undoRef.current.get(project.id)?.length) : false;
  const canRedo = project ? Boolean(redoRef.current.get(project.id)?.length) : false;
  const imageModels = models.filter((model) => model.capability === "image");
  const videoModels = models.filter((model) => model.capability === "video");
  const generationModels = selectedNode?.type === "video-generation" ? videoModels : imageModels;

  useEffect(() => {
    if (!selectedNode) {
      setDraftPrompt("");
      setDraftModel("");
      return;
    }
    setDraftPrompt(selectedNode.prompt || "");
    setDraftModel(selectedNode.model || "");
    setDraftCount(selectedNode.imageCount || 1);
  }, [selectedNode?.id, selectedNode?.imageCount]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const observer = new ResizeObserver(() => setBoardSize({ width: board.clientWidth, height: board.clientHeight }));
    observer.observe(board);
    setBoardSize({ width: board.clientWidth, height: board.clientHeight });
    return () => observer.disconnect();
  }, [activeProjectId]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("canvas-immersive", immersiveMode);
    root.classList.toggle("canvas-immersive-rotated", immersiveMode && rotatedFallback);
  }, [immersiveMode, rotatedFallback]);

  useEffect(() => {
    if (!immersiveMode) return;
    const syncFallback = () => {
      if (!orientationLockedRef.current) {
        setRotatedFallback(window.matchMedia("(orientation: portrait)").matches);
      }
    };
    window.addEventListener("resize", syncFallback);
    window.addEventListener("orientationchange", syncFallback);
    return () => {
      window.removeEventListener("resize", syncFallback);
      window.removeEventListener("orientationchange", syncFallback);
    };
  }, [immersiveMode]);

  useEffect(() => {
    if (!project && immersiveMode) void exitImmersiveMode();
  }, [project?.id, immersiveMode]);

  useEffect(() => () => {
    immersiveRequestIdRef.current += 1;
    document.documentElement.classList.remove("canvas-immersive", "canvas-immersive-rotated");
    orientationLockedRef.current = false;
    void exitCanvasLandscape();
    if (fullscreenRequestedRef.current && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const elements = [...(boardRef.current?.querySelectorAll<HTMLElement>(".canvas-node[data-node-id],.canvas-group-node[data-node-id]") || [])];
    const updateSizes = () => {
      const next = Object.fromEntries(elements.map((element) => [element.dataset.nodeId || "", { x: element.offsetWidth, y: element.offsetHeight }]));
      setNodeSizes((current) => Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([id, size]) => current[id]?.x === size.x && current[id]?.y === size.y) ? current : next);
    };
    if (!elements.length) {
      setNodeSizes({});
      return;
    }
    const observer = new ResizeObserver(updateSizes);
    elements.forEach((element) => observer.observe(element));
    updateSizes();
    return () => observer.disconnect();
  }, [activeProjectId, boardSize.width, boardSize.height, project?.nodes]);

  const createProject = () => {
    videoAbortRef.current?.abort();
    const now = Date.now();
    const next: MobileCanvasProject = { id: makeId("canvas"), title: `无限画布 ${projectsRef.current.length + 1}`, updatedAt: now, nodes: [], connections: [] };
    saveProjects([next, ...projectsRef.current]);
    onProjectNavigation();
    setActiveProjectId(next.id);
    activeProjectIdRef.current = next.id;
    setSelectedNodeIds([]);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setNodePanelOpen(false);
    setMiniMapOpen(false);
    setTool("select");
    setMultiSelect(false);
  };

  const openProject = (id: string) => {
    videoAbortRef.current?.abort();
    onProjectNavigation();
    setActiveProjectId(id);
    activeProjectIdRef.current = id;
    setSelectedNodeIds([]);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setLivePositions({});
    setSelectionBox(null);
    setSelectedConnectionId(null);
    setPendingConnection(null);
    setNodePanelOpen(false);
    setMiniMapOpen(false);
    setTool("select");
    setMultiSelect(false);
    dragRef.current = null;
  };

  const closeProject = () => {
    videoAbortRef.current?.abort();
    onProjectNavigation();
    setActiveProjectId(null);
    activeProjectIdRef.current = null;
    setSelectedNodeIds([]);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setLivePositions({});
    setSelectionBox(null);
    setSelectedConnectionId(null);
    setPendingConnection(null);
    setConnectionDraft(null);
    setNodePanelOpen(false);
    setMiniMapOpen(false);
    setPickerOpen(false);
    setTool("select");
    setMultiSelect(false);
    dragRef.current = null;
  };

  const createSharedProject = async (target: MobileCanvasProject) => {
    if (target.collaboration) {
      if (target.id !== activeProjectIdRef.current) openProject(target.id);
      setCollaborationPanelOpen(true);
      return;
    }
    if (!isCollaborationConfigured()) {
      setCollaborationFailure("协作服务尚未配置，请先设置 VITE_COLLAB_WS_URL");
      return;
    }
    if (collaborationBusy) return;
    setCollaborationBusy(true);
    try {
      const room = await createCollaborationRoom(session.accessToken, target);
      const next = projectsRef.current.map((item) => item.id === target.id ? { ...item, collaboration: { roomId: room.roomId, role: room.role } } : item);
      saveProjects(next);
      if (target.id !== activeProjectIdRef.current) openProject(target.id);
      setCollaborationPanelOpen(true);
      setCollaborationNotice("共享画布已创建");
      setCollaborationFailure("");
    } catch (requestError) {
      setCollaborationFailure(requestError instanceof Error ? requestError.message : "创建共享画布失败");
    } finally {
      setCollaborationBusy(false);
    }
  };

  const joinSharedRoom = async () => {
    const roomId = joinRoomId.trim();
    if (!roomId) return;
    if (!isCollaborationConfigured()) {
      setCollaborationFailure("协作服务尚未配置，请先设置 VITE_COLLAB_WS_URL");
      return;
    }
    if (joinBusy) return;
    setJoinBusy(true);
    try {
      const room = await getCollaborationRoom(session.accessToken, roomId);
      let localProject = projectsRef.current.find((item) => item.collaboration?.roomId === room.roomId);
      if (!localProject) {
        localProject = { id: makeId("shared-canvas"), title: room.title, updatedAt: Date.now(), nodes: [], connections: [], collaboration: { roomId: room.roomId, role: room.role } };
        saveProjects([localProject, ...projectsRef.current], false);
      }
      openProject(localProject.id);
      setCollaborationPanelOpen(true);
      setJoinDialogOpen(false);
      setJoinRoomId("");
      setCollaborationNotice("已加入共享画布");
      setCollaborationFailure("");
    } catch (requestError) {
      setCollaborationFailure(requestError instanceof Error ? requestError.message : "加入共享画布失败");
    } finally {
      setJoinBusy(false);
    }
  };

  const inviteCollaborationMember = async (username: string, role: "editor" | "readonly") => {
    if (!project?.collaboration) throw new Error("当前画布还没有协作房间");
    await addCollaborationMember(session.accessToken, project.collaboration.roomId, username, role);
  };

  const deleteProject = (id: string) => {
    const target = projectsRef.current.find((item) => item.id === id);
    const warning = target?.collaboration
      ? "仅从本机移除此共享画布入口，服务器房间和其他成员的数据不会删除。继续？"
      : "删除这个画布项目？素材库中的图片和视频不会被删除。";
    if (!window.confirm(warning)) return;
    saveProjects(projectsRef.current.filter((item) => item.id !== id));
  };

  const addNode = (type: MobileCanvasNode["type"], position?: Point, connectFromNodeId?: string) => {
    if (!project) return;
    const id = makeId(type);
    const capability = type === "video-generation" ? "video" : "image";
    const node: MobileCanvasNode = {
      id,
      type,
      ...(position || getOpenNodePositions(1, project.nodes)[0]),
      ...(type === "image-generation" || type === "video-generation" ? { model: models.find((model) => model.capability === capability)?.id || "", prompt: "" } : {}),
      ...(type === "text" ? { prompt: "" } : {}),
      ...(type === "group" ? { title: "分组", width: 0.42, height: 0.28 } : {}),
    };
    const nextNodes = [...project.nodes, node];
    if (connectFromNodeId) {
      const connectionError = getConnectionError(connectFromNodeId, id, nextNodes, assetById);
      if (connectionError) {
        setError(connectionError);
        setPendingConnection(null);
        return;
      }
    }
    updateProject(project.id, (current) => ({
      ...current,
      nodes: [...current.nodes, node],
      connections: connectFromNodeId ? [...current.connections, { id: makeId("connection"), fromNodeId: connectFromNodeId, toNodeId: id }] : current.connections,
    }));
    setSelectedNodeIds([id]);
    setSelectedConnectionId(null);
    setPickerOpen(false);
    setPendingConnection(null);
    setError("");
  };

  const addSelectedAssets = () => {
    if (!project || !checkedAssets.length) return;
    const existing = new Set(project.nodes.flatMap((node) => [node.assetId, ...(node.assetIds || [])]).filter((id): id is string => Boolean(id)));
    const additions = checkedAssets.map((id) => assetById.get(id)).filter((asset): asset is GeneratedAsset => asset !== undefined && !existing.has(asset.id));
    const positions = getOpenNodePositions(additions.length, project.nodes);
    const nodes: MobileCanvasNode[] = additions.map((asset, index) => ({ id: makeId("asset"), type: "asset", assetId: asset.id, ...positions[index] }));
    updateProject(project.id, (current) => ({ ...current, nodes: [...current.nodes, ...nodes] }));
    setSelectedNodeIds(nodes.map((node) => node.id));
    setCheckedAssets([]);
    setPickerOpen(false);
    setAssetSearch("");
    const projectId = project.id;
    window.requestAnimationFrame(() => { if (activeProjectIdRef.current !== projectId) return; fitProjectRef.current(); setSelectedNodeIds(nodes.map((node) => node.id)); });
  };

  const positionFor = (node: MobileCanvasNode): Point => livePositions[node.id] || collaboration.remotePositions[node.id] || { x: node.x, y: node.y };

  function getOpenNodePositions(count: number, nodes: MobileCanvasNode[], anchorNodeId?: string) {
    const width = boardRef.current?.clientWidth || boardSize.width;
    const height = boardRef.current?.clientHeight || boardSize.height;
    if (width < 64 || height < 64) {
      const fallbackOffsets = gridSpiralOffsets();
      return Array.from({ length: count }, () => {
        const offset = fallbackOffsets.next().value as Point;
        return { x: 0.42 + offset.x * 0.18, y: 0.3 + offset.y * 0.18 };
      });
    }
    const nodeWidth = Math.min(width - 24, window.innerWidth <= 680 ? 132 : window.innerWidth <= 900 ? 150 : 168);
    const nodeWidthInWorld = nodeWidth;
    const nodeHeightInWorld = 160;
    const gap = 18 / zoom;
    const occupied = nodes.map((node) => {
      const position = positionFor(node);
      return node.type === "group"
        ? { left: position.x * width, top: position.y * height, right: (position.x + (node.width || 0.42)) * width, bottom: (position.y + (node.height || 0.28)) * height }
        : { left: position.x * width, top: position.y * height, right: position.x * width + (nodeSizes[node.id]?.x || node.widthPx || nodeWidth), bottom: position.y * height + (nodeSizes[node.id]?.y || 160) };
    });
    const anchor = nodes.find((node) => node.id === anchorNodeId);
    const anchorPosition = anchor ? positionFor(anchor) : null;
    const anchorSize = anchor ? nodeSizes[anchor.id] || { x: anchor.widthPx || nodeWidth, y: 132 } : null;
    const centerX = anchor && anchorPosition && anchorSize
      ? anchorPosition.x * width + anchorSize.x + gap + nodeWidthInWorld / 2
      : (width / 2 - pan.x) / zoom;
    const centerY = anchor && anchorPosition && anchorSize
      ? anchorPosition.y * height + anchorSize.y / 2
      : (height / 2 - pan.y) / zoom;
    const offsets = gridSpiralOffsets();
    const positions: Point[] = [];
    while (positions.length < count) {
      const offset = offsets.next().value as Point;
      const left = centerX - nodeWidthInWorld / 2 + offset.x * (nodeWidthInWorld + gap);
      const top = centerY - nodeHeightInWorld / 2 + offset.y * (nodeHeightInWorld + gap);
      const candidate = { left, top, right: left + nodeWidthInWorld, bottom: top + nodeHeightInWorld };
      const overlaps = occupied.some((rect) => candidate.left < rect.right + gap && candidate.right + gap > rect.left && candidate.top < rect.bottom + gap && candidate.bottom + gap > rect.top);
      if (overlaps) continue;
      occupied.push(candidate);
      positions.push({ x: left / width, y: top / height });
    }
    return positions;
  }

  const draggedNodePositions = (drag: Extract<DragState, { kind: "nodes" }>, delta: Point) =>
    Object.fromEntries(drag.nodeIds.map((id) => [id, { x: drag.positions[id].x + delta.x, y: drag.positions[id].y + delta.y }]));

  const focusNode = (node: MobileCanvasNode) => {
    if (boardSize.width && boardSize.height) {
      const size = nodeSizes[node.id] || (node.type === "group" ? { x: (node.width || 0.42) * boardSize.width, y: (node.height || 0.28) * boardSize.height } : { x: node.widthPx || 168, y: 108 });
      const position = positionFor(node);
      setPan({ x: boardSize.width / 2 - (position.x * boardSize.width + size.x / 2) * zoom, y: boardSize.height / 2 - (position.y * boardSize.height + size.y / 2) * zoom });
    }
    setSelectedNodeIds([node.id]);
    setSelectedConnectionId(null);
    setNodePanelOpen(false);
  };

  const zoomTo = (requestedZoom: number) => {
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requestedZoom));
    if (boardSize.width && boardSize.height) {
      const center = { x: boardSize.width / 2, y: boardSize.height / 2 };
      const worldCenter = { x: (center.x - pan.x) / zoom, y: (center.y - pan.y) / zoom };
      setPan({ x: center.x - worldCenter.x * nextZoom, y: center.y - worldCenter.y * nextZoom });
    }
    setZoom(nextZoom);
  };

  const stopZoomRepeat = (reset = false) => {
    if (zoomRepeatTimerRef.current !== null) window.clearTimeout(zoomRepeatTimerRef.current);
    zoomRepeatTimerRef.current = null;
    if (reset) zoomRepeatedRef.current = false;
  };

  const loseZoomCapture = () => {
    stopZoomRepeat();
    window.setTimeout(() => {
      if (!zoomPointerDownRef.current) return;
      zoomPointerDownRef.current = false;
      zoomRepeatedRef.current = false;
    }, 250);
  };

  const startZoomRepeat = (direction: 1 | -1, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    capturePointer(event.currentTarget, event.pointerId);
    zoomPointerDownRef.current = true;
    stopZoomRepeat(true);
    const repeat = () => {
      zoomRepeatedRef.current = true;
      zoomStepRef.current(direction);
      if (zoomRepeatTimerRef.current === null) return;
      zoomRepeatTimerRef.current = window.setTimeout(repeat, 90);
    };
    zoomRepeatTimerRef.current = window.setTimeout(repeat, 350);
  };

  const clickZoom = (direction: 1 | -1) => {
    if (zoomPointerDownRef.current) zoomPointerDownRef.current = false;
    if (zoomRepeatedRef.current) {
      zoomRepeatedRef.current = false;
      return;
    }
    zoomStepRef.current(direction);
  };
  zoomStepRef.current = (direction) => {
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, direction === 1 ? zoom * 1.2 : zoom / 1.2));
    if (nextZoom === zoom) {
      stopZoomRepeat(true);
      return;
    }
    zoomTo(nextZoom);
  };

  const fitAllNodes = () => {
    setSelectedNodeIds([]);
    setSelectedConnectionId(null);
    setNodePanelOpen(false);
    setMiniMapOpen(false);
    setPendingConnection(null);
    if (!project?.nodes.length || !boardSize.width || !boardSize.height) {
      setPan({ x: 0, y: 0 });
      setZoom(1);
      return;
    }
    const bounds = project.nodes.reduce((result, node) => {
      const position = positionFor(node);
      const size = nodeSizes[node.id] || (node.type === "group"
        ? { x: (node.width || 0.42) * boardSize.width, y: (node.height || 0.28) * boardSize.height }
        : { x: node.widthPx || 168, y: node.type === "asset" ? 160 : 132 });
      const left = position.x * boardSize.width;
      const top = position.y * boardSize.height;
      return { left: Math.min(result.left, left), top: Math.min(result.top, top), right: Math.max(result.right, left + size.x), bottom: Math.max(result.bottom, top + size.y) };
    }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const padding = 36;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (boardSize.width - padding * 2) / width, (boardSize.height - padding * 2) / height));
    setZoom(nextZoom);
    setPan({ x: boardSize.width / 2 - (bounds.left + width / 2) * nextZoom, y: boardSize.height / 2 - (bounds.top + height / 2) * nextZoom });
  };
  fitProjectRef.current = fitAllNodes;

  useEffect(() => {
    if (!activeProjectId) {
      fittedProjectIdRef.current = null;
      return;
    }
    const board = boardRef.current;
    if (!board || !boardSize.width || !boardSize.height || board.clientWidth !== boardSize.width || board.clientHeight !== boardSize.height || fittedProjectIdRef.current === activeProjectId) return;
    fitProjectRef.current();
    fittedProjectIdRef.current = activeProjectId;
  }, [activeProjectId, boardSize.width, boardSize.height]);

  const startNodeDrag = (node: MobileCanvasNode, event: ReactPointerEvent<HTMLDivElement>, captureTarget?: HTMLElement | null) => {
    if (event.target instanceof Element && event.target.closest("button,input,select,textarea")) return;
    if (!canWriteProject(project)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const lockedBy = collaboration.lockedBy(node.id);
    if (lockedBy) {
      setError(`${lockedBy} 正在移动这个节点`);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    capturePointer(captureTarget || event.currentTarget, event.pointerId);
    if (beginCanvasPointer(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    if (multiSelect) {
      clearLongPress();
      setSelectedConnectionId(null);
      setSelectedNodeIds((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]);
      return;
    }
    const ids = selectedNodeIds.includes(node.id) ? selectedNodeIds : [node.id];
    const deferSelection = event.pointerType === "touch" && !selectedNodeIds.includes(node.id);
    if (!deferSelection) setSelectedNodeIds(ids);
    setSelectedConnectionId(null);
    const board = boardRef.current;
    if (!project || !board) return;
    event.preventDefault();
    const dragIds = new Set(ids);
    ids.forEach((id) => {
      const selected = project.nodes.find((candidate) => candidate.id === id);
      if (selected?.type === "group") project.nodes.filter((candidate) => candidate.groupId === selected.id).forEach((child) => dragIds.add(child.id));
    });
    const positions = Object.fromEntries([...dragIds].map((id) => {
      const item = project.nodes.find((candidate) => candidate.id === id);
      return [id, item ? positionFor(item) : { x: node.x, y: node.y }];
    }));
    const pointer = normalizePointer(event.clientX, event.clientY);
    dragRef.current = { kind: "nodes", pointerId: event.pointerId, nodeIds: [...dragIds], startX: pointer.x, startY: pointer.y, positions, deferSelection, tapNodeId: node.id, moved: false };
    collaboration.beginDrag([...dragIds]);
    setNodeDragging(true);
    if (event.pointerType === "touch") armLongPress(event.pointerId, pointer.x, pointer.y, node.id);
  };

  const startConnection = (nodeId: string, handle: ConnectionHandle, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event.currentTarget, event.pointerId);
    if (!boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const point = pointInRect(event.clientX, event.clientY, rect);
    setSelectedNodeIds([nodeId]);
    setSelectedConnectionId(null);
    setPendingConnection(null);
    setError("");
    setConnectionDraft({ nodeId, handle, pointerId: event.pointerId, point: { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom } });
  };

  const startNodeResize = (node: MobileCanvasNode, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event.currentTarget, event.pointerId);
    if (beginCanvasPointer(event)) return;
    if (!boardRef.current) return;
    dragRef.current = { kind: "resize", pointerId: event.pointerId, nodeId: node.id, startX: normalizePointer(event.clientX, event.clientY).x, startWidth: nodeSizes[node.id]?.x || node.widthPx || 168 };
  };

  const addConnection = (fromNodeId: string, toNodeId: string) => {
    if (!project) return;
    const connectionError = getConnectionError(fromNodeId, toNodeId, project.nodes, assetById);
    if (connectionError) {
      setError(connectionError);
      return;
    }
    const existing = project.connections.find((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId);
    if (existing) {
      setSelectedConnectionId(existing.id);
      setSelectedNodeIds([]);
      setError("这条连线已经存在");
      return;
    }
    const connection = { id: makeId("connection"), fromNodeId, toNodeId };
    updateProject(project.id, (current) => ({ ...current, connections: [...current.connections, connection] }));
    setSelectedConnectionId(connection.id);
    setSelectedNodeIds([]);
    setError("");
  };

  const finishConnection = (event: PointerEvent) => {
    const draft = connectionDraftRef.current;
    if (!draft || draft.pointerId !== event.pointerId || !project || !boardRef.current) return false;
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-canvas-port]");
    setConnectionDraft(null);
    if (hit) {
      const targetId = hit.dataset.nodeId || "";
      const targetHandle = hit.dataset.canvasPort;
      if (targetHandle !== (draft.handle === "source" ? "target" : "source")) {
        setError("请把连线拖到另一节点的对应端口");
        return true;
      }
      const fromNodeId = draft.handle === "source" ? draft.nodeId : targetId;
      const toNodeId = draft.handle === "source" ? targetId : draft.nodeId;
      addConnection(fromNodeId, toNodeId);
      return true;
    }
    if (draft.handle === "source") {
      const rect = boardRef.current.getBoundingClientRect();
      const point = pointInRect(event.clientX, event.clientY, rect);
      const x = Math.max(0.02, Math.min(0.92, (point.x - pan.x) / (boardRef.current.clientWidth * zoom)));
      const y = Math.max(0.03, Math.min(0.84, (point.y - pan.y) / (boardRef.current.clientHeight * zoom)));
      setPendingConnection({ fromNodeId: draft.nodeId, position: { x, y }, screen: point });
    }
    return true;
  };

  const startCanvasDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(".canvas-ui,[data-canvas-port],[data-canvas-resize],[data-connection-id]")) return;
    capturePointer(event.currentTarget, event.pointerId);
    if (beginCanvasPointer(event)) {
      event.preventDefault();
      return;
    }
    const board = event.currentTarget;
    event.preventDefault();
    setPendingConnection(null);
    setSelectedConnectionId(null);
    const rect = board.getBoundingClientRect();
    const point = pointInRect(event.clientX, event.clientY, rect);
    const pointer = normalizePointer(event.clientX, event.clientY);
    const x = point.x;
    const y = point.y;
    const target = event.target instanceof Element ? event.target : null;
    const isBlank = !target?.closest(".canvas-node,.canvas-group-node,[data-connection-id]");
    if (!multiSelect && isBlank) setSelectedNodeIds([]);
    if (tool === "pan" || (!multiSelect && event.pointerType === "touch")) {
      dragRef.current = { kind: "pan", pointerId: event.pointerId, startX: pointer.x, startY: pointer.y, pan };
      if (tool === "select" && !multiSelect && isBlank) {
        const marquee = { startX: x, startY: y, x, y };
        armLongPress(event.pointerId, pointer.x, pointer.y, undefined, marquee);
      }
      return;
    }
    setSelectedNodeIds([]);
    setSelectionBox({ startX: x, startY: y, x, y });
    dragRef.current = { kind: "marquee", pointerId: event.pointerId, startX: x, startY: y };
  };

  const moveCanvasPointer = (event: PointerEvent) => {
    const pointer = normalizePointer(event.clientX, event.clientY);
    if (activePointersRef.current.has(event.pointerId)) activePointersRef.current.set(event.pointerId, pointer);
    const longPress = longPressRef.current;
    if (longPress?.pointerId === event.pointerId && Math.hypot(pointer.x - longPress.startX, pointer.y - longPress.startY) > 8) clearLongPress();
    const pinch = pinchRef.current;
    if (pinch?.pointerIds.includes(event.pointerId)) {
      const first = activePointersRef.current.get(pinch.pointerIds[0]);
      const second = activePointersRef.current.get(pinch.pointerIds[1]);
      const rect = boardRef.current?.getBoundingClientRect();
      if (!first || !second || !rect) return;
      const midpoint = boardPointFromPointer({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }, rect);
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinch.startZoom * distance / pinch.startDistance));
      setZoom(nextZoom);
      setPan({ x: midpoint.x - pinch.worldCenter.x * nextZoom, y: midpoint.y - pinch.worldCenter.y * nextZoom });
      return;
    }
    if (connectionDraftRef.current?.pointerId === event.pointerId) {
      const rect = boardRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = pointInRect(event.clientX, event.clientY, rect);
      setConnectionDraft({ ...connectionDraftRef.current, point: { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom } });
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "pan") {
      setPan({ x: drag.pan.x + pointer.x - drag.startX, y: drag.pan.y + pointer.y - drag.startY });
    } else if (drag.kind === "resize") {
      setLiveWidths((current) => ({ ...current, [drag.nodeId]: Math.max(112, Math.min(300, drag.startWidth + (pointer.x - drag.startX) / zoom)) }));
    } else if (drag.kind === "marquee") {
      const rect = boardRef.current?.getBoundingClientRect();
      if (!rect) return;
      const point = pointInRect(event.clientX, event.clientY, rect);
      setSelectionBox({ startX: drag.startX, startY: drag.startY, x: point.x, y: point.y });
    } else {
      const board = boardRef.current;
      if (!board) return;
      const moved = Math.hypot(pointer.x - drag.startX, pointer.y - drag.startY) > 6;
      if (moved && !drag.moved) {
        drag.moved = true;
        if (drag.deferSelection) {
          setSelectedNodeIds(drag.nodeIds);
          setSelectedConnectionId(null);
        }
      }
      if (!moved) return;
      const dx = (pointer.x - drag.startX) / (board.clientWidth * zoom);
      const dy = (pointer.y - drag.startY) / (board.clientHeight * zoom);
      const positions = draggedNodePositions(drag, { x: dx, y: dy });
      setLivePositions(positions);
      collaboration.publishDrag(drag.nodeIds, positions);
    }
  };

  const finishCanvasPointer = (event: PointerEvent, cancelled = false) => {
    const lastPosition = activePointersRef.current.get(event.pointerId);
    const pointer = normalizePointer(event.clientX, event.clientY);
    const endX = cancelled ? lastPosition?.x ?? pointer.x : pointer.x;
    const endY = cancelled ? lastPosition?.y ?? pointer.y : pointer.y;
    if (longPressRef.current?.pointerId === event.pointerId) clearLongPress();
    activePointersRef.current.delete(event.pointerId);
    if (pinchRef.current?.pointerIds.includes(event.pointerId)) {
      pinchRef.current = null;
      dragRef.current = null;
      setSelectionBox(null);
      setNodeDragging(false);
      setLivePositions({});
      setLiveWidths({});
      const remaining = [...activePointersRef.current.entries()][0];
      if (remaining) dragRef.current = { kind: "pan", pointerId: remaining[0], startX: remaining[1].x, startY: remaining[1].y, pan };
      return;
    }
    if (finishConnection(event)) return;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "resize" && project) {
      const widthPx = Math.max(112, Math.min(300, drag.startWidth + (endX - drag.startX) / zoom));
      if (Math.abs(widthPx - drag.startWidth) > 1) updateProject(project.id, (current) => ({ ...current, nodes: current.nodes.map((node) => node.id === drag.nodeId ? { ...node, widthPx } : node) }));
      setLiveWidths((current) => { const next = { ...current }; delete next[drag.nodeId]; return next; });
    } else if (drag.kind === "nodes" && project) {
      const board = boardRef.current;
      const dx = board ? (endX - drag.startX) / (board.clientWidth * zoom) : 0;
      const dy = board ? (endY - drag.startY) / (board.clientHeight * zoom) : 0;
      const positions = board ? draggedNodePositions(drag, { x: dx, y: dy }) : drag.positions;
      const moved = drag.moved || Math.hypot(endX - drag.startX, endY - drag.startY) > 6;
      if (!moved && drag.deferSelection && drag.tapNodeId) setSelectedNodeIds([drag.tapNodeId]);
      if (moved && (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002)) updateProject(project.id, (current) => ({
        ...current,
        nodes: current.nodes.map((node) => positions[node.id] ? { ...node, ...positions[node.id] } : node),
      }));
      collaboration.clearDrag();
      setLivePositions({});
    } else if (drag.kind === "marquee" && project) {
      const board = boardRef.current;
      const rect = board?.getBoundingClientRect();
      const localEnd = rect ? boardPointFromPointer({ x: endX, y: endY }, rect) : { x: drag.startX, y: drag.startY };
      const localEndX = localEnd.x;
      const localEndY = localEnd.y;
      if (board && (Math.abs(localEndX - drag.startX) > 6 || Math.abs(localEndY - drag.startY) > 6)) {
        const boardRect = board.getBoundingClientRect();
        const box = { left: Math.min(drag.startX, localEndX), right: Math.max(drag.startX, localEndX), top: Math.min(drag.startY, localEndY), bottom: Math.max(drag.startY, localEndY) };
        const selected = [...board.querySelectorAll<HTMLElement>(".canvas-node,.canvas-group-node")].filter((element) => {
          const rect = elementBoardBounds(element, boardRect);
          return rect.right >= box.left && rect.left <= box.right && rect.bottom >= box.top && rect.top <= box.bottom;
        }).map((element) => element.dataset.nodeId || "").filter(Boolean);
        setSelectedNodeIds(selected);
      }
      setSelectionBox(null);
    }
    dragRef.current = null;
    setNodeDragging(false);
  };

  const cancelCanvasPointer = (event: PointerEvent) => {
    if (longPressRef.current?.pointerId === event.pointerId) clearLongPress();
    if (connectionDraftRef.current?.pointerId === event.pointerId) setConnectionDraft(null);
    finishCanvasPointer(event, true);
  };

  pointerHandlersRef.current = { move: moveCanvasPointer, finish: finishCanvasPointer, cancel: cancelCanvasPointer };
  useEffect(() => {
    const move = (event: PointerEvent) => pointerHandlersRef.current?.move(event);
    const finish = (event: PointerEvent) => pointerHandlersRef.current?.finish(event);
    const cancel = (event: PointerEvent) => pointerHandlersRef.current?.cancel(event);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      clearLongPress();
      stopZoomRepeat(true);
      videoAbortRef.current?.abort();
      activePointersRef.current.clear();
      pinchRef.current = null;
    };
  }, []);

  const saveDraft = () => {
    if (!project || !selectedNode) return;
    if (!canWriteProject(project)) return;
    updateProject(project.id, (current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === selectedNode.id ? { ...node, prompt: draftPrompt, ...(node.type === "image-generation" || node.type === "video-generation" ? { model: draftModel } : {}), ...(node.type === "image-generation" ? { imageCount: draftCount } : {}) } : node),
    }));
    setStatus("已保存");
    window.setTimeout(() => setStatus(""), 1600);
  };

  const runGeneration = async () => {
    if (!project || !selectedNode || (selectedNode.type !== "image-generation" && selectedNode.type !== "video-generation")) return;
    if (!canWriteProject(project)) return;
    const nodeId = selectedNode.id;
    const model = draftModel || selectedNode.model || generationModels[0]?.id || "";
    const inputError = project.connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => getConnectionError(connection.fromNodeId, nodeId, project.nodes, assetById)).find(Boolean);
    if (inputError) {
      setError(inputError);
      return;
    }
    const inputs = buildGenerationInputs(nodeId, draftPrompt, project.nodes, project.connections, assetById);
    if (inputs.videoCount) {
      setError("当前手机端接口尚未支持把视频素材作为连线输入，请改用图片或文字节点");
      return;
    }
    if (!model || !inputs.prompt) {
      setError(!model ? "当前没有可用模型" : "先写提示词或连接文字节点");
      return;
    }
    setError("");
    const outputCount = selectedNode.type === "image-generation" ? Math.max(1, Math.min(4, draftCount)) : 1;
    setStatus(inputs.imageCount ? `正在使用 ${inputs.imageCount} 张参考图生成${outputCount > 1 ? ` ${outputCount} 张结果` : ""}…` : selectedNode.type === "video-generation" ? "正在创建视频任务…" : `正在生成 ${outputCount} 张图片…`);
    setBusyNodeId(nodeId);
    updateProject(project.id, (current) => ({ ...current, nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, model, prompt: draftPrompt, ...(node.type === "image-generation" ? { imageCount: outputCount } : {}) } : node) }));
    let videoTaskId = "";
    let videoController: AbortController | null = null;
    try {
      let results: GeneratedAsset[];
      if (selectedNode.type === "image-generation") {
        results = inputs.images.length
          ? await editImage(session.apiToken, model, inputs.prompt, inputs.images, undefined, outputCount, setStatus)
          : await generateImage(session.apiToken, model, inputs.prompt, { size: "1:1", quality: "auto", count: outputCount }, setStatus);
      } else {
        const controller = new AbortController();
        videoController = controller;
        videoAbortRef.current = controller;
        const task = await createVideo(session.apiToken, model, inputs.prompt, inputs.images[0], controller.signal, setStatus);
        videoTaskId = task.id;
        const completedTask = await waitForVideo(session.apiToken, task.id, { signal: controller.signal, onStatus: setStatus });
        results = [{ id: `video-${task.id}`, kind: "video", url: videoResultUrl(completedTask), model, prompt: inputs.prompt, createdAt: Date.now() }];
      }

      const nextAssets = await writeAssets([...results, ...assetsRef.current], session.apiToken);
      assetsRef.current = nextAssets;
      onAssets(nextAssets);
      const currentProject = projectsRef.current.find((item) => item.id === project.id);
      if (currentProject) {
        const createsStack = results.length > 1 && results.every((asset) => asset.kind === "image");
        const outputPositions = getOpenNodePositions(createsStack ? 1 : results.length, currentProject.nodes, nodeId);
        const outputNodes: MobileCanvasNode[] = results.length > 1 && results.every((asset) => asset.kind === "image")
          ? [{ id: makeId("asset-stack"), type: "asset", assetId: results[0].id, assetIds: results.map((asset) => asset.id), ...outputPositions[0] }]
          : results.map((asset, index) => ({ id: makeId("asset-node"), type: "asset", assetId: asset.id, ...outputPositions[index] }));
        updateProject(currentProject.id, (current) => ({
          ...current,
          nodes: [...current.nodes.map((node) => node.id === nodeId ? { ...node, assetId: results[0]?.id } : node), ...outputNodes],
          connections: [...current.connections, ...outputNodes.map((node) => ({ id: makeId("connection"), fromNodeId: nodeId, toNodeId: node.id }))],
        }));
        setSelectedNodeIds(outputNodes.map((node) => node.id));
        const outputProjectId = currentProject.id;
        window.requestAnimationFrame(() => { if (activeProjectIdRef.current !== outputProjectId) return; fitProjectRef.current(); setSelectedNodeIds(outputNodes.map((node) => node.id)); });
      }
      setStatus("生成结果已保存到素材");
    } catch (generationError) {
      if (generationError instanceof ApiError && generationError.code === "aborted") {
        logger.info("generation:video:cancelled", { nodeId, taskId: videoTaskId || undefined });
        setError("");
        setStatus("已取消等待，上游任务可能仍会继续");
      } else {
        logger.error("generation:failed", { mode: selectedNode.type, model, nodeId, taskId: videoTaskId || undefined, error: generationError instanceof Error ? generationError.message : "生成失败", status: generationError instanceof ApiError ? generationError.status : undefined, code: generationError instanceof ApiError ? generationError.code : undefined });
        setError(generationError instanceof Error ? generationError.message : "生成失败");
        setStatus("");
      }
    } finally {
      if (videoAbortRef.current === videoController) videoAbortRef.current = null;
      setBusyNodeId("");
    }
  };

  const deleteSelectedNodes = () => {
    if (!project || !selectedNodeIds.length) return;
    const removed = new Set(selectedNodeIds);
    const removedGroups = new Set(project.nodes.filter((node) => removed.has(node.id) && node.type === "group").map((node) => node.id));
    updateProject(project.id, (current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !removed.has(node.id)).map((node) => removedGroups.has(node.groupId || "") ? { ...node, groupId: undefined } : node),
      connections: current.connections.filter((connection) => !removed.has(connection.fromNodeId) && !removed.has(connection.toNodeId)),
    }));
    setSelectedNodeIds([]);
    setSelectedConnectionId(null);
  };

  const createGroup = () => {
    if (!project || selectedNodeIds.length < 2 || !boardSize.width || !boardSize.height) return;
    const selected = project.nodes.filter((node) => selectedNodeIds.includes(node.id) && node.type !== "group");
    if (selected.length < 2) return;
    const bounds = selected.reduce((result, node) => {
      const position = positionFor(node);
      const size = nodeSizes[node.id] || { x: 140, y: 110 };
      return {
        left: Math.min(result.left, position.x),
        top: Math.min(result.top, position.y),
        right: Math.max(result.right, position.x + size.x / boardSize.width),
        bottom: Math.max(result.bottom, position.y + size.y / boardSize.height),
      };
    }, { left: 1, top: 1, right: 0, bottom: 0 });
    const padX = 22 / boardSize.width;
    const padY = 30 / boardSize.height;
    const group: MobileCanvasNode = {
      id: makeId("group"), type: "group", title: `分组 ${project.nodes.filter((node) => node.type === "group").length + 1}`,
      x: bounds.left - padX, y: bounds.top - padY,
      width: bounds.right - bounds.left + padX * 2, height: bounds.bottom - bounds.top + padY * 2,
    };
    const selectedIds = new Set(selected.map((node) => node.id));
    updateProject(project.id, (current) => ({
      ...current,
      nodes: [...current.nodes.map((node) => selectedIds.has(node.id) ? { ...node, groupId: group.id } : node), group],
    }));
    setSelectedNodeIds([group.id]);
  };

  const deleteSelectedConnection = () => {
    if (!project || !selectedConnectionId) return;
    updateProject(project.id, (current) => ({ ...current, connections: current.connections.filter((connection) => connection.id !== selectedConnectionId) }));
    setSelectedConnectionId(null);
  };

  const openExportOptions = (target: MobileCanvasProject) => {
    setTransferNotice("");
    setTransferFailure("");
    setExportTarget(target);
  };

  const exportProject = async (mode: "json" | "bundle") => {
    if (!exportTarget || transferBusy) return;
    setTransferBusy(true);
    setTransferFailure("");
    try {
      const extension = mode === "json" ? "json" : "zip";
      const blob = mode === "json"
        ? createCanvasJsonBlob(exportTarget)
        : await createCanvasBundleBlob(exportTarget, assetsRef.current, session.apiToken);
      const fileName = canvasFileName(exportTarget, extension);
      await deliverCanvasFile(fileName, blob);
      setExportTarget(null);
      setTransferNotice(mode === "json" ? "画布 JSON 已导出" : "画布与引用素材已打包导出");
    } catch (transferError) {
      const message = transferError instanceof Error ? transferError.message : "画布导出失败";
      setTransferFailure(message);
      logger.warn("canvas:export:failed", { mode, projectId: exportTarget.id, error: message });
    } finally {
      setTransferBusy(false);
    }
  };

  const importCanvasFile = async (file: File) => {
    setTransferNotice("");
    setTransferFailure("");
    setTransferBusy(true);
    try {
      const transfer = await readCanvasTransferFile(file);
      const assetIdMap = new Map<string, string>();
      const importInputs = transfer.assets.map(({ sourceId, asset, blob }) => {
        const id = makeId("asset");
        assetIdMap.set(sourceId, id);
        return { asset: { ...asset, id, inLibrary: true }, blob };
      });
      let availableAssets = assetsRef.current;
      if (importInputs.length) {
        const restored = await storeImportedAssets(importInputs);
        availableAssets = await writeAssets([...restored, ...assetsRef.current], session.apiToken);
        assetsRef.current = availableAssets;
        onAssets(availableAssets);
      }
      const importedProject: MobileCanvasProject = {
        ...transfer.project,
        id: makeId("canvas"),
        title: `${transfer.project.title || "导入画布"}（导入）`,
        updatedAt: Date.now(),
        nodes: transfer.project.nodes.map((node) => ({
          ...node,
          ...(node.assetId ? { assetId: assetIdMap.get(node.assetId) || node.assetId } : {}),
          ...(node.assetIds ? { assetIds: node.assetIds.map((id) => assetIdMap.get(id) || id) } : {}),
        })),
        connections: transfer.project.connections.map((connection) => ({ ...connection })),
      };
      const nextProjects = [importedProject, ...projectsRef.current];
      await writeCanvasProjects(nextProjects);
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      const availableIds = new Set(availableAssets.map((asset) => asset.id));
      const missingCount = [...new Set(importedProject.nodes.flatMap((node) => [node.assetId, ...(node.assetIds || [])]).filter((id): id is string => typeof id === "string" && id.length > 0 && !availableIds.has(id)))].length;
      setTransferNotice(missingCount
        ? `画布已导入，但有 ${missingCount} 个素材引用在本机不存在；可重新关联素材。`
        : `已导入「${importedProject.title}」${importInputs.length ? `，并恢复 ${importInputs.length} 项素材` : ""}`);
    } catch (transferError) {
      const message = transferError instanceof Error ? transferError.message : "画布导入失败";
      setTransferFailure(message);
      logger.warn("canvas:import:failed", { fileName: file.name, error: message });
    } finally {
      setTransferBusy(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const visibleAssets = assets.filter((asset) => asset.inLibrary !== false && (assetFilter === "all" || asset.kind === assetFilter) && `${asset.prompt} ${asset.content || ""} ${asset.model}`.toLowerCase().includes(assetSearch.toLowerCase()));
  const visibleNodes = (project?.nodes || []).filter((node) => {
    const asset = node.assetId ? assetById.get(node.assetId) : undefined;
    return `${node.title || ""} ${node.prompt || ""} ${asset?.prompt || ""} ${asset?.content || ""} ${asset?.model || ""} ${node.type}`.toLowerCase().includes(nodeSearch.trim().toLowerCase());
  });
  const minimapBounds = useMemo(() => {
    const width = boardSize.width || 1;
    const height = boardSize.height || 1;
    if (!project?.nodes.length) return { left: 0, top: 0, right: width, bottom: height };
    return project.nodes.reduce((bounds, node) => {
      const position = positionFor(node);
      const size = node.type === "group"
        ? { x: (node.width || 0.42) * width, y: (node.height || 0.28) * height }
        : nodeSizes[node.id] || { x: node.widthPx || 168, y: node.type === "asset" ? 160 : 132 };
      const left = position.x * width;
      const top = position.y * height;
      return { left: Math.min(bounds.left, left), top: Math.min(bounds.top, top), right: Math.max(bounds.right, left + size.x), bottom: Math.max(bounds.bottom, top + size.y) };
    }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  }, [project?.nodes, nodeSizes, livePositions, boardSize.width, boardSize.height]);
  const minimapWidth = 148;
  const minimapHeight = 104;
  const minimapPadding = 8;
  const minimapWorldWidth = Math.max(1, minimapBounds.right - minimapBounds.left);
  const minimapWorldHeight = Math.max(1, minimapBounds.bottom - minimapBounds.top);
  const minimapScale = Math.min((minimapWidth - minimapPadding * 2) / minimapWorldWidth, (minimapHeight - minimapPadding * 2) / minimapWorldHeight);
  const minimapOffsetX = (minimapWidth - minimapWorldWidth * minimapScale) / 2;
  const minimapOffsetY = (minimapHeight - minimapWorldHeight * minimapScale) / 2;
  const exportDialog = exportTarget && <div className="canvas-transfer-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !transferBusy) setExportTarget(null); }}>
    <section className="canvas-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-transfer-title">
      <div className="canvas-transfer-heading"><div><span className="eyebrow">CANVAS TRANSFER</span><h2 id="canvas-transfer-title">导出画布</h2></div><button type="button" onClick={() => setExportTarget(null)} disabled={transferBusy} aria-label="关闭导出选项"><X size={18} /></button></div>
      <p className="canvas-transfer-description">选择导出内容。完整素材包只包含这张画布引用的素材。</p>
      <button className="canvas-transfer-option" type="button" disabled={transferBusy} onClick={() => void exportProject("json")}><span><FileText size={18} /></span><span><strong>仅 JSON</strong><small>保存节点、连线和素材 ID，不含素材文件</small></span><ChevronRight size={16} /></button>
      <button className="canvas-transfer-option" type="button" disabled={transferBusy} onClick={() => void exportProject("bundle")}><span><Package size={18} /></span><span><strong>完整素材包</strong><small>JSON + 画布引用的图片、视频和文字素材</small></span><ChevronRight size={16} /></button>
      {transferBusy && <div className="canvas-transfer-progress"><LoaderCircle className="spin" size={15} />正在准备文件…</div>}
      {transferFailure && <div className="notice notice-error"><CircleAlert size={15} />{transferFailure}</div>}
      <div className="canvas-transfer-footer"><span>素材总量上限 200 MB</span><button type="button" className="button" onClick={() => setExportTarget(null)} disabled={transferBusy}>取消</button></div>
    </section>
  </div>;

  if (!loaded) return <section className="page canvas-library-page"><LoaderCircle className="spin" size={20} /></section>;
  if (!project) return <section className="page canvas-library-page">
    <input ref={importInputRef} className="canvas-transfer-input" type="file" accept=".json,.zip,application/json,application/zip" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importCanvasFile(file); }} />
    <div className="canvas-library-heading"><div><p className="eyebrow">CANVAS LIBRARY / {projects.length}</p><h1>无限画布</h1></div><div className="canvas-library-actions"><button className="button" onClick={() => { setJoinDialogOpen(true); setJoinRoomId(""); setCollaborationFailure(""); }} disabled={transferBusy}><Link2 size={15} />加入协作</button><button className="button" onClick={() => { setTransferNotice(""); setTransferFailure(""); importInputRef.current?.click(); }} disabled={transferBusy}>{transferBusy ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}{transferBusy ? "处理中…" : "导入画布"}</button><button className="button button-dark" onClick={createProject} disabled={transferBusy}><Plus size={16} />新建画布</button></div></div>
    {transferNotice && <div className="notice notice-success canvas-transfer-notice"><Check size={15} />{transferNotice}</div>}{transferFailure && <div className="notice notice-error canvas-transfer-notice"><CircleAlert size={15} />{transferFailure}</div>}
    <div className="canvas-project-list">{projects.map((item) => <CanvasProjectCard key={item.id} project={item} onOpen={() => openProject(item.id)} onDelete={() => deleteProject(item.id)} onExport={() => openExportOptions(item)} onShare={() => void createSharedProject(item)} />)}{!projects.length && <div className="canvas-project-empty"><Images size={24} /><strong>还没有画布</strong></div>}</div>
    {collaborationNotice && <div className="notice notice-success canvas-transfer-notice"><Wifi size={15} />{collaborationNotice}</div>}{collaborationFailure && <div className="notice notice-error canvas-transfer-notice"><CircleAlert size={15} />{collaborationFailure}</div>}
    {joinDialogOpen && <div className="canvas-collaboration-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !joinBusy) setJoinDialogOpen(false); }}><section className="canvas-collaboration-panel canvas-room-join" role="dialog" aria-modal="true" aria-labelledby="canvas-join-title"><div className="canvas-collaboration-heading"><div><span className="eyebrow">JOIN CANVAS</span><h2 id="canvas-join-title">加入共享画布</h2></div><button type="button" onClick={() => setJoinDialogOpen(false)} disabled={joinBusy} aria-label="关闭加入协作"><X size={18} /></button></div><p className="canvas-collaboration-footnote">请先让画布所有者将你的 NewAPI 用户名添加为成员。</p><input value={joinRoomId} onChange={(event) => setJoinRoomId(event.target.value)} placeholder="输入房间号" autoComplete="off" /><div className="canvas-collaboration-join-actions"><button className="button" type="button" onClick={() => setJoinDialogOpen(false)} disabled={joinBusy}>取消</button><button className="button button-primary" type="button" onClick={() => void joinSharedRoom()} disabled={joinBusy || !joinRoomId.trim()}>{joinBusy ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}加入</button></div></section></div>}
    {exportDialog}
  </section>;

  return <section className="page canvas-workspace-page">
    {collaborationFailure && <div className="notice notice-error canvas-collaboration-notice"><CircleAlert size={14} />{collaborationFailure}</div>}
    <div className="canvas-workspace-header canvas-ui">
      <button className="canvas-back-button" onClick={closeProject} aria-label="返回画布列表"><ArrowLeft size={19} /></button>
      <div className="canvas-workspace-title"><strong>{project.title}</strong><small>{project.nodes.length} 个节点</small></div>
      <button className={`canvas-header-icon ${nodePanelOpen ? "is-active" : ""}`} onClick={() => setNodePanelOpen((open) => !open)} title="节点列表" aria-label="节点列表"><List size={16} /></button>
      <button className="canvas-header-icon" onClick={() => openExportOptions(project)} title="导出画布" aria-label="导出画布"><Download size={16} /></button>
      <button className={`canvas-header-icon ${project.collaboration ? "is-active" : ""}`} onClick={() => void createSharedProject(project)} title="多人协作" aria-label="多人协作"><UsersRound size={16} /></button>
      <button className="canvas-header-icon canvas-immersive-toggle" onClick={() => void enterImmersiveMode()} title="横屏沉浸" aria-label="进入横屏沉浸模式" aria-pressed={immersiveMode}><Maximize2 size={16} /></button>
      <button className="canvas-header-action" onClick={() => setPickerOpen(true)}><Images size={16} /><span>素材</span></button>
    </div>
    {immersiveMode && <div className="canvas-immersive-exit canvas-ui"><span><Maximize2 size={14} />横屏画布</span><button type="button" onClick={() => void exitImmersiveMode()}><Minimize2 size={15} />退出横屏</button></div>}
    {project.collaboration && collaborationPanelOpen && <CollaborationPanel roomId={project.collaboration.roomId} role={project.collaboration.role} status={collaboration.status} connectionError={collaboration.error} presence={collaboration.presence} onClose={() => setCollaborationPanelOpen(false)} onRetry={collaboration.retry} onInvite={inviteCollaborationMember} />}
    <div ref={boardRef} className={`canvas-board canvas-project-board ${tool === "pan" ? "pan-mode" : ""}`} onPointerDown={startCanvasDrag}>
      <div className="canvas-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        {project.nodes.filter((node) => node.type === "group").map((group) => {
          const selected = selectedNodeIds.includes(group.id);
          const children = project.nodes.filter((node) => node.groupId === group.id);
          const position = positionFor(group);
          return <div key={group.id} data-node-id={group.id} className={`canvas-group-node ${selected ? "is-selected" : ""}`} style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, width: `${(group.width || 0.42) * 100}%`, height: `${(group.height || 0.28) * 100}%` }} onPointerDown={(event) => startNodeDrag(group, event)}>
            <span>{group.title || "分组"} · {children.length}</span>
            {selected && canProvideGenerationInput(group, project.nodes, assetById) && <button className="canvas-node-port canvas-node-port--source" data-canvas-port="source" data-node-id={group.id} aria-label="分组输出端口" title="拖动以连接分组" onPointerDown={(event) => startConnection(group.id, "source", event)}><i /></button>}
          </div>;
        })}
        <svg className="canvas-connections" viewBox={`0 0 ${boardSize.width || 1} ${boardSize.height || 1}`} preserveAspectRatio="none">
          {project.connections.map((connection) => {
            const from = project.nodes.find((node) => node.id === connection.fromNodeId);
            const to = project.nodes.find((node) => node.id === connection.toNodeId);
            if (!from || !to) return null;
            const fromPoint = positionFor(from);
            const toPoint = positionFor(to);
            const fromSize = nodeSizes[from.id] || { x: 132, y: 108 };
            const toSize = nodeSizes[to.id] || { x: 132, y: 108 };
            const x1 = fromPoint.x * boardSize.width + fromSize.x;
            const x2 = toPoint.x * boardSize.width;
            const y1 = fromPoint.y * boardSize.height + fromSize.y / 2;
            const y2 = toPoint.y * boardSize.height + toSize.y / 2;
            const path = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
            return <g key={connection.id} data-connection-id={connection.id} className={selectedConnectionId === connection.id ? "is-selected" : ""} onPointerDown={(event) => { event.stopPropagation(); setSelectedConnectionId(connection.id); setSelectedNodeIds([]); }}>
              <path d={path} className="canvas-connection-hit" />
              <path d={path} className="canvas-connection-line" />
            </g>;
          })}
          {connectionDraft && (() => {
            const node = project.nodes.find((item) => item.id === connectionDraft.nodeId);
            if (!node) return null;
            const position = positionFor(node);
            const size = nodeSizes[node.id] || { x: 132, y: 108 };
            const x1 = position.x * boardSize.width + (connectionDraft.handle === "source" ? size.x : 0);
            const y1 = position.y * boardSize.height + size.y / 2;
            const x2 = connectionDraft.point.x;
            const y2 = connectionDraft.point.y;
            return <path className="canvas-connection-preview" d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`} />;
          })()}
        </svg>
        {project.nodes.filter((node) => node.type !== "group").map((node) => {
          const position = positionFor(node);
          const asset = node.assetId ? assetById.get(node.assetId) : undefined;
          const selected = selectedNodeIds.includes(node.id);
          const Icon = node.type === "video-generation" ? Video : node.type === "image-generation" ? ImageIcon : node.type === "text" ? Type : asset?.kind === "video" ? Video : ImageIcon;
          return <div key={node.id} role="group" aria-label={node.type === "asset" ? "素材节点" : node.type === "text" ? "文字节点" : node.type === "video-generation" ? "视频生成节点" : "图片生成节点"} data-node-id={node.id} className={`canvas-node ${node.type === "asset" ? "canvas-asset-node" : "canvas-generation-node"} ${selected ? "is-selected" : ""} ${dragRef.current?.kind === "nodes" && dragRef.current.nodeIds.includes(node.id) ? "is-dragging" : ""}`} style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, width: `${liveWidths[node.id] || node.widthPx || 168}px` }} onPointerDown={(event) => startNodeDrag(node, event)} onDragStart={(event) => event.preventDefault()}>
          {node.type === "asset" ? node.assetIds && node.assetIds.length > 1 ? <ImageStackNode assets={node.assetIds.map((id) => assetById.get(id)).filter((item): item is GeneratedAsset => Boolean(item))} primaryId={node.assetId || node.assetIds[0]} expanded={expandedStacks.includes(node.id)} openLeft={pan.x + position.x * boardSize.width * zoom + (liveWidths[node.id] || node.widthPx || 168) * zoom > boardSize.width / 2} onToggle={() => setExpandedStacks((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id])} onChoose={(assetId) => updateProject(project.id, (current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, assetId } : item) }))} /> : asset?.kind === "image" ? <img className="canvas-node-image" src={asset.url} alt={asset.prompt} draggable={false} /> : asset?.kind === "video" ? <video className="canvas-node-image" src={asset.url} muted playsInline preload="metadata" draggable={false} /> : asset?.kind === "text" ? <div className="canvas-node-text"><Type size={20} /><p>{asset.content || asset.prompt}</p></div> : <div className="canvas-node-missing"><CircleAlert size={18} /><span>素材不可用</span></div> : node.type === "text" ? <div className="canvas-node-text"><Type size={20} /><p>{node.prompt || "文字"}</p></div> : <div className="canvas-node-generator"><span className="canvas-node-type"><Icon size={14} />{node.type === "video-generation" ? "视频生成" : "图片生成"}</span><p>{node.prompt || "未填写提示词"}</p><small>{node.model || "选择模型"}</small></div>}
            <span className="canvas-node-select-mark">{selected && <Check size={12} />}</span>
            {(selected || connectionDraft) && (node.type === "image-generation" || node.type === "video-generation") && <button type="button" className="canvas-node-port canvas-node-port--target" data-canvas-port="target" data-node-id={node.id} aria-label="节点输入端口" title="拖动连线到此处接收输入" onPointerDown={(event) => startConnection(node.id, "target", event)}><i /></button>}
            {(selected || connectionDraft) && canProvideGenerationInput(node, project.nodes, assetById) && <button type="button" className="canvas-node-port canvas-node-port--source" data-canvas-port="source" data-node-id={node.id} aria-label="节点输出端口" title="拖动连线到生成节点" onPointerDown={(event) => startConnection(node.id, "source", event)}><i /></button>}
            {selected && <button type="button" className="canvas-node-resize-handle" data-canvas-resize aria-label="调整节点宽度" title="拖动调整节点尺寸" onPointerDown={(event) => startNodeResize(node, event)} />}
          </div>;
        })}
      </div>
      {selectionBox && <div className="canvas-selection-box" style={{ left: Math.min(selectionBox.startX, selectionBox.x), top: Math.min(selectionBox.startY, selectionBox.y), width: Math.abs(selectionBox.x - selectionBox.startX), height: Math.abs(selectionBox.y - selectionBox.startY) }} />}
      {nodePanelOpen && <div className="canvas-node-panel canvas-ui">
        <div className="canvas-node-panel-heading"><strong>节点</strong><button onClick={() => setNodePanelOpen(false)} aria-label="关闭节点列表"><X size={15} /></button></div>
        <label className="canvas-node-search"><Search size={14} /><input value={nodeSearch} onChange={(event) => setNodeSearch(event.target.value)} placeholder="搜索节点" /></label>
        <div className="canvas-node-list">{visibleNodes.map((node) => {
          const asset = node.assetId ? assetById.get(node.assetId) : undefined;
          const label = node.title || (asset?.kind === "text" ? asset.content : asset?.prompt) || (node.type === "image-generation" ? "生图节点" : node.type === "video-generation" ? "视频节点" : node.type === "group" ? "分组" : node.type === "text" ? node.prompt || "文字节点" : "素材节点");
          return <button key={node.id} className={selectedNodeIds.includes(node.id) ? "is-selected" : ""} onClick={() => focusNode(node)}><span className="canvas-node-list-icon">{node.type === "group" ? <Layers size={15} /> : node.type === "text" || asset?.kind === "text" ? <Type size={15} /> : node.type === "video-generation" || asset?.kind === "video" ? <Video size={15} /> : <ImageIcon size={15} />}</span><span><strong>{label}</strong><small>{node.type === "group" ? `${project.nodes.filter((child) => child.groupId === node.id).length} 个成员` : node.type === "asset" ? asset?.kind || "素材" : node.type}</small></span></button>;
        })}{!visibleNodes.length && <p>没有匹配节点</p>}</div>
      </div>}
      {miniMapOpen && <div className="canvas-minimap canvas-ui" style={{ top: nodePanelOpen ? "auto" : 9, bottom: nodePanelOpen ? 9 : "auto" }} onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const pointer = pointInRect(event.clientX, event.clientY, rect);
        const point = {
          x: minimapBounds.left + Math.max(0, Math.min(1, (pointer.x - minimapOffsetX) / (minimapWorldWidth * minimapScale))) * minimapWorldWidth,
          y: minimapBounds.top + Math.max(0, Math.min(1, (pointer.y - minimapOffsetY) / (minimapWorldHeight * minimapScale))) * minimapWorldHeight,
        };
        setPan({ x: boardSize.width / 2 - point.x * zoom, y: boardSize.height / 2 - point.y * zoom });
      }}>
        {project.nodes.map((node) => {
          const position = positionFor(node);
          const left = position.x * boardSize.width;
          const top = position.y * boardSize.height;
          const size = node.type === "group"
            ? { x: (node.width || 0.42) * boardSize.width, y: (node.height || 0.28) * boardSize.height }
            : nodeSizes[node.id] || { x: node.widthPx || 168, y: node.type === "asset" ? 160 : 132 };
          return <span key={node.id} className={`canvas-minimap-node ${node.type === "group" ? "is-group" : node.type === "asset" ? "is-asset" : ""}`} style={{ left: minimapOffsetX + (left - minimapBounds.left) * minimapScale, top: minimapOffsetY + (top - minimapBounds.top) * minimapScale, width: Math.max(4, size.x * minimapScale), height: Math.max(4, size.y * minimapScale) }} />;
        })}
        <span className="canvas-minimap-viewport" style={{ left: minimapOffsetX + ((-pan.x / zoom) - minimapBounds.left) * minimapScale, top: minimapOffsetY + ((-pan.y / zoom) - minimapBounds.top) * minimapScale, width: boardSize.width / zoom * minimapScale, height: boardSize.height / zoom * minimapScale }} />
      </div>}
      {!project.nodes.length && <div className="canvas-board-empty canvas-ui"><Images size={25} /><strong>空白画布</strong><button onClick={() => setPickerOpen(true)}>从素材库选择</button></div>}
      {pendingConnection && <div className="canvas-connection-create canvas-ui" style={{ left: Math.min(pendingConnection.screen.x, boardSize.width - 165), top: Math.min(pendingConnection.screen.y, boardSize.height - 130) }}>
        <div><span>新建并连接</span><button aria-label="关闭" onClick={() => setPendingConnection(null)}><X size={15} /></button></div>
        <button onClick={() => addNode("image-generation", pendingConnection.position, pendingConnection.fromNodeId)}><ImageIcon size={15} />生图</button>
        <button onClick={() => addNode("video-generation", pendingConnection.position, pendingConnection.fromNodeId)}><Video size={15} />视频</button>
      </div>}
      {error && !selectedNode && <div className="canvas-board-error notice notice-error canvas-ui" role="alert"><CircleAlert size={14} /><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError("")}><X size={14} /></button></div>}
      <div className="canvas-board-meta">{project.nodes.length} 节点 · {project.connections.length} 连线</div>
    </div>
    {selectedNode && !nodePanelOpen && !nodeDragging && <div className="canvas-inspector canvas-ui">
      <div className="canvas-inspector-heading"><div><span className="eyebrow">{selectedNode.type === "image-generation" ? "IMAGE GENERATION" : selectedNode.type === "video-generation" ? "VIDEO GENERATION" : selectedNode.type === "text" ? "TEXT NODE" : selectedNode.type === "group" ? "NODE GROUP" : "CANVAS NODE"}</span><strong>{selectedNode.type === "asset" ? selectedAsset?.kind === "video" ? "视频素材" : selectedAsset?.kind === "text" ? "文字素材" : "图片素材" : selectedNode.type === "image-generation" ? "生图节点" : selectedNode.type === "video-generation" ? "视频节点" : selectedNode.type === "group" ? selectedNode.title || "画布分组" : selectedNode.type === "text" ? "文字节点" : "素材节点"}</strong></div><button onClick={() => setSelectedNodeIds([])} aria-label="关闭节点设置"><X size={17} /></button></div>
      {selectedNode.type === "group" ? <div className="canvas-asset-details">包含 {project.nodes.filter((node) => node.groupId === selectedNode.id).length} 个节点。拖动分组可移动全部成员。</div> : selectedNode.type === "image-generation" || selectedNode.type === "video-generation" ? <>
        {connectedInputs.length > 0 && <div className="canvas-connected-inputs">
          <div className="canvas-connected-inputs-heading"><span>参考输入</span><small>{connectedInputs.length} 项已连接</small></div>
          <div className="canvas-connected-input-list">{connectedInputs.map(({ connectionId, node, asset, assetCount, inputKind, kindLabel, title }) => <article className="canvas-connected-input-card" key={connectionId}>
            <span className="canvas-connected-input-thumb">{asset?.kind === "image" && asset.url ? <img src={asset.url} alt="" /> : asset?.kind === "video" && asset.url ? <video src={asset.url} muted playsInline preload="metadata" /> : node.type === "group" ? <Layers size={17} /> : inputKind === "video" ? <Video size={17} /> : inputKind === "text" ? <Type size={17} /> : <ImageIcon size={17} />}</span>
            <span className="canvas-connected-input-copy"><small>{kindLabel}{assetCount > 1 ? ` · ${assetCount} 项` : ""}</small><strong title={title}>{title}</strong></span>
          </article>)}</div>
        </div>}
        <div className="canvas-inspector-field"><span>模型</span><OptionPicker label="模型" value={draftModel || selectedNode.model || generationModels[0]?.id || ""} onChange={setDraftModel} placeholder="暂无可用模型" disabled={!generationModels.length} options={generationModels.map((model) => ({ value: model.id, label: model.id }))} /></div>
        {selectedNode.type === "image-generation" && <div className="canvas-inspector-field"><span>生成张数</span><OptionPicker label="生成张数" value={String(draftCount)} onChange={(value) => setDraftCount(Number(value))} options={[1, 2, 3, 4].map((count) => ({ value: String(count), label: `${count} 张` }))} /></div>}
        <div className="canvas-inspector-field"><div className="canvas-prompt-heading"><span>提示词</span><button type="button" onClick={() => setPromptLibraryOpen(true)}><BookOpen size={13} />提示词库</button></div><textarea value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} placeholder="描述你想生成的画面" rows={3} /></div>
        <div className="canvas-inspector-actions">{busyNodeId === selectedNode.id && selectedNode.type === "video-generation" && <button className="button button-ghost" onClick={() => videoAbortRef.current?.abort()}>取消等待</button>}<button className="button button-ghost" onClick={saveDraft}>保存</button><button className="button button-primary" onClick={() => void runGeneration()} disabled={busyNodeId === selectedNode.id}>{busyNodeId === selectedNode.id ? <LoaderCircle className="spin" size={15} /> : selectedNode.type === "video-generation" ? <Video size={15} /> : <ImageIcon size={15} />}{busyNodeId === selectedNode.id ? status || "处理中" : "生成"}</button></div>
      </> : selectedNode.type === "text" ? <><textarea className="canvas-text-editor" value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} placeholder="输入文字内容" rows={3} /><button className="button button-primary" onClick={saveDraft}>保存文字</button></> : <div className="canvas-asset-details"><span>{selectedAsset?.model || "素材"}</span><p>{selectedAsset?.content || selectedAsset?.prompt || "素材可能已从素材库删除。"}</p></div>}
      {error && <div className="notice notice-error"><CircleAlert size={14} />{error}</div>}
      {status && !error && busyNodeId !== selectedNode.id && <p className="canvas-generation-status">{status}</p>}
    </div>}
    {selectedNodeIds.length > 1 && <div className="canvas-selection-count canvas-ui">已选择 {selectedNodeIds.length} 个节点</div>}
    <div className="canvas-toolbar canvas-ui" aria-label="画布工具">
      <button className={tool === "select" ? "is-active" : ""} onClick={() => { setTool("select"); setMultiSelect(false); }} title="选择并拖动节点"><MousePointer2 size={17} /><span>选择</span></button>
      <button className={tool === "pan" ? "is-active" : ""} onClick={() => { setTool("pan"); setMultiSelect(false); }} title="平移画布"><Hand size={17} /><span>平移</span></button>
      <button onClick={undoCanvas} disabled={!canUndo} title="撤销"><Undo2 size={17} /><span>撤销</span></button>
      <button onClick={redoCanvas} disabled={!canRedo} title="重做"><Redo2 size={17} /><span>重做</span></button>
      <button onPointerDown={(event) => startZoomRepeat(-1, event)} onPointerUp={() => stopZoomRepeat()} onPointerCancel={() => { stopZoomRepeat(true); zoomPointerDownRef.current = false; }} onLostPointerCapture={loseZoomCapture} onClick={() => clickZoom(-1)} disabled={zoom <= MIN_ZOOM} title="缩小"><ZoomOut size={17} /><span>缩小</span></button>
      <button onPointerDown={(event) => startZoomRepeat(1, event)} onPointerUp={() => stopZoomRepeat()} onPointerCancel={() => { stopZoomRepeat(true); zoomPointerDownRef.current = false; }} onLostPointerCapture={loseZoomCapture} onClick={() => clickZoom(1)} disabled={zoom >= MAX_ZOOM} title="放大"><ZoomIn size={17} /><span>放大</span></button>
        <span className="canvas-zoom-readout" aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button onClick={fitAllNodes} title="适配全部节点"><Scan size={17} /><span>全景</span></button>
      <button onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }} title="复位视图"><LocateFixed size={17} /><span>复位</span></button>
      <button className={miniMapOpen ? "is-active" : ""} onClick={() => setMiniMapOpen((open) => !open)} title="显示小地图"><MapIcon size={17} /><span>小地图</span></button>
      <button className={multiSelect ? "is-active" : ""} onClick={() => { setMultiSelect((value) => !value); setTool("select"); }} title="多选节点"><Check size={17} /><span>多选</span></button>
      <button onClick={() => { setPickerOpen(true); setCheckedAssets([]); }} title="从素材库添加节点"><Images size={17} /><span>素材</span></button>
      <button onClick={() => addNode("text")} title="添加文字节点"><Type size={17} /><span>文字</span></button>
      <button onClick={() => addNode("image-generation")} title="添加图片生成节点"><ImageIcon size={17} /><span>生图</span></button>
      <button onClick={() => addNode("video-generation")} title="添加视频生成节点"><Video size={17} /><span>视频</span></button>
      <button disabled={selectedNodeIds.length < 2} onClick={createGroup} title="将选中节点分组"><Layers size={17} /><span>分组</span></button>
      <button disabled={!selectedConnectionId} onClick={deleteSelectedConnection} title="删除选中连线"><Link2 size={17} /><span>删线</span></button>
      <button disabled={!selectedNodeIds.length} onClick={deleteSelectedNodes} title="从画布移除选中节点"><Trash2 size={17} /><span>移除</span></button>
    </div>
    {pickerOpen && <div className="canvas-picker-scrim canvas-ui" onPointerDown={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
      <section className="canvas-asset-picker">
        <div className="canvas-picker-heading"><div><span className="eyebrow">ASSET LIBRARY / {assets.length}</span><strong>选择素材</strong></div><button onClick={() => setPickerOpen(false)} aria-label="关闭素材选择"><X size={19} /></button></div>
        <label className="canvas-asset-search"><Search size={16} /><input value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} placeholder="搜索素材" /></label>
        <div className="canvas-asset-filters">{(["all", "image", "video", "text"] as const).map((filter) => <button key={filter} className={assetFilter === filter ? "is-active" : ""} onClick={() => setAssetFilter(filter)}>{filter === "all" ? "全部" : filter === "image" ? "图片" : filter === "video" ? "视频" : "文字"}</button>)}</div>
        <div className="canvas-asset-list">{visibleAssets.map((asset) => <button key={asset.id} className={`canvas-asset-option ${checkedAssets.includes(asset.id) ? "is-checked" : ""}`} onClick={() => setCheckedAssets((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id])}>
          <span className="canvas-asset-thumb">{asset.kind === "image" ? <img src={asset.url} alt="" /> : asset.kind === "video" ? <video src={asset.url} muted playsInline preload="metadata" /> : <Type size={17} />}</span><span className="canvas-asset-copy"><strong>{asset.kind === "text" ? asset.content || asset.prompt || asset.model : asset.prompt || asset.model}</strong><small>{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文字"} · {asset.model}</small></span><span className="canvas-asset-check">{checkedAssets.includes(asset.id) && <Check size={14} />}</span>
        </button>)}{!visibleAssets.length && <div className="canvas-assets-empty">没有匹配的素材</div>}</div>
        <div className="canvas-picker-footer"><span>已选 {checkedAssets.length} 项</span><button className="button button-primary" disabled={!checkedAssets.length} onClick={addSelectedAssets}><Plus size={15} />添加到画布</button></div>
      </section>
    </div>}
    {transferNotice && <div className="canvas-transfer-toast notice notice-success"><Check size={15} />{transferNotice}<button type="button" onClick={() => setTransferNotice("")} aria-label="关闭提示"><X size={14} /></button></div>}
    {promptLibraryOpen && <PromptLibrary onClose={() => setPromptLibraryOpen(false)} onSelect={(value) => setDraftPrompt((current) => current.trim() ? `${current.trim()}\n\n${value}` : value)} />}
    {exportDialog}
  </section>;
}
