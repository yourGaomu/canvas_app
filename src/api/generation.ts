import { apiRequest, asDataUrl } from "./client";
import type { GeneratedAsset, VideoTask } from "../types";
import { logger } from "../lib/logger";

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
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as { data?: Array<{ b64_json?: string; url?: string }>; images?: Array<{ b64_json?: string; url?: string }>; results?: Array<{ b64_json?: string; url?: string }> }
    : undefined;
  const items = Array.isArray(payload) ? payload as Array<{ b64_json?: string; url?: string }> : body?.data || body?.images || body?.results || [];
  return (await Promise.all(items.map(async (item, index) => ({
      id: `${Date.now()}-${index}`,
      kind: "image" as const,
      url: await resolveImageUrl(asDataUrl(item.b64_json, "image/png") || String(item.url || "")),
      model,
      prompt,
      createdAt: Date.now(),
    })))).filter((item) => item.url);
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
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> } }> }).candidates || [];
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

export async function generateImage(apiToken: string, model: string, prompt: string, options: { size?: string; quality?: string; count?: number } = {}) {
  const count = Math.max(1, Math.min(10, options.count || 1));
  if (isGemini(model)) {
    const imageConfig: Record<string, string> = {};
    if (options.size && options.size.includes(":")) imageConfig.aspectRatio = options.size;
    if (options.quality && options.quality !== "auto") imageConfig.imageSize = options.quality === "high" ? "4K" : options.quality === "medium" ? "2K" : "1K";
    logger.info("generation:image:start", { model, count, mode: "gemini-native", size: imageConfig.aspectRatio || "auto", quality: imageConfig.imageSize || "auto", promptLength: prompt.length });
    const payload = await apiRequest<unknown>(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      token: apiToken,
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], candidateCount: count, ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
      },
    });
    const assets = geminiItems(payload, model, prompt);
    if (!assets.length) throw new Error("Gemini 未返回图片");
    logger.info("generation:image:success", { model, count: assets.length, path: "v1beta/generateContent" });
    return assets;
  }

  const body: Record<string, unknown> = { model, prompt, n: count };
  if (isGptImage(model)) body.output_format = "png";
  else body.response_format = "b64_json";
  if (!isGrok(model)) {
    if (options.size && options.size !== "auto") body.size = isGptImage(model) && options.size === "1:1" ? "1024x1024" : options.size;
    if (options.quality && options.quality !== "auto") body.quality = options.quality;
  }
  logger.info("generation:image:start", { model, count, mode: "openai-compatible", size: body.size || "auto", quality: body.quality || "auto", outputFormat: body.output_format || body.response_format, promptLength: prompt.length });
  const assets = await imageItems(await apiRequest<unknown>("/v1/images/generations", { method: "POST", token: apiToken, body }), model, prompt);
  if (!assets.length) throw new Error("New API 未返回图片");
  logger.info("generation:image:success", { model, count: assets.length, path: "v1/images/generations" });
  return assets;
}

async function dataUrlBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

function referenceFilename(dataUrl: string, index: number) {
  const mimeType = dataUrl.match(/^data:([^;,]+)/)?.[1]?.toLowerCase();
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType?.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png";
  return `reference-${index + 1}.${extension}`;
}

export async function editImage(apiToken: string, model: string, prompt: string, referenceDataUrls: string[], maskDataUrl?: string, count = 1) {
  const references = referenceDataUrls.filter(Boolean);
  if (!references.length) throw new Error("至少需要一张参考图片");
  const normalizedCount = Math.max(1, Math.min(10, Math.floor(count) || 1));
  logger.info("generation:edit:start", { model, mode: isGemini(model) ? "gemini-native" : "openai-compatible", hasMask: Boolean(maskDataUrl), referenceCount: references.length, promptLength: prompt.length });
  if (isGemini(model)) {
    if (maskDataUrl) throw new Error("Gemini 原生图片编辑暂不支持蒙版");
    const imageParts = references.map((reference) => {
      const match = reference.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error("参考图片格式无效");
      return { inline_data: { mime_type: match[1], data: match[2] } };
    });
    const payload = await apiRequest<unknown>(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      token: apiToken,
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
        generationConfig: { responseModalities: ["IMAGE"], candidateCount: normalizedCount },
      },
    });
    const assets = geminiItems(payload, model, prompt);
    if (!assets.length) throw new Error("Gemini 未返回编辑结果");
    logger.info("generation:edit:success", { model, count: assets.length, path: "v1beta/generateContent" });
    return assets;
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
  const assets = await imageItems(await apiRequest<unknown>("/v1/images/edits", { method: "POST", token: apiToken, formData: form }), model, prompt);
  if (!assets.length) throw new Error("New API 未返回编辑结果");
  logger.info("generation:edit:success", { model, count: assets.length, path: "v1/images/edits" });
  return assets;
}

export async function createVideo(apiToken: string, model: string, prompt: string, referenceDataUrl?: string) {
  logger.info("generation:video:start", { model, hasReference: Boolean(referenceDataUrl), promptLength: prompt.length });
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  if (referenceDataUrl) form.append("image", await dataUrlBlob(referenceDataUrl), "reference.png");
  const task = await apiRequest<VideoTask>("/v1/videos", { method: "POST", token: apiToken, formData: form });
  logger.info("generation:video:created", { model, taskId: task.id, status: task.status });
  return task;
}

export async function getVideo(apiToken: string, taskId: string) {
  const task = await apiRequest<VideoTask>(`/v1/videos/${encodeURIComponent(taskId)}`, { token: apiToken });
  logger.info("generation:video:poll", { taskId, status: task.status, progress: task.progress });
  return task;
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
