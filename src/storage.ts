import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import localforage from "localforage";
import { API_BASE_URL } from "./api/client";
import { logger } from "./lib/logger";
import type { AuthSession, GeneratedAsset, MobileCanvasProject } from "./types";

const SESSION_KEY = "infinite-canvas-mobile-session";
const ASSETS_KEY = "infinite-canvas-mobile-assets";
const CANVAS_PROJECTS_KEY = "infinite-canvas-mobile-canvas-projects";
const ASSET_DIRECTORY = Directory.Data;
const browserStore = localforage.createInstance({ name: "infinite-canvas-mobile", storeName: "app_data" });
let assetsWriteQueue = Promise.resolve();
let canvasWriteQueue = Promise.resolve();

async function readStoredValue<T>(key: string): Promise<T | null> {
  if (!Capacitor.isNativePlatform()) return browserStore.getItem<T>(key);
  const result = await Preferences.get({ key });
  return result.value ? JSON.parse(result.value) as T : null;
}

async function writeStoredValue<T>(key: string, value: T) {
  if (!Capacitor.isNativePlatform()) return browserStore.setItem(key, value);
  await Preferences.set({ key, value: JSON.stringify(value) });
}

function assetFilePath(asset: GeneratedAsset, mimeType: string) {
  const id = asset.id.replace(/[^a-zA-Z0-9_-]/g, "") || String(asset.createdAt);
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase();
  const extension = asset.kind === "text" ? "txt" : subtype === "jpeg" ? "jpg" : subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : asset.kind === "video" ? "mp4" : "png";
  return `assets/${id}.${extension}`;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function assetMimeType(asset: GeneratedAsset, url = asset.url) {
  const inlineType = url.match(/^data:([^;,]+)/)?.[1];
  if (inlineType) return inlineType;
  const extension = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1]?.toLowerCase();
  const imageTypes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
  return asset.kind === "video" ? "video/mp4" : imageTypes[extension || ""] || "image/png";
}

async function persistAsset(asset: GeneratedAsset, apiToken: string): Promise<GeneratedAsset> {
  if (asset.storagePath) return asset;
  if (!Capacitor.isNativePlatform()) {
    if (asset.kind === "text" || !asset.url || asset.url.startsWith("data:")) return asset;
    try {
      const url = new URL(asset.url, window.location.origin);
      if (!/^https?:$/.test(url.protocol)) return asset;
      const apiOrigin = new URL(API_BASE_URL || window.location.origin).origin;
      const response = await fetch(url.toString(), { headers: apiToken && url.origin === apiOrigin ? { Authorization: `Bearer ${apiToken}` } : undefined });
      if (!response.ok) return asset;
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取媒体失败"));
        reader.readAsDataURL(blob);
      });
      return { ...asset, url: dataUrl, storageMimeType: blob.type || assetMimeType(asset, url.toString()) };
    } catch (error) {
      logger.warn("assets:browser-copy:failed", { assetId: asset.id, kind: asset.kind, error: error instanceof Error ? error.message : "download_failed" });
      return asset;
    }
  }
  if (asset.kind === "text") {
    const content = asset.content ?? (asset.url.startsWith("data:text/") ? await (await fetch(asset.url)).text() : "");
    const storagePath = assetFilePath(asset, "text/plain");
    await Filesystem.writeFile({ path: storagePath, data: content, encoding: Encoding.UTF8, directory: ASSET_DIRECTORY, recursive: true });
    return { ...asset, url: "", content, storagePath, storageMimeType: "text/plain" };
  }
  const dataUrl = asset.url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataUrl) {
    const storagePath = assetFilePath(asset, dataUrl[1]);
    await Filesystem.writeFile({ path: storagePath, data: dataUrl[2], directory: ASSET_DIRECTORY, recursive: true });
    return { ...asset, storagePath, storageMimeType: dataUrl[1] };
  }
  if (!asset.url || asset.url.startsWith("blob:")) return asset;

  try {
    const url = new URL(asset.url, API_BASE_URL || window.location.origin);
    if (!/^https?:$/.test(url.protocol)) return asset;
    const apiOrigin = new URL(API_BASE_URL || window.location.origin).origin;
    const headers = apiToken && url.origin === apiOrigin ? { Authorization: `Bearer ${apiToken}` } : undefined;
    const storageMimeType = assetMimeType(asset, url.toString());
    const storagePath = assetFilePath(asset, storageMimeType);
    await Filesystem.downloadFile({ url: url.toString(), path: storagePath, directory: ASSET_DIRECTORY, recursive: true, headers });
    return { ...asset, url: url.toString(), storagePath, storageMimeType };
  } catch (error) {
    logger.warn("assets:local-copy:failed", { assetId: asset.id, kind: asset.kind, error: error instanceof Error ? error.message : "download_failed" });
    return asset;
  }
}

