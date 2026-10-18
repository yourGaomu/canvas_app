import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, BookOpen, Check, ChevronRight, CircleAlert, Download, Hand, Image as ImageIcon, Images, Layers, Link2, List, LocateFixed, LoaderCircle, Map as MapIcon, MousePointer2, Plus, Redo2, Search, Trash2, Type, Undo2, Video, X, ZoomIn, ZoomOut } from "lucide-react";
import { createVideo, editImage, generateImage, getVideo } from "../api/generation";
import { readCanvasProjects, writeAssets, writeCanvasProjects } from "../storage";
import type { AuthSession, GeneratedAsset, MobileCanvasNode, MobileCanvasProject, Model } from "../types";
import { buildGenerationInputs, canProvideGenerationInput, getConnectionError } from "./canvas-graph";
import ImageStackNode from "./ImageStackNode";
import PromptLibrary from "../components/PromptLibrary";

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
type ConnectionDraft = { nodeId: string; handle: ConnectionHandle; point: Point };
type DragState =
  | { kind: "nodes"; pointerId: number; nodeIds: string[]; startX: number; startY: number; positions: Record<string, Point> }
  | { kind: "pan"; pointerId: number; startX: number; startY: number; pan: Point }
  | { kind: "resize"; pointerId: number; nodeId: string; startX: number; startWidth: number }
  | { kind: "marquee"; pointerId: number; startX: number; startY: number };

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function initialPosition(index: number): Point {
  return { x: index % 2 ? 0.48 : 0.06, y: 0.12 + Math.floor(index / 2) % 4 * 0.2 };
}

function CanvasProjectCard({ project, onOpen, onDelete }: { project: MobileCanvasProject; onOpen: () => void; onDelete: () => void }) {
  return <article className="canvas-project-card">
    <button className="canvas-project-open" onClick={onOpen}>
      <span className="canvas-project-icon"><Images size={20} /></span>
      <span className="canvas-project-info"><strong>{project.title}</strong><small>{project.nodes.length} 个节点 · {project.connections.length} 条连线</small><small>更新于 {new Date(project.updatedAt).toLocaleString()}</small></span>
      <ChevronRight size={17} />
    </button>
    <button className="canvas-project-delete" aria-label={`删除${project.title}`} onClick={onDelete}><Trash2 size={15} /></button>
  </article>;
}

