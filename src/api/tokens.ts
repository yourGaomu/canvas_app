import { apiRequest } from "./client";
import type { ApiToken } from "../types";
import { logger } from "../lib/logger";

type TokenPage = { items?: ApiToken[]; data?: ApiToken[]; total?: number };

function normalizeToken(value: ApiToken | Record<string, unknown>): ApiToken {
  const token = value as Record<string, unknown>;
  const status = Number(token.status || 0);
  const expiredTime = Number(token.expiredTime ?? token.expired_time ?? -1);
  const remainQuota = Number(token.remainQuota ?? token.remain_quota ?? 0);
  const unlimitedQuota = Boolean(token.unlimitedQuota ?? token.unlimited_quota);
  const usableValue = token.usable;
  const usable = typeof usableValue === "boolean"
    ? usableValue
    : status === 0 || (status === 1 && (expiredTime === -1 || expiredTime > Math.floor(Date.now() / 1000)) && (unlimitedQuota || remainQuota > 0));
  return {
    id: Number(token.id || 0),
    name: String(token.name || ""),
    status,
    remainQuota,
    unlimitedQuota,
    usable,
    group: String(token.group || ""),
    expiredTime,
    maskedKey: typeof token.maskedKey === "string" ? token.maskedKey : typeof token.masked_key === "string" ? token.masked_key : undefined,
  };
}

export async function listTokens(accessToken: string): Promise<ApiToken[]> {
  const payload = await apiRequest<TokenPage | ApiToken[]>("/api/token/", { token: accessToken });
  const items = Array.isArray(payload) ? payload : payload.items || payload.data || [];
  const tokens = items.map(normalizeToken).filter((token) => token.id > 0);
  logger.info("token:list", { count: tokens.length, tokens: tokens.map((token) => ({ id: token.id, name: token.name, group: token.group, usable: token.usable })) });
  return tokens;
}

export async function createCanvasToken(accessToken: string, group: string) {
  logger.info("token:create", { name: "Infinite Canvas", group });
  await apiRequest<void>("/api/token/", {
    method: "POST",
    token: accessToken,
    body: {
      name: "Infinite Canvas",
      expired_time: -1,
      remain_quota: 0,
      unlimited_quota: true,
      model_limits_enabled: false,
      model_limits: "",
      group,
    },
  });
  const tokens = await listTokens(accessToken);
  const token = tokens.find((item) => item.name === "Infinite Canvas" && item.group === group);
  if (!token) throw new Error("New API 已创建令牌，但列表中没有返回对应分组");
  logger.info("token:created", { id: token.id, group: token.group });
  return token;
}

export async function getTokenKey(accessToken: string, tokenId: number) {
  logger.info("token:key:start", { tokenId });
  const payload = await apiRequest<{ key?: string }>(`/api/token/${tokenId}/key`, { method: "POST", token: accessToken });
  if (!payload.key) throw new Error("New API 未返回 Token Key");
  logger.info("token:key:success", { tokenId, keyReturned: Boolean(payload.key) });
  return payload.key;
}

export async function ensureCanvasToken(accessToken: string, group = "") {
  const tokens = await listTokens(accessToken);
  const existing = tokens.find((item) => item.name === "Infinite Canvas" && item.group === group && item.usable !== false);
  logger.info("token:resolve", { requestedGroup: group, reusedTokenId: existing?.id || null });
  const token = existing || (await createCanvasToken(accessToken, group));
  if (!token?.id) throw new Error("无法创建 Infinite Canvas Token");
  return { token, key: await getTokenKey(accessToken, token.id) };
}
