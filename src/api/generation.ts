import { API_BASE_URL, ApiError, apiRequest, asDataUrl } from "./client";
import type { GeneratedAsset, VideoTask } from "../types";
import { logger } from "../lib/logger";

type GenerationStatus = (message: string) => void;

const RETRYABLE_STATUSES = new Set([429, 502, 503]);

function isRetryable(error: unknown, retryableStatuses = RETRYABLE_STATUSES) {
  return error instanceof ApiError && retryableStatuses.has(error.status);
}

function waitWithSignal(delay: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError("已取消等待视频任务", 0, "aborted"));
      return;
    }
    let timer = 0;
    const abort = () => {
      window.clearTimeout(timer);
      reject(new ApiError("已取消等待视频任务", 0, "aborted"));
    };
    timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function promiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ApiError("已取消等待视频任务", 0, "aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ApiError("已取消等待视频任务", 0, "aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function retryOnce<T>(path: string, request: () => Promise<T>, onStatus?: GenerationStatus, signal?: AbortSignal, retryableStatuses = RETRYABLE_STATUSES): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (signal?.aborted) throw new ApiError("已取消等待视频任务", 0, "aborted");
    if (!(error instanceof ApiError) || !isRetryable(error, retryableStatuses)) throw error;
    logger.warn("generation:retry", { path, attempt: 1, status: error.status, code: error.code });
    onStatus?.("上游暂时繁忙，正在自动重试一次…");
    await waitWithSignal(900, signal);
    return request();
  }
}

function supportsProtocolFallback(error: unknown) {
  if (!(error instanceof ApiError) || [401, 403, 429].includes(error.status) || error.code === "aborted") return false;
  const details = `${error.code} ${error.message}`;
  if (/gemini.*channel|channel.*gemini/i.test(details)) return false;
  if (/model.{0,40}(not found|unavailable|invalid|does not exist)/i.test(error.message)) return false;
  if ([405, 415, 422].includes(error.status)) return true;
  if (error.status === 404) return /endpoint|route|path|url|not found/i.test(error.message);
  return /unsupported|not supported|unknown endpoint|method not allowed|no route|not implemented|protocol/i.test(details);
}

function apiErrorDetails(error: unknown) {
  return error instanceof ApiError ? { status: error.status, code: error.code } : {};
}

function unwrapGenerationPayload(payload: unknown) {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !("data" in current)) break;
    const data = (current as { data?: unknown }).data;
    if (data === undefined || typeof data !== "object" || data === null) break;
    current = data;
  }
  return current;
}

function openAiImageBody(model: string, prompt: string, options: { size?: string; quality?: string; count: number }) {
  const body: Record<string, unknown> = { model, prompt, n: options.count };
  if (isGptImage(model)) body.output_format = "png";
  else body.response_format = "b64_json";
  if (!isGrok(model)) {
    if (options.size && options.size !== "auto") body.size = isGptImage(model) && options.size === "1:1" ? "1024x1024" : options.size;
    if (options.quality && options.quality !== "auto") body.quality = options.quality;
  }
  return body;
}

async function generateOpenAiImage(apiToken: string, model: string, prompt: string, options: { size?: string; quality?: string; count: number }, onStatus?: GenerationStatus) {
  const body = openAiImageBody(model, prompt, options);
  logger.info("generation:image:start", { model, count: options.count, mode: "openai-compatible", size: body.size || "auto", quality: body.quality || "auto", outputFormat: body.output_format || body.response_format, promptLength: prompt.length });
  const payload = await retryOnce("/v1/images/generations", () => apiRequest<unknown>("/v1/images/generations", { method: "POST", token: apiToken, body }), onStatus);
  const assets = await imageItems(payload, model, prompt);
  if (!assets.length) throw new Error("New API 未返回图片");
  logger.info("generation:image:success", { model, count: assets.length, path: "v1/images/generations" });
  return assets;
}

function isGemini(model: string) {
  const value = model.toLowerCase();
  return value.includes("gemini") || value.startsWith("nano-banana");
}

function isGrok(model: string) {
  return model.toLowerCase().includes("grok-imagine-image");
}

function isGptImage(model: string) {
  return model.toLowerCase().includes("gpt-image");
}

async function imageItems(payload: unknown, model: string, prompt: string): Promise<GeneratedAsset[]> {
  const unwrapped = unwrapGenerationPayload(payload);
  const body = unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    ? unwrapped as { data?: Array<{ b64_json?: string; url?: string } | string>; images?: Array<{ b64_json?: string; url?: string } | string>; results?: Array<{ b64_json?: string; url?: string } | string> }
    : undefined;
  const items = Array.isArray(unwrapped) ? unwrapped : body?.data || body?.images || body?.results || [];
  return (await Promise.all(items.map(async (item, index) => {
    const value = typeof item === "string" ? item : item && typeof item === "object" ? (item as { b64_json?: string; url?: string }).b64_json || (item as { url?: string }).url || "" : "";
    const imageUrl = value.startsWith("data:") || /^https?:\/\//i.test(value) ? value : asDataUrl(value, "image/png");
    return {
      id: `${Date.now()}-${index}`,
      kind: "image" as const,
      url: await resolveImageUrl(imageUrl),
      model,
      prompt,
      createdAt: Date.now(),
    };
  }))).filter((item) => item.url);
}

