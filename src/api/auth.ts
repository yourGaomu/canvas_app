import { apiRequest } from "./client";
import type { AuthSession, TokenGroup, User } from "../types";
import { logger } from "../lib/logger";

type AuthPayload = {
  access_token?: string;
  token_type?: string;
  access_expires_at?: number;
  session?: { sid?: string };
  user?: Record<string, unknown>;
  require_2fa?: boolean;
  flow_token?: string;
};

function parseUser(value: Record<string, unknown> | undefined): User {
  return {
    id: Number(value?.id || 0),
    username: String(value?.username || ""),
    displayName: String(value?.display_name || value?.username || ""),
    email: String(value?.email || ""),
    group: String(value?.group || ""),
    // New API quota is the remaining balance; used_quota is cumulative usage.
    quota: Number(value?.quota || 0),
    usedQuota: Number(value?.used_quota || 0),
    requestCount: Number(value?.request_count || 0),
  };
}

export type LoginResult = { requiresTwoFactor: true; flowToken: string } | { requiresTwoFactor: false; session: Omit<AuthSession, "apiToken" | "apiTokenId"> };

function parseLogin(payload: AuthPayload): LoginResult {
  if (payload.require_2fa) return { requiresTwoFactor: true, flowToken: String(payload.flow_token || "") };
  return {
    requiresTwoFactor: false,
    session: {
      accessToken: String(payload.access_token || ""),
      tokenType: String(payload.token_type || "Bearer"),
      sessionId: String(payload.session?.sid || ""),
      accessExpiresAt: Number(payload.access_expires_at || 0),
      user: parseUser(payload.user),
    },
  };
}

export function fetchPublicStatus() {
  return apiRequest<Record<string, unknown>>("/api/status").then((payload) => {
    const status = { defaultUseAutoGroup: payload.default_use_auto_group === true };
    logger.info("auth:public-status", status);
    return status;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function fetchUserGroups(accessToken: string): Promise<TokenGroup[]> {
  const payload = await apiRequest<unknown>("/api/user/self/groups", { token: accessToken });
  let current = payload;
  for (let depth = 0; depth < 3 && isRecord(current); depth += 1) {
    if (isRecord(current.groups) || Array.isArray(current.groups)) {
      current = current.groups;
      break;
    }
    if (!isRecord(current.data)) break;
    current = current.data;
  }
  const groups = (Array.isArray(current)
    ? current.map((value) => [isRecord(value) ? String(value.name || value.group || "") : String(value), value] as const)
    : isRecord(current) ? Object.entries(current) : [])
    .map(([name, value]) => ({
      name,
      description: isRecord(value) ? String(value.desc || value.description || "") : "",
      ratio: isRecord(value) ? String(value.ratio ?? "") : "",
    }))
    .filter((group) => group.name);
  logger.info("auth:user-groups", { groups: groups.map((group) => group.name), count: groups.length });
  return groups;
}

export function chooseDefaultTokenGroup(groups: TokenGroup[], userGroup: string, defaultUseAutoGroup: boolean) {
  if (defaultUseAutoGroup && groups.some((group) => group.name === "auto")) return "auto";
  if (userGroup && groups.some((group) => group.name === userGroup)) return userGroup;
  return groups.find((group) => group.name !== "auto")?.name || "";
}

export function registerUser(input: { username: string; password: string; email?: string; verificationCode?: string }) {
  return apiRequest<void>("/api/user/register", {
    method: "POST",
    body: {
      username: input.username,
      password: input.password,
      email: input.email || "",
      verification_code: input.verificationCode || "",
    },
  });
}

export async function loginUser(username: string, password: string): Promise<LoginResult> {
  logger.info("auth:login:start");
  const result = parseLogin(await apiRequest<AuthPayload>("/api/user/login", { method: "POST", body: { username, password } }));
  logger.info("auth:login:success", { requiresTwoFactor: result.requiresTwoFactor });
  return result;
}

export async function verifyTwoFactor(flowToken: string, code: string): Promise<LoginResult> {
  logger.info("auth:2fa:start");
  const result = parseLogin(await apiRequest<AuthPayload>("/api/user/login/2fa", { method: "POST", body: { flow_token: flowToken, code } }));
  logger.info("auth:2fa:success", { requiresTwoFactor: result.requiresTwoFactor });
  return result;
}

export async function refreshSession(accessToken: string, sessionId: string) {
  const payload = await apiRequest<AuthPayload>("/api/user/auth/refresh", { method: "POST", token: accessToken, headers: sessionId ? { "X-Auth-Session": sessionId } : undefined });
  const parsed = parseLogin(payload);
  if (parsed.requiresTwoFactor) throw new Error("登录状态无法刷新");
  return { ...parsed.session, sessionId: parsed.session.sessionId || sessionId };
}

export function logoutUser(accessToken: string, sessionId: string) {
  return apiRequest<void>("/api/user/auth/logout", { method: "POST", token: accessToken, headers: sessionId ? { "X-Auth-Session": sessionId } : undefined });
}

export async function fetchCurrentUser(accessToken: string) {
  const payload = await apiRequest<Record<string, unknown>>("/api/user/self", { token: accessToken });
  const value = payload.user && typeof payload.user === "object" && !Array.isArray(payload.user) ? payload.user as Record<string, unknown> : payload;
  const user = parseUser(value);
  logger.info("auth:user:success", { userId: user.id, group: user.group });
  return user;
}