async function restoreAsset(asset: GeneratedAsset): Promise<GeneratedAsset> {
  if (!asset.storagePath) return asset;
  try {
    if (asset.kind === "text") {
      const { data } = await Filesystem.readFile({ path: asset.storagePath, directory: ASSET_DIRECTORY, encoding: Encoding.UTF8 });
      return { ...asset, url: "", content: data instanceof Blob ? await data.text() : data };
    }
    if (Capacitor.isNativePlatform()) {
      const { uri } = await Filesystem.getUri({ path: asset.storagePath, directory: ASSET_DIRECTORY });
      return { ...asset, url: Capacitor.convertFileSrc(uri) };
    }
    const { data } = await Filesystem.readFile({ path: asset.storagePath, directory: ASSET_DIRECTORY });
    const blob = data instanceof Blob ? data : await (await fetch(`data:${asset.storageMimeType || "application/octet-stream"};base64,${data}`)).blob();
    return { ...asset, url: URL.createObjectURL(blob) };
  } catch (error) {
    logger.warn("assets:local-copy:restore-failed", { assetId: asset.id, error: error instanceof Error ? error.message : "read_failed" });
    return { ...asset, url: "" };
  }
}

export async function readSession(): Promise<AuthSession | null> {
  try {
    const value = Capacitor.isNativePlatform() ? (await SecureStoragePlugin.get({ key: SESSION_KEY })).value : localStorage.getItem(SESSION_KEY);
    return value ? (JSON.parse(value) as AuthSession) : null;
  } catch (error) {
    logger.warn("session:read:failed", { error: error instanceof Error ? error.message : "read_failed" });
    return null;
  }
}

export async function writeSession(session: AuthSession) {
  const value = JSON.stringify(session);
  if (Capacitor.isNativePlatform()) await SecureStoragePlugin.set({ key: SESSION_KEY, value });
  else localStorage.setItem(SESSION_KEY, value);
}

export async function clearSession() {
  if (Capacitor.isNativePlatform()) await SecureStoragePlugin.remove({ key: SESSION_KEY });
  else localStorage.removeItem(SESSION_KEY);
}

export async function readAssets(): Promise<GeneratedAsset[]> {
  try {
    const assets = await readStoredValue<GeneratedAsset[]>(ASSETS_KEY) || [];
    return await Promise.all(assets.map(restoreAsset));
  } catch {
    return [];
  }
}

export async function writeAssets(assets: GeneratedAsset[], apiToken = "") {
  const operation = assetsWriteQueue.then(async () => {
    const persisted = await Promise.all(assets.map((asset) => persistAsset(asset, apiToken)));
    const records = persisted.map(({ url, content, ...asset }) => ({ ...asset, url: asset.storagePath ? "" : url, ...(asset.storagePath || content === undefined ? {} : { content }) }));
    await writeStoredValue(ASSETS_KEY, records);
    return persisted;
  });
  assetsWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function storeImportedAssets(imports: Array<{ asset: GeneratedAsset; blob: Blob }>) {
  return Promise.all(imports.map(async ({ asset, blob }) => {
    const mimeType = asset.storageMimeType || blob.type || (asset.kind === "video" ? "video/mp4" : asset.kind === "text" ? "text/plain" : "image/png");
    if (!Capacitor.isNativePlatform()) {
      if (asset.kind === "text") return { ...asset, url: "", content: await blob.text(), storageMimeType: mimeType };
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取素材失败"));
        reader.readAsDataURL(blob);
      });
      return { ...asset, url: dataUrl, storageMimeType: mimeType };
    }
    const storagePath = assetFilePath(asset, mimeType);
    if (asset.kind === "text") {
      const content = await blob.text();
      await Filesystem.writeFile({ path: storagePath, data: content, encoding: Encoding.UTF8, directory: ASSET_DIRECTORY, recursive: true });
      return restoreAsset({ ...asset, url: "", content, storagePath, storageMimeType: mimeType });
    }
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
      const data = toBase64(bytes);
      if (offset === 0) await Filesystem.writeFile({ path: storagePath, data, directory: ASSET_DIRECTORY, recursive: true });
      else await Filesystem.appendFile({ path: storagePath, data, directory: ASSET_DIRECTORY });
    }
    return restoreAsset({ ...asset, url: "", storagePath, storageMimeType: mimeType });
  }));
}

export async function readCanvasProjects(): Promise<MobileCanvasProject[]> {
  try {
    return await readStoredValue<MobileCanvasProject[]>(CANVAS_PROJECTS_KEY) || [];
  } catch {
    return [];
  }
}

export async function writeCanvasProjects(projects: MobileCanvasProject[]) {
  const operation = canvasWriteQueue.then(() => writeStoredValue(CANVAS_PROJECTS_KEY, projects));
  canvasWriteQueue = operation.then(() => undefined, () => undefined);
  await operation;
}
