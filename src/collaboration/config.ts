const configuredApiUrl = String(import.meta.env.VITE_COLLAB_API_URL || "").trim();
const configuredWebSocketUrl = String(import.meta.env.VITE_COLLAB_WS_URL || "").trim();
const devHost = typeof window === "undefined" ? "localhost" : window.location.hostname;
const devProtocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";

export const COLLAB_API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? typeof window === "undefined" ? "" : window.location.origin : "https://canvas-api.mikasa.wiki")).replace(/\/$/, "");
export const COLLAB_API_PREFIX = String(import.meta.env.VITE_COLLAB_API_PREFIX || "/collab-api/v1").replace(/\/$/, "");
export const COLLAB_WS_URL = (configuredWebSocketUrl || (import.meta.env.DEV ? `${devProtocol}//${devHost}:1234` : "wss://canvas-api.mikasa.wiki/collab-ws")).replace(/\/$/, "");

export function isCollaborationConfigured() {
  return Boolean(COLLAB_WS_URL);
}

export function collaborationApiPath(path: string) {
  return `${COLLAB_API_PREFIX}/${path.replace(/^\//, "")}`;
}
