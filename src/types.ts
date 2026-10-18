export type User = {
  id: number;
  username: string;
  displayName: string;
  email: string;
  group: string;
  quota: number;
  usedQuota: number;
  requestCount: number;
};

export type AuthSession = {
  accessToken: string;
  tokenType: string;
  sessionId: string;
  accessExpiresAt: number;
  user: User;
  apiToken: string;
  apiTokenId: number;
  apiTokenGroup?: string;
};

export type ApiToken = {
  id: number;
  name: string;
  status: number;
  remainQuota: number;
  unlimitedQuota: boolean;
  usable: boolean;
  group: string;
  expiredTime: number;
  maskedKey?: string;
};

export type TokenGroup = {
  name: string;
  description: string;
  ratio: string;
};

export type Model = {
  id: string;
  capability: "image" | "video" | "text" | "audio";
};

export type GeneratedAsset = {
  id: string;
  kind: "image" | "video" | "text";
  url: string;
  model: string;
  prompt: string;
  createdAt: number;
};

export type MobileCanvasNode = {
  id: string;
  type: "asset" | "image-generation" | "video-generation" | "text" | "group";
  x: number;
  y: number;
  assetId?: string;
  assetIds?: string[];
  model?: string;
  prompt?: string;
  imageCount?: number;
  title?: string;
  groupId?: string;
  width?: number;
  height?: number;
  widthPx?: number;
};

export type MobileCanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

export type MobileCanvasProject = {
  id: string;
  title: string;
  updatedAt: number;
  nodes: MobileCanvasNode[];
  connections: MobileCanvasConnection[];
};

export type VideoTask = {
  id: string;
  status: string;
  progress?: number;
  error?: string;
  url?: string;
};
