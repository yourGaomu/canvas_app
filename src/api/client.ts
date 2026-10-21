import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { Model } from "../types";
import { logger } from "../lib/logger";

export const API_BASE_URL = import.meta.env.DEV ? "" : "https://mikasa.icu";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly code = "request_failed",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  baseUrl?: string;
  token?: string;
  credentials?: RequestCredentials;
  networkErrorMessage?: string;
  forbiddenMessage?: string;
  headers?: Record<string, string>;
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  responseType?: "json" | "blob";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(payload: unknown) {
  if (!isRecord(payload)) return "请求失败";
  const error = isRecord(payload.error) ? payload.error : undefined;
  return String(error?.message || payload.message || payload.msg || "请求失败");
}

function requestErrorMessage(payload: unknown, status: number, forbiddenMessage?: string) {
  const message = errorMessage(payload);
  if (message !== "请求失败") return message;
  if (status === 403) return forbiddenMessage || "mikasa.icu 返回 403，请检查账户分组权限或 Cloudflare/WAF 配置";
  return message;
}

function responseErrorCode(payload: unknown, status: number) {
  if (isRecord(payload)) {
    const error = isRecord(payload.error) ? payload.error : undefined;
    const code = error?.code || payload.code;
    if (code) return String(code);
  }
  return `http_${status}`;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ApiError("请求已取消", 0, "aborted");
}

function unwrap<T>(payload: unknown): T {
  if (isRecord(payload) && payload.success === false) {
    const error = isRecord(payload.error) ? payload.error : undefined;
    const code = String(error?.code || payload.code || "request_failed");
    const status = Number(error?.status || payload.status || 0);
    logger.warn("request:api-error", { message: errorMessage(payload), code, status });
    throw new ApiError(errorMessage(payload), status, code);
  }
  if (isRecord(payload) && "data" in payload && payload.data !== undefined) return payload.data as T;
  return payload as T;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  throwIfAborted(options.signal);
  const method = options.method || "GET";
  const baseUrl = options.baseUrl ?? API_BASE_URL;
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const requestStartedAt = Date.now();
  logger.info("request:start", { method, path, origin: url.startsWith("http") ? new URL(url).origin : "vite-proxy", transport: options.formData ? Capacitor.isNativePlatform() ? "capacitor-http-formdata" : "fetch-formdata" : Capacitor.isNativePlatform() ? "capacitor-http" : "fetch", hasToken: Boolean(options.token), hasJsonBody: options.body !== undefined, hasFormData: Boolean(options.formData) });
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  Object.assign(headers, options.headers);

  if (options.formData) {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.formData,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new ApiError("请求已取消", 0, "aborted");
      logger.error("request:network-error", { method, path, error: error instanceof Error ? error.message : String(error) });
      throw new ApiError(options.networkErrorMessage || "浏览器无法连接 New API，请检查 CORS、Cloudflare 或网络状态", 0, "network_error");
    }
    throwIfAborted(options.signal);
    const payload = await readResponse(response, options.responseType);
    logger.info("request:response", { method, path, status: response.status, contentType: response.headers.get("content-type"), server: response.headers.get("server"), cfRay: response.headers.get("cf-ray"), durationMs: Date.now() - requestStartedAt });
    if (!response.ok) {
      const message = requestErrorMessage(payload, response.status, options.forbiddenMessage);
      const code = responseErrorCode(payload, response.status);
      logger.warn("request:failed", { method, path, status: response.status, code, message });
      throw new ApiError(message, response.status, code);
    }
    return unwrap<T>(payload);
  }

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (Capacitor.isNativePlatform()) {
    let response;
    try {
      response = await CapacitorHttp.request({ url, method, headers, data: options.body, connectTimeout: 30_000, readTimeout: 120_000 });
    } catch (error) {
      if (options.signal?.aborted) throw new ApiError("请求已取消", 0, "aborted");
      logger.error("request:native-error", { method, path, error: error instanceof Error ? error.message : String(error) });
      throw new ApiError(options.networkErrorMessage || "无法连接 mikasa.icu，请检查网络、VPN 或 Cloudflare 配置", 0, "network_error");
    }
    throwIfAborted(options.signal);
    logger.info("request:response", { method, path, status: response.status, contentType: response.headers?.["content-type"], server: response.headers?.server, cfRay: response.headers?.["cf-ray"] || response.headers?.["CF-Ray"], durationMs: Date.now() - requestStartedAt });
    if (response.status < 200 || response.status >= 300) {
      const message = requestErrorMessage(response.data, response.status, options.forbiddenMessage);
      const code = responseErrorCode(response.data, response.status);
      logger.warn("request:failed", { method, path, status: response.status, code, message });
      throw new ApiError(message, response.status, code);
    }
    return unwrap<T>(response.data);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: options.credentials ?? "include",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ApiError("请求已取消", 0, "aborted");
    logger.error("request:network-error", { method, path, error: error instanceof Error ? error.message : String(error) });
    throw new ApiError(options.networkErrorMessage || "浏览器无法连接 New API，请检查 CORS、Cloudflare 或网络状态", 0, "network_error");
  }
  throwIfAborted(options.signal);
  const payload = await readResponse(response, options.responseType);
  logger.info("request:response", { method, path, status: response.status, contentType: response.headers.get("content-type"), server: response.headers.get("server"), cfRay: response.headers.get("cf-ray"), durationMs: Date.now() - requestStartedAt });
  if (!response.ok) {
    const message = requestErrorMessage(payload, response.status, options.forbiddenMessage);
    const code = responseErrorCode(payload, response.status);
    logger.warn("request:failed", { method, path, status: response.status, code, message });
    throw new ApiError(message, response.status, code);
  }
  return unwrap<T>(payload);
}

async function readResponse(response: Response, responseType?: "json" | "blob") {
  if (responseType === "blob") return response.blob();
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function asDataUrl(value: unknown, mimeType = "image/png") {
  if (typeof value !== "string" || !value) return "";
  return value.startsWith("data:") ? value : `data:${mimeType};base64,${value}`;
}

export function modelCapability(name: string): Model["capability"] {
  const value = name.toLowerCase();
  if (["video", "sora", "veo", "kling", "wan", "hailuo"].some((key) => value.includes(key))) return "video";
  if (["gpt-image", "dall-e", "dalle", "gemini", "imagen", "nano-banana", "grok-imagine-image", "seedream", "flux", "sdxl", "midjourney", "image"].some((key) => value.includes(key))) return "image";
  if (["audio", "tts", "speech", "voice", "music"].some((key) => value.includes(key))) return "audio";
  return "text";
}
