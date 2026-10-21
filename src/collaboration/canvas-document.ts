import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { MobileCanvasConnection, MobileCanvasNode, MobileCanvasProject } from "../types";

const LOCAL_ORIGIN = "mobile-app";
type RecordMap = Y.Map<Y.Map<unknown>>;
type Point = { x: number; y: number };
export type CanvasPresence = { clientId: number; user: { id: number; name: string }; nodeIds: string[]; positions: Record<string, Point> };
export type CanvasCollaborationEvent = "connecting" | "connected" | "syncing" | "disconnected" | "synced" | "error";

function valuesFor<T>(map: RecordMap): T[] {
  return [...map.values()].map((value) => Object.fromEntries(value.entries()) as T);
}

function equalValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeRecord<T extends { id: string }>(records: RecordMap, values: T[]) {
  const ids = new Set(values.map((value) => value.id));
  for (const id of records.keys()) if (!ids.has(id)) records.delete(id);
  for (const value of values) {
    let record = records.get(value.id);
    if (!record) {
      record = new Y.Map<unknown>();
      records.set(value.id, record);
    }
    const fields = Object.fromEntries(Object.entries(value));
    for (const key of record.keys()) if (!(key in fields)) record.delete(key);
    for (const [key, field] of Object.entries(fields)) {
      if (!equalValue(record.get(key), field)) record.set(key, field);
    }
  }
}

export class CanvasCollaborationDocument {
  private readonly document = new Y.Doc();
  private readonly nodes = this.document.getMap<Y.Map<unknown>>("nodes") as RecordMap;
  private readonly connections = this.document.getMap<Y.Map<unknown>>("connections") as RecordMap;
  private readonly meta = this.document.getMap<unknown>("meta");
  private readonly provider: HocuspocusProvider;
  private changeListener: ((project: MobileCanvasProject) => void) | null = null;
  private statusListener: ((event: CanvasCollaborationEvent) => void) | null = null;
  private presenceListener: ((presence: CanvasPresence[]) => void) | null = null;
  private localProjectId = "";

  constructor(roomId: string, token: string, websocketUrl: string) {
    this.provider = new HocuspocusProvider({
      url: websocketUrl,
      name: roomId,
      document: this.document,
      token,
      flushDelay: 50,
      onStatus: ({ status }) => {
        const value = String(status);
        this.statusListener?.(value === "connecting" ? "connecting" : value === "connected" ? "connected" : "disconnected");
      },
      onSynced: ({ state }) => { if (state) this.statusListener?.("synced"); },
      onUnsyncedChanges: ({ number }) => this.statusListener?.(number > 0 ? "syncing" : "synced"),
      onAuthenticationFailed: () => this.statusListener?.("error"),
      onAwarenessUpdate: () => this.presenceListener?.(this.getPresence()),
    });
    this.nodes.observeDeep((_events, transaction) => this.emitChange(transaction.origin));
    this.connections.observeDeep((_events, transaction) => this.emitChange(transaction.origin));
    this.meta.observe((_event, transaction) => this.emitChange(transaction.origin));
  }

  get localClientId() {
    return this.provider.awareness?.clientID;
  }

  bindProjectId(projectId: string) {
    this.localProjectId = projectId;
  }

  onChange(listener: (project: MobileCanvasProject) => void) {
    this.changeListener = listener;
    return () => { if (this.changeListener === listener) this.changeListener = null; };
  }

  onStatus(listener: (event: CanvasCollaborationEvent) => void) {
    this.statusListener = listener;
    return () => { if (this.statusListener === listener) this.statusListener = null; };
  }

  onPresence(listener: (presence: CanvasPresence[]) => void) {
    this.presenceListener = listener;
    listener(this.getPresence());
    return () => { if (this.presenceListener === listener) this.presenceListener = null; };
  }

  setPresence(user: { id: number; name: string }) {
    this.provider.awareness?.setLocalStateField("user", user);
  }

  setDragging(nodeIds: string[], positions: Record<string, Point>) {
    this.provider.awareness?.setLocalStateField("drag", { nodeIds, positions });
  }

  clearDragging() {
    this.provider.awareness?.setLocalStateField("drag", null);
  }

  getPresence(): CanvasPresence[] {
    const awareness = this.provider.awareness;
    if (!awareness) return [];
    return [...awareness.getStates()].flatMap(([clientId, state]) => {
      const rawUser = state.user;
      if (!rawUser || typeof rawUser !== "object") return [];
      const user = rawUser as Record<string, unknown>;
      const id = Number(user.id);
      const name = typeof user.name === "string" ? user.name.trim() : "";
      if (!Number.isSafeInteger(id) || !name) return [];
      const rawDrag = state.drag && typeof state.drag === "object" ? state.drag as Record<string, unknown> : {};
      const nodeIds = Array.isArray(rawDrag.nodeIds) ? rawDrag.nodeIds.filter((value): value is string => typeof value === "string") : [];
      const rawPositions = rawDrag.positions && typeof rawDrag.positions === "object" ? rawDrag.positions as Record<string, unknown> : {};
      const positions: Record<string, Point> = {};
      for (const [nodeId, value] of Object.entries(rawPositions)) {
        if (!value || typeof value !== "object") continue;
        const point = value as Record<string, unknown>;
        if (typeof point.x === "number" && Number.isFinite(point.x) && typeof point.y === "number" && Number.isFinite(point.y)) positions[nodeId] = { x: point.x, y: point.y };
      }
      return [{ clientId, user: { id, name }, nodeIds, positions }];
    });
  }

  isInitialized() {
    return this.meta.get("initialized") === true;
  }

  seed(project: MobileCanvasProject) {
    if (this.isInitialized()) return;
    this.writeProject(project, true);
  }

  applyLocalProject(project: MobileCanvasProject) {
    this.writeProject(project, false);
  }

  snapshot(fallback: MobileCanvasProject): MobileCanvasProject {
    return {
      ...fallback,
      title: String(this.meta.get("title") || fallback.title),
      updatedAt: Number(this.meta.get("updatedAt") || fallback.updatedAt),
      nodes: valuesFor<MobileCanvasNode>(this.nodes),
      connections: valuesFor<MobileCanvasConnection>(this.connections),
    };
  }

  destroy() {
    this.provider.destroy();
    this.document.destroy();
    this.changeListener = null;
    this.statusListener = null;
    this.presenceListener = null;
  }

  private writeProject(project: MobileCanvasProject, initialize: boolean) {
    this.document.transact(() => {
      this.meta.set("title", project.title);
      this.meta.set("updatedAt", project.updatedAt);
      this.meta.set("schemaVersion", 1);
      if (initialize) this.meta.set("initialized", true);
      writeRecord(this.nodes, project.nodes);
      writeRecord(this.connections, project.connections);
    }, LOCAL_ORIGIN);
  }

  private emitChange(origin: unknown) {
    if (origin === LOCAL_ORIGIN || !this.changeListener || !this.isInitialized()) return;
    const fallback: MobileCanvasProject = {
      id: this.localProjectId,
      title: String(this.meta.get("title") || "共享画布"),
      updatedAt: Number(this.meta.get("updatedAt") || Date.now()),
      nodes: [],
      connections: [],
    };
    this.changeListener(this.snapshot(fallback));
  }
}
