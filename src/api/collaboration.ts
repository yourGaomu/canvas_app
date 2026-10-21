import { apiRequest } from "./client";
import { collaborationApiPath, COLLAB_API_BASE_URL } from "../collaboration/config";
import type { MobileCanvasProject } from "../types";

export type CollaborationRole = "owner" | "editor" | "readonly";

export type CollaborationRoom = {
  roomId: string;
  title: string;
  role: CollaborationRole;
  token: string;
};

export type CollaborationRoomInfo = Omit<CollaborationRoom, "token">;

type RoomPayload = {
  room_id?: string;
  roomId?: string;
  title?: string;
  role?: CollaborationRole;
  token?: string;
  collaboration_token?: string;
};

function normalizeRoom(payload: RoomPayload): CollaborationRoom {
  const roomId = String(payload.roomId || payload.room_id || "");
  const token = String(payload.token || payload.collaboration_token || "");
  const role = payload.role;
  if (!roomId || !token || !["owner", "editor", "readonly"].includes(String(role))) throw new Error("协作服务没有返回有效房间凭证或权限");
  return { roomId, title: String(payload.title || "共享画布"), role: role!, token };
}

function normalizeRoomInfo(payload: RoomPayload, fallbackRoomId = ""): CollaborationRoomInfo {
  const roomId = String(payload.roomId || payload.room_id || fallbackRoomId);
  const role = payload.role;
  if (!roomId || !["owner", "editor", "readonly"].includes(String(role))) throw new Error("协作服务没有返回有效房间信息或权限");
  return { roomId, title: String(payload.title || "共享画布"), role: role! };
}

export async function createCollaborationRoom(accessToken: string, project: Pick<MobileCanvasProject, "id" | "title">) {
  const payload = await apiRequest<RoomPayload>(collaborationApiPath("rooms"), {
    method: "POST",
    baseUrl: COLLAB_API_BASE_URL,
    token: accessToken,
    credentials: "omit",
    networkErrorMessage: "无法连接协作服务，请检查协作 API 地址和 Nginx 配置",
    forbiddenMessage: "你没有创建协作画布的权限",
    body: { client_project_id: project.id, title: project.title },
  });
  return normalizeRoomInfo(payload);
}

export async function issueCollaborationToken(accessToken: string, roomId: string) {
  const payload = await apiRequest<RoomPayload>(collaborationApiPath(`rooms/${encodeURIComponent(roomId)}/session`), {
    method: "POST",
    baseUrl: COLLAB_API_BASE_URL,
    token: accessToken,
    credentials: "omit",
    networkErrorMessage: "无法连接协作服务，请检查协作 API 地址和 Nginx 配置",
    forbiddenMessage: "你没有加入这个共享画布的权限",
  });
  return normalizeRoom({ ...payload, roomId });
}

export async function getCollaborationRoom(accessToken: string, roomId: string) {
  const payload = await apiRequest<RoomPayload>(collaborationApiPath(`rooms/${encodeURIComponent(roomId)}`), {
    baseUrl: COLLAB_API_BASE_URL,
    token: accessToken,
    credentials: "omit",
    networkErrorMessage: "无法连接协作服务，请检查协作 API 地址和 Nginx 配置",
    forbiddenMessage: "你没有加入这个共享画布的权限",
  });
  return normalizeRoomInfo(payload, roomId);
}

export async function addCollaborationMember(accessToken: string, roomId: string, username: string, role: Exclude<CollaborationRole, "owner"> = "editor") {
  await apiRequest<unknown>(collaborationApiPath(`rooms/${encodeURIComponent(roomId)}/members`), {
    method: "POST",
    baseUrl: COLLAB_API_BASE_URL,
    token: accessToken,
    credentials: "omit",
    networkErrorMessage: "无法连接协作服务，请检查协作 API 地址和 Nginx 配置",
    forbiddenMessage: "你没有邀请成员的权限",
    body: { username, role },
  });
}