export default function CanvasView({ session, models, assets, onAssets, onProjectNavigation }: Props) {
  const [projects, setProjects] = useState<MobileCanvasProject[]>([]);
  const projectsRef = useRef<MobileCanvasProject[]>([]);
  const assetsRef = useRef(assets);
  const [loaded, setLoaded] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetFilter, setAssetFilter] = useState<"all" | GeneratedAsset["kind"]>("all");
  const [checkedAssets, setCheckedAssets] = useState<string[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
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
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const connectionDraftRef = useRef<ConnectionDraft | null>(null);
  const undoRef = useRef(new Map<string, MobileCanvasProject[]>());
  const redoRef = useRef(new Map<string, MobileCanvasProject[]>());
  const [, setHistoryVersion] = useState(0);

  const setConnectionDraft = (next: ConnectionDraft | null) => {
    connectionDraftRef.current = next;
    setConnectionDraftState(next);
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

  const saveProjects = (next: MobileCanvasProject[]) => {
    projectsRef.current = next;
    setProjects(next);
    void writeCanvasProjects(next);
  };

  const updateProject = (id: string, update: (project: MobileCanvasProject) => MobileCanvasProject) => {
    const current = projectsRef.current.find((project) => project.id === id);
    if (!current) return;
    const history = undoRef.current.get(id) || [];
    undoRef.current.set(id, [...history, current].slice(-50));
    redoRef.current.delete(id);
    setHistoryVersion((version) => version + 1);
    const updated = { ...update(current), updatedAt: Date.now() };
    saveProjects(projectsRef.current.map((project) => project.id === id ? updated : project));
  };

  const undoCanvas = () => {
    if (!project) return;
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
    if (!project) return;
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
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset] as const)), [assets]);
  const selectedNode = project?.nodes.find((node) => node.id === selectedNodeIds[0]) || null;
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
    const now = Date.now();
    const next: MobileCanvasProject = { id: makeId("canvas"), title: `无限画布 ${projectsRef.current.length + 1}`, updatedAt: now, nodes: [], connections: [] };
    saveProjects([next, ...projectsRef.current]);
    onProjectNavigation();
    setActiveProjectId(next.id);
    setSelectedNodeIds([]);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setNodePanelOpen(false);
    setMiniMapOpen(false);
    setTool("select");
    setMultiSelect(false);
  };

  const openProject = (id: string) => {
    onProjectNavigation();
    setActiveProjectId(id);
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
    onProjectNavigation();
    setActiveProjectId(null);
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

  const deleteProject = (id: string) => {
    if (!window.confirm("删除这个画布项目？素材库中的图片和视频不会被删除。")) return;
    saveProjects(projectsRef.current.filter((item) => item.id !== id));
  };

  const addNode = (type: MobileCanvasNode["type"], position?: Point, connectFromNodeId?: string) => {
    if (!project) return;
    const id = makeId(type);
    const capability = type === "video-generation" ? "video" : "image";
    const node: MobileCanvasNode = {
      id,
      type,
      ...(position || initialPosition(project.nodes.length)),
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
    const existing = new Set(project.nodes.map((node) => node.assetId));
    const additions = checkedAssets.map((id) => assetById.get(id)).filter((asset): asset is GeneratedAsset => asset !== undefined && !existing.has(asset.id));
    const nodes: MobileCanvasNode[] = additions.map((asset, index) => ({ id: makeId("asset"), type: "asset", assetId: asset.id, ...initialPosition(project.nodes.length + index) }));
    updateProject(project.id, (current) => ({ ...current, nodes: [...current.nodes, ...nodes] }));
    setSelectedNodeIds(nodes.map((node) => node.id));
    setCheckedAssets([]);
    setPickerOpen(false);
    setAssetSearch("");
  };

  const positionFor = (node: MobileCanvasNode): Point => livePositions[node.id] || { x: node.x, y: node.y };

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

  const startNodeDrag = (node: MobileCanvasNode, event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === "pan") {
      setSelectedNodeIds([node.id]);
      return;
    }
    event.stopPropagation();
    if (multiSelect) {
      setSelectedConnectionId(null);
      setSelectedNodeIds((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]);
      return;
    }
    const ids = selectedNodeIds.includes(node.id) ? selectedNodeIds : [node.id];
    setSelectedNodeIds(ids);
    setSelectedConnectionId(null);
    if (!project) return;
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
    dragRef.current = { kind: "nodes", pointerId: event.pointerId, nodeIds: [...dragIds], startX: event.clientX, startY: event.clientY, positions };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startConnection = (nodeId: string, handle: ConnectionHandle, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    setSelectedNodeIds([nodeId]);
    setSelectedConnectionId(null);
    setPendingConnection(null);
    setError("");
    setConnectionDraft({ nodeId, handle, point: { x: (event.clientX - rect.left - pan.x) / zoom, y: (event.clientY - rect.top - pan.y) / zoom } });
    boardRef.current.setPointerCapture(event.pointerId);
  };

  const startNodeResize = (node: MobileCanvasNode, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!boardRef.current) return;
    dragRef.current = { kind: "resize", pointerId: event.pointerId, nodeId: node.id, startX: event.clientX, startWidth: nodeSizes[node.id]?.x || node.widthPx || 168 };
    boardRef.current.setPointerCapture(event.pointerId);
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
      return;
    }
    const connection = { id: makeId("connection"), fromNodeId, toNodeId };
    updateProject(project.id, (current) => ({ ...current, connections: [...current.connections, connection] }));
    setSelectedConnectionId(connection.id);
    setSelectedNodeIds([]);
    setError("");
  };

  const finishConnection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const draft = connectionDraftRef.current;
    if (!draft || !project || !boardRef.current) return false;
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
      const x = Math.max(0.02, Math.min(0.92, (event.clientX - rect.left - pan.x) / (rect.width * zoom)));
      const y = Math.max(0.03, Math.min(0.84, (event.clientY - rect.top - pan.y) / (rect.height * zoom)));
      setPendingConnection({ fromNodeId: draft.nodeId, position: { x, y }, screen: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
    }
    return true;
  };

  const startCanvasDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(".canvas-ui,[data-canvas-port],[data-canvas-resize],[data-connection-id]")) return;
    const board = event.currentTarget;
    setPendingConnection(null);
    setSelectedConnectionId(null);
    if (tool === "pan") {
      dragRef.current = { kind: "pan", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, pan };
      board.setPointerCapture(event.pointerId);
      return;
    }
    setSelectedNodeIds([]);
    const rect = board.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setSelectionBox({ startX: x, startY: y, x, y });
    dragRef.current = { kind: "marquee", pointerId: event.pointerId, startX: x, startY: y };
    board.setPointerCapture(event.pointerId);
  };

  const moveCanvasPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (connectionDraftRef.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      setConnectionDraft({ ...connectionDraftRef.current, point: { x: (event.clientX - rect.left - pan.x) / zoom, y: (event.clientY - rect.top - pan.y) / zoom } });
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "pan") {
      setPan({ x: drag.pan.x + event.clientX - drag.startX, y: drag.pan.y + event.clientY - drag.startY });
    } else if (drag.kind === "resize") {
      setLiveWidths((current) => ({ ...current, [drag.nodeId]: Math.max(112, Math.min(300, drag.startWidth + (event.clientX - drag.startX) / zoom)) }));
    } else if (drag.kind === "marquee") {
      const rect = event.currentTarget.getBoundingClientRect();
      setSelectionBox({ startX: drag.startX, startY: drag.startY, x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      const board = boardRef.current;
      if (!board) return;
      const dx = (event.clientX - drag.startX) / (board.clientWidth * zoom);
      const dy = (event.clientY - drag.startY) / (board.clientHeight * zoom);
      setLivePositions(Object.fromEntries(drag.nodeIds.map((id) => {
        const start = drag.positions[id];
        return [id, { x: Math.max(0, Math.min(0.98, start.x + dx)), y: Math.max(0, Math.min(0.98, start.y + dy)) }];
      })));
    }
  };

  const finishCanvasPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (finishConnection(event)) return;
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "resize" && project) {
      const widthPx = Math.max(112, Math.min(300, drag.startWidth + (event.clientX - drag.startX) / zoom));
      if (Math.abs(widthPx - drag.startWidth) > 1) updateProject(project.id, (current) => ({ ...current, nodes: current.nodes.map((node) => node.id === drag.nodeId ? { ...node, widthPx } : node) }));
      setLiveWidths((current) => { const next = { ...current }; delete next[drag.nodeId]; return next; });
    } else if (drag.kind === "nodes" && project) {
      const board = boardRef.current;
      const dx = board ? (event.clientX - drag.startX) / (board.clientWidth * zoom) : 0;
      const dy = board ? (event.clientY - drag.startY) / (board.clientHeight * zoom) : 0;
      const positions = Object.fromEntries(drag.nodeIds.map((id) => {
        const start = drag.positions[id];
        return [id, { x: Math.max(0, Math.min(0.98, start.x + dx)), y: Math.max(0, Math.min(0.98, start.y + dy)) }];
      }));
      if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) updateProject(project.id, (current) => ({
        ...current,
        nodes: current.nodes.map((node) => positions[node.id] ? { ...node, ...positions[node.id] } : node),
      }));
      setLivePositions({});
    } else if (drag.kind === "marquee" && project) {
      const board = boardRef.current;
      const rect = board?.getBoundingClientRect();
      const endX = rect ? event.clientX - rect.left : drag.startX;
      const endY = rect ? event.clientY - rect.top : drag.startY;
      if (board && (Math.abs(endX - drag.startX) > 6 || Math.abs(endY - drag.startY) > 6)) {
        const boardRect = board.getBoundingClientRect();
        const box = { left: boardRect.left + Math.min(drag.startX, endX), right: boardRect.left + Math.max(drag.startX, endX), top: boardRect.top + Math.min(drag.startY, endY), bottom: boardRect.top + Math.max(drag.startY, endY) };
        const selected = [...board.querySelectorAll<HTMLElement>(".canvas-node,.canvas-group-node")].filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.right >= box.left && rect.left <= box.right && rect.bottom >= box.top && rect.top <= box.bottom;
        }).map((element) => element.dataset.nodeId || "").filter(Boolean);
        setSelectedNodeIds(selected);
      }
      setSelectionBox(null);
    }
    dragRef.current = null;
  };

  const saveDraft = () => {
    if (!project || !selectedNode) return;
    updateProject(project.id, (current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === selectedNode.id ? { ...node, prompt: draftPrompt, ...(node.type === "image-generation" || node.type === "video-generation" ? { model: draftModel } : {}), ...(node.type === "image-generation" ? { imageCount: draftCount } : {}) } : node),
    }));
    setStatus("已保存");
    window.setTimeout(() => setStatus(""), 1600);
  };

  const runGeneration = async () => {
    if (!project || !selectedNode || (selectedNode.type !== "image-generation" && selectedNode.type !== "video-generation")) return;
    const nodeId = selectedNode.id;
    const model = draftModel || selectedNode.model || generationModels[0]?.id || "";
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
    try {
      let results: GeneratedAsset[];
      if (selectedNode.type === "image-generation") {
        results = inputs.images.length
          ? await editImage(session.apiToken, model, inputs.prompt, inputs.images, undefined, outputCount)
          : await generateImage(session.apiToken, model, inputs.prompt, { size: "1:1", quality: "auto", count: outputCount });
      } else {
        const task = await createVideo(session.apiToken, model, inputs.prompt, inputs.images[0]);
        let completed: GeneratedAsset | null = null;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 1200 : 2500));
          const next = await getVideo(session.apiToken, task.id);
          setStatus(`视频处理中${next.progress ? ` ${next.progress}%` : "…"}`);
          if (next.status === "completed" || next.url) {
            completed = { id: `video-${task.id}`, kind: "video", url: next.url || `https://mikasa.icu/v1/videos/${encodeURIComponent(task.id)}/content`, model, prompt: inputs.prompt, createdAt: Date.now() };
            break;
          }
          if (["failed", "cancelled", "error"].includes(String(next.status).toLowerCase())) throw new Error(next.error || "视频生成失败");
        }
        if (!completed) throw new Error("视频任务超时，请稍后在素材中查看");
        results = [completed];
      }

      const nextAssets = [...results, ...assetsRef.current].slice(0, 60);
      assetsRef.current = nextAssets;
      onAssets(nextAssets);
      await writeAssets(nextAssets);
      const currentProject = projectsRef.current.find((item) => item.id === project.id);
      if (currentProject) {
        const source = currentProject.nodes.find((node) => node.id === nodeId);
        const outputPosition = { x: source && source.x < 0.42 ? 0.48 : 0.06, y: Math.min(0.78, (source?.y || 0.12) + 0.2) };
        const outputNodes: MobileCanvasNode[] = results.length > 1 && results.every((asset) => asset.kind === "image")
          ? [{ id: makeId("asset-stack"), type: "asset", assetId: results[0].id, assetIds: results.map((asset) => asset.id), ...outputPosition }]
          : results.map((asset, index) => ({ id: makeId("asset-node"), type: "asset", assetId: asset.id, x: outputPosition.x, y: Math.min(0.92, outputPosition.y + index * 0.14) }));
        updateProject(currentProject.id, (current) => ({
          ...current,
          nodes: [...current.nodes.map((node) => node.id === nodeId ? { ...node, assetId: results[0]?.id } : node), ...outputNodes],
          connections: [...current.connections, ...outputNodes.map((node) => ({ id: makeId("connection"), fromNodeId: nodeId, toNodeId: node.id }))],
        }));
        setSelectedNodeIds(outputNodes.map((node) => node.id));
      }
      setStatus("生成结果已保存到素材");
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "生成失败");
      setStatus("");
    } finally {
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
      x: Math.max(0, bounds.left - padX), y: Math.max(0, bounds.top - padY),
      width: Math.min(1, bounds.right - bounds.left + padX * 2), height: Math.min(1, bounds.bottom - bounds.top + padY * 2),
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

  const exportProject = () => {
    if (!project) return;
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.title || "canvas"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const visibleAssets = assets.filter((asset) => (assetFilter === "all" || asset.kind === assetFilter) && `${asset.prompt} ${asset.model}`.toLowerCase().includes(assetSearch.toLowerCase()));
  const visibleNodes = (project?.nodes || []).filter((node) => {
    const asset = node.assetId ? assetById.get(node.assetId) : undefined;
    return `${node.title || ""} ${node.prompt || ""} ${asset?.prompt || ""} ${asset?.model || ""} ${node.type}`.toLowerCase().includes(nodeSearch.trim().toLowerCase());
  });

  if (!loaded) return <section className="page canvas-library-page"><LoaderCircle className="spin" size={20} /></section>;
  if (!project) return <section className="page canvas-library-page">
    <div className="canvas-library-heading"><div><p className="eyebrow">CANVAS LIBRARY / {projects.length}</p><h1>无限画布</h1></div><button className="button button-dark" onClick={createProject}><Plus size={16} />新建画布</button></div>
    <div className="canvas-project-list">{projects.map((item) => <CanvasProjectCard key={item.id} project={item} onOpen={() => openProject(item.id)} onDelete={() => deleteProject(item.id)} />)}{!projects.length && <div className="canvas-project-empty"><Images size={24} /><strong>还没有画布</strong></div>}</div>
  </section>;

  return <section className="page canvas-workspace-page">
    <div className="canvas-workspace-header canvas-ui">
      <button className="canvas-back-button" onClick={closeProject} aria-label="返回画布列表"><ArrowLeft size={19} /></button>
      <div className="canvas-workspace-title"><strong>{project.title}</strong><small>{project.nodes.length} 个节点</small></div>
      <button className={`canvas-header-icon ${nodePanelOpen ? "is-active" : ""}`} onClick={() => setNodePanelOpen((open) => !open)} title="节点列表" aria-label="节点列表"><List size={16} /></button>
      <button className="canvas-header-icon" onClick={exportProject} title="导出画布" aria-label="导出画布"><Download size={16} /></button>
      <button className="canvas-header-action" onClick={() => setPickerOpen(true)}><Images size={16} /><span>素材</span></button>
    </div>
    <div ref={boardRef} className={`canvas-board canvas-project-board ${tool === "pan" ? "pan-mode" : ""}`} onPointerDown={startCanvasDrag} onPointerMove={moveCanvasPointer} onPointerUp={finishCanvasPointer} onPointerCancel={() => { setConnectionDraft(null); dragRef.current = null; setLivePositions({}); setLiveWidths({}); setSelectionBox(null); }}>
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
          return <div key={node.id} role="group" aria-label={node.type === "asset" ? "素材节点" : node.type === "text" ? "文字节点" : node.type === "video-generation" ? "视频生成节点" : "图片生成节点"} data-node-id={node.id} className={`canvas-node ${node.type === "asset" ? "canvas-asset-node" : "canvas-generation-node"} ${selected ? "is-selected" : ""} ${dragRef.current?.kind === "nodes" && dragRef.current.nodeIds.includes(node.id) ? "is-dragging" : ""}`} style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, width: `${liveWidths[node.id] || node.widthPx || 168}px` }} onPointerDown={(event) => startNodeDrag(node, event)}>
          {node.type === "asset" ? node.assetIds && node.assetIds.length > 1 ? <ImageStackNode assets={node.assetIds.map((id) => assetById.get(id)).filter((item): item is GeneratedAsset => Boolean(item))} primaryId={node.assetId || node.assetIds[0]} expanded={expandedStacks.includes(node.id)} openLeft={pan.x + position.x * boardSize.width * zoom + (liveWidths[node.id] || node.widthPx || 168) * zoom > boardSize.width / 2} onToggle={() => setExpandedStacks((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id])} onChoose={(assetId) => updateProject(project.id, (current) => ({ ...current, nodes: current.nodes.map((item) => item.id === node.id ? { ...item, assetId } : item) }))} /> : asset?.kind === "image" ? <img className="canvas-node-image" src={asset.url} alt={asset.prompt} draggable={false} /> : asset?.kind === "video" ? <video className="canvas-node-image" src={asset.url} muted playsInline preload="metadata" draggable={false} /> : asset?.kind === "text" ? <div className="canvas-node-text"><Type size={20} /><p>{asset.prompt}</p></div> : <div className="canvas-node-missing"><CircleAlert size={18} /><span>素材不可用</span></div> : node.type === "text" ? <div className="canvas-node-text"><Type size={20} /><p>{node.prompt || "文字"}</p></div> : <div className="canvas-node-generator"><span className="canvas-node-type"><Icon size={14} />{node.type === "video-generation" ? "视频生成" : "图片生成"}</span><p>{node.prompt || "未填写提示词"}</p><small>{node.model || "选择模型"}</small></div>}
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
          const label = node.title || asset?.prompt || (node.type === "image-generation" ? "生图节点" : node.type === "video-generation" ? "视频节点" : node.type === "group" ? "分组" : node.type === "text" ? node.prompt || "文字节点" : "素材节点");
          return <button key={node.id} className={selectedNodeIds.includes(node.id) ? "is-selected" : ""} onClick={() => focusNode(node)}><span className="canvas-node-list-icon">{node.type === "group" ? <Layers size={15} /> : node.type === "text" || asset?.kind === "text" ? <Type size={15} /> : node.type === "video-generation" || asset?.kind === "video" ? <Video size={15} /> : <ImageIcon size={15} />}</span><span><strong>{label}</strong><small>{node.type === "group" ? `${project.nodes.filter((child) => child.groupId === node.id).length} 个成员` : node.type === "asset" ? asset?.kind || "素材" : node.type}</small></span></button>;
        })}{!visibleNodes.length && <p>没有匹配节点</p>}</div>
      </div>}
      {miniMapOpen && <div className="canvas-minimap canvas-ui" style={{ top: nodePanelOpen ? "auto" : 9, bottom: nodePanelOpen ? 9 : "auto" }} onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const point = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
        setPan({ x: boardSize.width / 2 - point.x * boardSize.width * zoom, y: boardSize.height / 2 - point.y * boardSize.height * zoom });
      }}>
        {project.nodes.map((node) => {
          const position = positionFor(node);
          return <span key={node.id} className={`canvas-minimap-node ${node.type === "group" ? "is-group" : node.type === "asset" ? "is-asset" : ""}`} style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, width: node.type === "group" ? `${(node.width || 0.42) * 100}%` : undefined, height: node.type === "group" ? `${(node.height || 0.28) * 100}%` : undefined }} />;
        })}
        <span className="canvas-minimap-viewport" style={{ left: `${Math.max(0, Math.min(100 - 100 / zoom, -pan.x / Math.max(1, boardSize.width * zoom) * 100))}%`, top: `${Math.max(0, Math.min(100 - 100 / zoom, -pan.y / Math.max(1, boardSize.height * zoom) * 100))}%`, width: `${Math.min(100, 100 / zoom)}%`, height: `${Math.min(100, 100 / zoom)}%` }} />
      </div>}
      {!project.nodes.length && <div className="canvas-board-empty canvas-ui"><Images size={25} /><strong>空白画布</strong><button onClick={() => setPickerOpen(true)}>从素材库选择</button></div>}
      {pendingConnection && <div className="canvas-connection-create canvas-ui" style={{ left: Math.min(pendingConnection.screen.x, boardSize.width - 165), top: Math.min(pendingConnection.screen.y, boardSize.height - 130) }}>
        <div><span>新建并连接</span><button aria-label="关闭" onClick={() => setPendingConnection(null)}><X size={15} /></button></div>
        <button onClick={() => addNode("image-generation", pendingConnection.position, pendingConnection.fromNodeId)}><ImageIcon size={15} />生图</button>
        <button onClick={() => addNode("video-generation", pendingConnection.position, pendingConnection.fromNodeId)}><Video size={15} />视频</button>
      </div>}
      <div className="canvas-board-meta">{project.nodes.length} 节点 · {project.connections.length} 连线</div>
    </div>
    {selectedNode && !nodePanelOpen && <div className="canvas-inspector canvas-ui">
      <div className="canvas-inspector-heading"><div><span className="eyebrow">{selectedNode.type === "image-generation" ? "IMAGE GENERATION" : selectedNode.type === "video-generation" ? "VIDEO GENERATION" : selectedNode.type === "text" ? "TEXT NODE" : selectedNode.type === "group" ? "NODE GROUP" : "CANVAS NODE"}</span><strong>{selectedNode.type === "asset" ? assetById.get(selectedNode.assetId || "")?.kind === "video" ? "视频素材" : "图片素材" : selectedNode.type === "image-generation" ? "生图节点" : selectedNode.type === "video-generation" ? "视频节点" : selectedNode.type === "group" ? selectedNode.title || "画布分组" : selectedNode.type === "text" ? "文字节点" : "素材节点"}</strong></div><button onClick={() => setSelectedNodeIds([])} aria-label="关闭节点设置"><X size={17} /></button></div>
      {selectedNode.type === "group" ? <div className="canvas-asset-details">包含 {project.nodes.filter((node) => node.groupId === selectedNode.id).length} 个节点。拖动分组可移动全部成员。</div> : selectedNode.type === "image-generation" || selectedNode.type === "video-generation" ? <>
        {project.connections.filter((connection) => connection.toNodeId === selectedNode.id).length > 0 && <div className="canvas-connected-inputs"><span>已连接输入</span>{project.connections.filter((connection) => connection.toNodeId === selectedNode.id).map((connection) => {
          const input = project.nodes.find((node) => node.id === connection.fromNodeId);
          const type = input?.type === "asset" ? assetById.get(input.assetId || "")?.kind || "素材" : input?.title || input?.type;
          return input ? <span key={connection.id}>{type}{(input.assetIds?.length || 0) > 1 ? ` · ${input.assetIds?.length} 张` : ""}</span> : null;
        })}</div>}
        <label className="canvas-inspector-field"><span>模型</span><select value={draftModel || selectedNode.model || generationModels[0]?.id || ""} onChange={(event) => setDraftModel(event.target.value)}><option value="">暂无可用模型</option>{generationModels.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}</select></label>
        {selectedNode.type === "image-generation" && <label className="canvas-inspector-field"><span>生成张数</span><select value={draftCount} onChange={(event) => setDraftCount(Number(event.target.value))}>{[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count} 张</option>)}</select></label>}
        <div className="canvas-inspector-field"><div className="canvas-prompt-heading"><span>提示词</span><button type="button" onClick={() => setPromptLibraryOpen(true)}><BookOpen size={13} />提示词库</button></div><textarea value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} placeholder="描述你想生成的画面" rows={3} /></div>
        <div className="canvas-inspector-actions"><button className="button button-ghost" onClick={saveDraft}>保存</button><button className="button button-primary" onClick={() => void runGeneration()} disabled={busyNodeId === selectedNode.id}>{busyNodeId === selectedNode.id ? <LoaderCircle className="spin" size={15} /> : selectedNode.type === "video-generation" ? <Video size={15} /> : <ImageIcon size={15} />}{busyNodeId === selectedNode.id ? status || "处理中" : "生成"}</button></div>
      </> : selectedNode.type === "text" ? <><textarea className="canvas-text-editor" value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} placeholder="输入文字内容" rows={3} /><button className="button button-primary" onClick={saveDraft}>保存文字</button></> : <div className="canvas-asset-details"><span>{assetById.get(selectedNode.assetId || "")?.model || "素材"}</span><p>{assetById.get(selectedNode.assetId || "")?.prompt || "素材可能已从素材库删除。"}</p></div>}
      {error && <div className="notice notice-error"><CircleAlert size={14} />{error}</div>}
      {status && !error && busyNodeId !== selectedNode.id && <p className="canvas-generation-status">{status}</p>}
    </div>}
    {selectedNodeIds.length > 1 && <div className="canvas-selection-count canvas-ui">已选择 {selectedNodeIds.length} 个节点</div>}
    <div className="canvas-toolbar canvas-ui" aria-label="画布工具">
      <button className={tool === "select" ? "is-active" : ""} onClick={() => { setTool("select"); setMultiSelect(false); }} title="选择并拖动节点"><MousePointer2 size={17} /><span>选择</span></button>
      <button className={tool === "pan" ? "is-active" : ""} onClick={() => { setTool("pan"); setMultiSelect(false); }} title="平移画布"><Hand size={17} /><span>平移</span></button>
      <button onClick={undoCanvas} disabled={!canUndo} title="撤销"><Undo2 size={17} /><span>撤销</span></button>
      <button onClick={redoCanvas} disabled={!canRedo} title="重做"><Redo2 size={17} /><span>重做</span></button>
      <button onClick={() => setZoom((value) => Math.max(0.55, Math.round((value - 0.1) * 100) / 100))} title="缩小"><ZoomOut size={17} /><span>缩小</span></button>
      <button onClick={() => setZoom((value) => Math.min(2.2, Math.round((value + 0.1) * 100) / 100))} title="放大"><ZoomIn size={17} /><span>放大</span></button>
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
          <span className="canvas-asset-thumb">{asset.kind === "image" ? <img src={asset.url} alt="" /> : asset.kind === "video" ? <video src={asset.url} muted playsInline preload="metadata" /> : <Type size={17} />}</span><span className="canvas-asset-copy"><strong>{asset.prompt || asset.model}</strong><small>{asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "文字"} · {asset.model}</small></span><span className="canvas-asset-check">{checkedAssets.includes(asset.id) && <Check size={14} />}</span>
        </button>)}{!visibleAssets.length && <div className="canvas-assets-empty">没有匹配的素材</div>}</div>
        <div className="canvas-picker-footer"><span>已选 {checkedAssets.length} 项</span><button className="button button-primary" disabled={!checkedAssets.length} onClick={addSelectedAssets}><Plus size={15} />添加到画布</button></div>
      </section>
    </div>}
    {promptLibraryOpen && <PromptLibrary onClose={() => setPromptLibraryOpen(false)} onSelect={(value) => setDraftPrompt((current) => current.trim() ? `${current.trim()}\n\n${value}` : value)} />}
  </section>;
}
