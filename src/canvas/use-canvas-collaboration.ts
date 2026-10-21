import { useCallback, useEffect, useRef, useState } from "react";
import { issueCollaborationToken } from "../api/collaboration";
import { CanvasCollaborationDocument, type CanvasCollaborationEvent, type CanvasPresence } from "../collaboration/canvas-document";
import { COLLAB_WS_URL } from "../collaboration/config";
import type { AuthSession, MobileCanvasProject } from "../types";

type Props = {
  project: MobileCanvasProject | null;
  session: AuthSession;
  onRemoteProject: (project: MobileCanvasProject) => void;
};

const EMPTY_PRESENCE: CanvasPresence[] = [];

export default function useCanvasCollaboration({ project, session, onRemoteProject }: Props) {
  const projectRef = useRef(project);
  const changeRef = useRef(onRemoteProject);
  const documentRef = useRef<CanvasCollaborationDocument | null>(null);
  const dragSentAtRef = useRef(0);
  const roomId = project?.collaboration?.roomId || "";
  const role = project?.collaboration?.role || "";
  const projectId = project?.id || "";
  const [retryVersion, setRetryVersion] = useState(0);
  const connectionKey = JSON.stringify([roomId, projectId, role, session.accessToken, session.user.id, session.user.displayName, session.user.username, retryVersion]);
  const readyRef = useRef(false);
  const readyKeyRef = useRef("");
  const statusKeyRef = useRef("");
  const authorizedRoleRef = useRef(role);
  const [status, setStatus] = useState<CanvasCollaborationEvent>(project?.collaboration ? "connecting" : "disconnected");
  const [error, setError] = useState("");
  const [authorizedRole, setAuthorizedRole] = useState(role);
  const [presence, setPresence] = useState<CanvasPresence[]>(EMPTY_PRESENCE);
  const [remotePositions, setRemotePositions] = useState<Record<string, { x: number; y: number }>>({});

  projectRef.current = project;
  changeRef.current = onRemoteProject;

  useEffect(() => {
    if (!roomId || !projectId) {
      documentRef.current = null;
      readyRef.current = false;
      readyKeyRef.current = "";
      authorizedRoleRef.current = "";
      statusKeyRef.current = connectionKey;
      setStatus("disconnected");
      setError("");
      setPresence(EMPTY_PRESENCE);
      setRemotePositions({});
      return;
    }
    let disposed = false;
    let collaboration: CanvasCollaborationDocument | null = null;
    let isSynced = false;
    readyRef.current = false;
    readyKeyRef.current = "";
    statusKeyRef.current = connectionKey;
    setStatus("connecting");
    setError("");
    authorizedRoleRef.current = role;
    setAuthorizedRole(role);
    setPresence(EMPTY_PRESENCE);
    setRemotePositions({});

    void issueCollaborationToken(session.accessToken, roomId).then((result) => {
      if (disposed) return;
      authorizedRoleRef.current = result.role;
      setAuthorizedRole(result.role);
      collaboration = new CanvasCollaborationDocument(roomId, result.token, COLLAB_WS_URL);
      collaboration.bindProjectId(projectId);
      documentRef.current = collaboration;
      collaboration.setPresence({ id: session.user.id, name: session.user.displayName || session.user.username });
      collaboration.onChange((remoteProject) => {
        if (isSynced && remoteProject.id === projectId) changeRef.current(remoteProject);
      });
      collaboration.onStatus((event) => {
        if (disposed) return;
        if (event === "syncing") {
          setStatus("syncing");
          return;
        }
        if (event === "synced") {
          const firstSync = !isSynced;
          isSynced = true;
          readyRef.current = true;
          readyKeyRef.current = connectionKey;
          setError("");
          if (firstSync) {
            const activeProject = projectRef.current;
            const authorizedProject = activeProject?.collaboration ? { ...activeProject, collaboration: { ...activeProject.collaboration, role: result.role } } : activeProject;
            if (!collaboration?.isInitialized() && result.role === "owner" && authorizedProject) collaboration?.seed(authorizedProject);
            if (authorizedProject) changeRef.current({ ...collaboration!.snapshot(authorizedProject), collaboration: authorizedProject.collaboration });
          }
          setStatus("synced");
        } else {
          isSynced = false;
          readyRef.current = false;
          readyKeyRef.current = "";
          statusKeyRef.current = connectionKey;
          setStatus(event);
          if (event === "error") setError("协作连接认证失败，请检查房间权限后重试");
        }
      });
      collaboration.onPresence((members) => {
        if (disposed) return;
        setPresence(members);
        const positions: Record<string, { x: number; y: number }> = {};
        const localClientId = collaboration?.localClientId;
        for (const member of members) {
          if (member.clientId === localClientId) continue;
          Object.assign(positions, member.positions);
        }
        setRemotePositions(positions);
      });
    }).catch((requestError) => {
      if (!disposed) {
        readyRef.current = false;
        readyKeyRef.current = "";
        statusKeyRef.current = connectionKey;
        setError(requestError instanceof Error ? requestError.message : "无法获取协作连接凭证");
        setStatus("error");
      }
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      if (readyKeyRef.current === connectionKey) readyKeyRef.current = "";
      collaboration?.destroy();
      if (documentRef.current === collaboration) documentRef.current = null;
    };
  }, [roomId, role, projectId, session.accessToken, session.user.id, session.user.displayName, session.user.username, retryVersion]);

  const applyLocalProject = useCallback((next: MobileCanvasProject) => {
    if (readyRef.current && readyKeyRef.current === connectionKey && next.collaboration?.roomId === roomId && authorizedRole !== "readonly") documentRef.current?.applyLocalProject(next);
  }, [connectionKey, roomId, authorizedRole]);

  const publishDrag = useCallback((nodeIds: string[], positions: Record<string, { x: number; y: number }>) => {
    if (!readyRef.current || readyKeyRef.current !== connectionKey || !documentRef.current || authorizedRole === "readonly") return;
    const now = Date.now();
    if (now - dragSentAtRef.current < 33) return;
    dragSentAtRef.current = now;
    documentRef.current.setDragging(nodeIds, positions);
  }, [authorizedRole, connectionKey]);

  const beginDrag = useCallback((nodeIds: string[]) => {
    if (readyRef.current && readyKeyRef.current === connectionKey && authorizedRole !== "readonly") documentRef.current?.setDragging(nodeIds, {});
  }, [authorizedRole, connectionKey]);

  const clearDrag = useCallback(() => documentRef.current?.clearDragging(), []);
  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);
  const canWrite = useCallback(() => readyRef.current && readyKeyRef.current === connectionKey && authorizedRoleRef.current !== "readonly", [connectionKey]);

  const lockedBy = useCallback((nodeId: string) => {
    const member = presence.find((item) => item.user.id !== session.user.id && item.nodeIds.includes(nodeId));
    return member?.user.name || "";
  }, [presence, session.user.id]);

  const currentStatus = statusKeyRef.current === connectionKey ? status : roomId ? "connecting" : "disconnected";
  const currentError = statusKeyRef.current === connectionKey ? error : "";
  return { status: currentStatus, error: currentError, presence, remotePositions, applyLocalProject, publishDrag, beginDrag, clearDrag, lockedBy, retry, canWrite, canEdit: authorizedRole !== "readonly" };
}