async function resolveImageUrl(value: string) {
  if (!value || value.startsWith("data:") || !/^https?:\/\//i.test(value)) return value;
  try {
    const response = await fetch(value);
    if (!response.ok) return value;
    const blob = await response.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || value));
      reader.onerror = () => resolve(value);
      reader.readAsDataURL(blob);
    });
  } catch {
    return value;
  }
}

function geminiItems(payload: unknown, model: string, prompt: string): GeneratedAsset[] {
  const unwrapped = unwrapGenerationPayload(payload);
  const candidates = (unwrapped as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> } }> }).candidates || [];
  return candidates
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part, index) => {
      const image = part.inlineData || (part.inline_data ? { data: part.inline_data.data, mimeType: part.inline_data.mime_type } : undefined);
      return {
        id: `${Date.now()}-${index}`,
        kind: "image" as const,
        url: asDataUrl(image?.data, image?.mimeType || "image/png"),
        model,
        prompt,
        createdAt: Date.now(),
      };
    })
    .filter((item) => item.url);
}

export async function generateImage(apiToken: string, model: string, prompt: string, options: { size?: string; quality?: string; count?: number } = {}, onStatus?: GenerationStatus) {
  const count = Math.max(1, Math.min(10, options.count || 1));
  const normalizedOptions = { ...options, count };
  if (isGemini(model)) {
    const imageConfig: Record<string, string> = {};
    if (options.size && options.size.includes(":")) imageConfig.aspectRatio = options.size;
    if (options.quality && options.quality !== "auto") imageConfig.imageSize = options.quality === "high" ? "4K" : options.quality === "medium" ? "2K" : "1K";
    logger.info("generation:image:start", { model, count, mode: "gemini-native", size: imageConfig.aspectRatio || "auto", quality: imageConfig.imageSize || "auto", promptLength: prompt.length });
    const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const payload = await retryOnce(path, () => apiRequest<unknown>(path, {
        method: "POST",
        token: apiToken,
        body: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"], candidateCount: count, ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
        },
      }), onStatus);
      const assets = geminiItems(payload, model, prompt);
      if (!assets.length) throw new Error("Gemini 未返回图片");
      logger.info("generation:image:success", { model, count: assets.length, path: "v1beta/generateContent" });
      return assets;
    } catch (error) {
      if (!supportsProtocolFallback(error)) throw error;
      logger.warn("generation:protocol-switch", { model, from: "v1beta/generateContent", to: "v1/images/generations", ...apiErrorDetails(error) });
      onStatus?.("原生 Gemini 路径不可用，正在切换到兼容路径…");
      return generateOpenAiImage(apiToken, model, prompt, normalizedOptions, onStatus);
    }
  }
  return generateOpenAiImage(apiToken, model, prompt, normalizedOptions, onStatus);
}

async function dataUrlBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function sourceDataUrl(source: string) {
  if (source.startsWith("data:")) return source;
  const blob = await dataUrlBlob(source);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取参考图片失败"));
    reader.readAsDataURL(blob);
  });
}

function referenceFilename(dataUrl: string, index: number) {
  const mimeType = dataUrl.match(/^data:([^;,]+)/)?.[1]?.toLowerCase();
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType?.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png";
  return `reference-${index + 1}.${extension}`;
}

export async function editImage(apiToken: string, model: string, prompt: string, referenceDataUrls: string[], maskDataUrl?: string, count = 1, onStatus?: GenerationStatus) {
  const references = referenceDataUrls.filter(Boolean);
  if (!references.length) throw new Error("至少需要一张参考图片");
  if (isGrok(model)) throw new Error("Grok Imagine 当前只支持图片生成，不支持图片编辑");
  const normalizedCount = Math.max(1, Math.min(10, Math.floor(count) || 1));
  logger.info("generation:edit:start", { model, mode: isGemini(model) ? "gemini-native" : "openai-compatible", hasMask: Boolean(maskDataUrl), referenceCount: references.length, promptLength: prompt.length });
  if (isGemini(model)) {
    if (maskDataUrl) throw new Error("Gemini 原生图片编辑暂不支持蒙版");
    const imageParts = await Promise.all(references.map(async (reference) => {
      const dataUrl = await sourceDataUrl(reference);
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error("参考图片格式无效");
      return { inline_data: { mime_type: match[1], data: match[2] } };
    }));
    const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const payload = await retryOnce(path, () => apiRequest<unknown>(path, {
        method: "POST",
        token: apiToken,
        body: {
          contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
          generationConfig: { responseModalities: ["IMAGE"], candidateCount: normalizedCount },
        },
      }), onStatus);
      const assets = geminiItems(payload, model, prompt);
      if (!assets.length) throw new Error("Gemini 未返回编辑结果");
      logger.info("generation:edit:success", { model, count: assets.length, path: "v1beta/generateContent" });
      return assets;
    } catch (error) {
      if (maskDataUrl || !supportsProtocolFallback(error)) throw error;
      logger.warn("generation:protocol-switch", { model, from: "v1beta/generateContent", to: "v1/images/edits", ...apiErrorDetails(error) });
      onStatus?.("原生 Gemini 路径不可用，正在切换到兼容路径…");
    }
  }

  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("n", String(normalizedCount));
  if (!isGptImage(model)) form.set("response_format", "b64_json");
  await Promise.all(references.map(async (reference, index) => {
    form.append("image", await dataUrlBlob(reference), referenceFilename(reference, index));
  }));
  if (maskDataUrl) form.set("mask", await dataUrlBlob(maskDataUrl));
  const payload = await retryOnce("/v1/images/edits", () => apiRequest<unknown>("/v1/images/edits", { method: "POST", token: apiToken, formData: form }), onStatus);
  const assets = await imageItems(payload, model, prompt);
  if (!assets.length) throw new Error("New API 未返回编辑结果");
  logger.info("generation:edit:success", { model, count: assets.length, path: "v1/images/edits" });
  return assets;
}

export async function createVideo(apiToken: string, model: string, prompt: string, referenceDataUrl?: string, signal?: AbortSignal, onStatus?: GenerationStatus) {
  logger.info("generation:video:start", { model, hasReference: Boolean(referenceDataUrl), promptLength: prompt.length });
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  if (referenceDataUrl) form.append("input_reference", await dataUrlBlob(referenceDataUrl), "reference.png");
  const task = await retryOnce("/v1/videos", () => apiRequest<VideoTask>("/v1/videos", { method: "POST", token: apiToken, formData: form, signal }), onStatus, signal, new Set([429]));
  logger.info("generation:video:created", { model, taskId: task.id, status: task.status });
  return task;
}

export async function getVideo(apiToken: string, taskId: string, signal?: AbortSignal, onStatus?: GenerationStatus) {
  const path = `/v1/videos/${encodeURIComponent(taskId)}`;
  const task = await retryOnce(path, () => apiRequest<VideoTask>(path, { token: apiToken, signal }), onStatus, signal);
  logger.info("generation:video:poll", { taskId, status: task.status, progress: task.progress });
  return task;
}

export async function waitForVideo(apiToken: string, taskId: string, options: { signal?: AbortSignal; onTask?: (task: VideoTask) => void; onStatus?: GenerationStatus } = {}) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await waitWithSignal(attempt === 0 ? 1200 : 2500, options.signal);
    const task = await promiseWithSignal(getVideo(apiToken, taskId, options.signal, options.onStatus), options.signal);
    options.onTask?.(task);
    options.onStatus?.(`视频处理中${task.progress ? ` ${task.progress}%` : "…"}`);
    const status = String(task.status).toLowerCase();
    if (["completed", "succeeded", "success"].includes(status) || task.url) return task;
    if (["failed", "cancelled", "canceled", "error"].includes(status)) throw new Error(task.error || "视频生成失败");
  }
  throw new ApiError("视频任务等待超时，上游任务可能仍在运行", 408, "video_timeout");
}

export function videoContentUrl(taskId: string) {
  return `${API_BASE_URL}/v1/videos/${encodeURIComponent(taskId)}/content`;
}

export function videoResultUrl(task: VideoTask) {
  if (!task.url) return videoContentUrl(task.id);
  try {
    return new URL(task.url, API_BASE_URL || window.location.origin).toString();
  } catch {
    return task.url;
  }
}

export async function downloadVideo(apiToken: string, taskId: string) {
  return apiRequest<Blob>(`/v1/videos/${encodeURIComponent(taskId)}/content`, { token: apiToken, responseType: "blob" });
}

export async function chatCompletion(apiToken: string, model: string, messages: Array<{ role: string; content: string }>) {
  logger.info("generation:chat:start", { model, messageCount: messages.length, promptLength: messages.reduce((total, message) => total + message.content.length, 0) });
  return apiRequest<{ choices?: Array<{ message?: { content?: string } }> }>("/v1/chat/completions", {
    method: "POST",
    token: apiToken,
    body: { model, messages, stream: false },
  });
}
