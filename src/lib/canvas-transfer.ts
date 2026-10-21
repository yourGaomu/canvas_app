import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter, type FileEntry } from "@zip.js/zip.js";
import { API_BASE_URL } from "../api/client";
import type { GeneratedAsset, MobileCanvasProject } from "../types";

const FORMAT = "infinite-canvas-project";
const VERSION = 1;
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 220 * 1024 * 1024;
const MAX_ASSETS_BYTES = 200 * 1024 * 1024;
const MAX_ASSET_COUNT = 5000;
const MAX_PROJECT_NODES = 10000;
const MAX_PROJECT_CONNECTIONS = 50000;

type AssetDescriptor = Pick<GeneratedAsset, "id" | "kind" | "model" | "prompt" | "createdAt" | "inLibrary"> & {
  path: string;
  mimeType: string;
};

type CanvasEnvelope = {
  format: typeof FORMAT;
  version: number;
  mode: "json" | "bundle";
  project: MobileCanvasProject;
  assets?: AssetDescriptor[];
};

export type ImportedCanvasFile = {
  project: MobileCanvasProject;
  assets: Array<{ sourceId: string; asset: Omit<GeneratedAsset, "id">; blob: Blob }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateProject(value: unknown): MobileCanvasProject {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || !Number.isFinite(value.updatedAt) || !Array.isArray(value.nodes) || !Array.isArray(value.connections)) {
    throw new Error("画布文件格式不正确");
  }
  if (value.nodes.length > MAX_PROJECT_NODES || value.connections.length > MAX_PROJECT_CONNECTIONS) throw new Error("画布节点或连线数量超出限制");
  const nodeTypes = new Set(["asset", "image-generation", "video-generation", "text", "group"]);
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || !nodeTypes.has(String(node.type)) || !Number.isFinite(node.x) || !Number.isFinite(node.y)) throw new Error("画布包含无效节点");
    if ((node.assetId !== undefined && typeof node.assetId !== "string") || (node.assetIds !== undefined && (!Array.isArray(node.assetIds) || node.assetIds.some((id) => typeof id !== "string")))) throw new Error("画布节点包含无效的素材引用");
    for (const key of ["model", "prompt", "title", "groupId"] as const) {
      if (node[key] !== undefined && typeof node[key] !== "string") throw new Error("画布节点包含无效文本字段");
    }
    for (const key of ["imageCount", "width", "height", "widthPx"] as const) {
      if (node[key] !== undefined && !Number.isFinite(node[key])) throw new Error("画布节点包含无效尺寸或数量");
    }
    if (nodeIds.has(node.id)) throw new Error("画布包含重复节点 ID");
    nodeIds.add(node.id);
  }
  for (const connection of value.connections) {
    if (!isRecord(connection) || typeof connection.id !== "string" || typeof connection.fromNodeId !== "string" || typeof connection.toNodeId !== "string") throw new Error("画布包含无效连线");
    if (!nodeIds.has(connection.fromNodeId) || !nodeIds.has(connection.toNodeId)) throw new Error("画布连线引用了不存在的节点");
  }
  return value as unknown as MobileCanvasProject;
}

function parseEnvelope(value: unknown) {
  if (!isRecord(value)) throw new Error("文件内容不是有效的画布数据");
  if (value.format !== FORMAT) return { project: validateProject(value), descriptors: [] as AssetDescriptor[] };
  if (value.version !== VERSION) throw new Error(`不支持画布文件版本：${String(value.version)}`);
  if (value.mode !== "json" && value.mode !== "bundle") throw new Error("画布文件类型无效");
  const descriptors = value.assets;
  if (value.mode === "json" && descriptors !== undefined) throw new Error("JSON 画布不应包含素材清单");
  if (value.mode === "bundle" && !Array.isArray(descriptors)) throw new Error("完整素材包缺少素材清单");
  return {
    project: validateProject(value.project),
    descriptors: (descriptors || []) as AssetDescriptor[],
  };
}

export function createCanvasJsonBlob(project: MobileCanvasProject) {
  const envelope: CanvasEnvelope = { format: FORMAT, version: VERSION, mode: "json", project };
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
  if (blob.size > MAX_JSON_BYTES) throw new Error("画布 JSON 超过 20 MB 限制");
  return blob;
}

function referencedAssetIds(project: MobileCanvasProject) {
  return [...new Set(project.nodes.flatMap((node) => [node.assetId, ...(node.assetIds || [])]).filter((id): id is string => Boolean(id)))];
}

function assetMimeType(asset: GeneratedAsset, blob?: Blob) {
  return (asset.storageMimeType || blob?.type || (asset.kind === "video" ? "video/mp4" : asset.kind === "text" ? "text/plain" : "image/png")).split(";")[0].trim().toLowerCase();
}

function fileExtension(mimeType: string, kind: GeneratedAsset["kind"]) {
  if (kind === "text") return "txt";
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
  return extensions[mimeType.toLowerCase()] || (kind === "video" ? "mp4" : "bin");
}

async function readAssetBlob(asset: GeneratedAsset, apiToken: string) {
  if (asset.storagePath) {
    const { data } = await Filesystem.readFile({ path: asset.storagePath, directory: Directory.Data, ...(asset.kind === "text" ? { encoding: Encoding.UTF8 } : {}) });
    if (data instanceof Blob) return data;
    if (asset.kind === "text") return new Blob([data], { type: assetMimeType(asset) });
    const binary = await (await fetch(`data:${assetMimeType(asset)};base64,${data}`)).blob();
    return binary;
  }
  if (asset.kind === "text") return new Blob([asset.content || ""], { type: assetMimeType(asset) });
  if (!asset.url) throw new Error(`素材「${asset.prompt || asset.id}」没有可读取的文件`);
  let url = asset.url;
  try {
    url = new URL(asset.url, API_BASE_URL || window.location.origin).toString();
  } catch {
    throw new Error(`素材「${asset.prompt || asset.id}」地址无效`);
  }
  const headers: Record<string, string> = {};
  if (apiToken) {
    try {
      if (new URL(url).origin === new URL(API_BASE_URL || window.location.origin).origin) headers.Authorization = `Bearer ${apiToken}`;
    } catch {
      // Data and blob URLs do not accept authorization headers.
    }
  }
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`读取素材「${asset.prompt || asset.id}」失败：HTTP ${response.status}`);
  return response.blob();
}

async function readZipEntryBlob(entry: FileEntry, mimeType: string, maxSize: number) {
  let size = 0;
  const chunks: Uint8Array[] = [];
  const writer = new WritableStream<Uint8Array>({
    write(chunk) {
      size += chunk.byteLength;
      if (size > maxSize) throw new Error("ZIP 文件解压后超过大小限制");
      chunks.push(chunk);
    },
  });
  await entry.getData(writer, { checkCrc32: true });
  return new Blob(chunks as BlobPart[], { type: mimeType });
}

export async function createCanvasBundleBlob(project: MobileCanvasProject, assets: GeneratedAsset[], apiToken: string) {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const referenced = referencedAssetIds(project);
  if (referenced.length > MAX_ASSET_COUNT) throw new Error("当前画布引用的素材数量过多，无法打包");
  const blobWriter = new BlobWriter("application/zip");
  const zipWriter = new ZipWriter(blobWriter);
  const descriptors: AssetDescriptor[] = [];
  let totalBytes = 0;
  try {
    for (const [index, id] of referenced.entries()) {
      const asset = assetById.get(id);
      if (!asset) throw new Error(`找不到画布引用的素材：${id}`);
      const blob = await readAssetBlob(asset, apiToken);
      if (!blob.size && asset.kind !== "text") throw new Error(`素材「${asset.prompt || id}」为空文件，无法打包`);
      totalBytes += blob.size;
      if (totalBytes > MAX_ASSETS_BYTES) throw new Error("当前画布素材总量超过 200 MB，请改用仅 JSON 导出");
      const mimeType = assetMimeType(asset, blob);
      const path = `assets/${index}.${fileExtension(mimeType, asset.kind)}`;
      descriptors.push({ id: asset.id, kind: asset.kind, model: asset.model, prompt: asset.prompt, createdAt: asset.createdAt, inLibrary: asset.inLibrary, path, mimeType });
      await zipWriter.add(path, new BlobReader(blob), { level: 0 });
    }
    const envelope: CanvasEnvelope = { format: FORMAT, version: VERSION, mode: "bundle", project, assets: descriptors };
    const manifest = JSON.stringify(envelope, null, 2);
    if (new Blob([manifest]).size > MAX_JSON_BYTES) throw new Error("画布清单超过 20 MB 限制");
    await zipWriter.add("manifest.json", new TextReader(manifest), { level: 0 });
    await zipWriter.close();
  } catch (error) {
    await zipWriter.close().catch(() => undefined);
    throw error;
  }
  const blob = await blobWriter.getData();
  if (blob.size > MAX_BUNDLE_BYTES) throw new Error("完整素材包超过 220 MB，无法安全导出");
  return blob;
}

function validateAssetDescriptors(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_ASSET_COUNT) throw new Error("素材清单无效或数量超出限制");
  const ids = new Set<string>();
  const paths = new Set<string>();
  return value.map((item): AssetDescriptor => {
    if (!isRecord(item) || typeof item.id !== "string" || !["image", "video", "text"].includes(String(item.kind)) || typeof item.path !== "string" || typeof item.mimeType !== "string" || typeof item.model !== "string" || typeof item.prompt !== "string" || !Number.isFinite(item.createdAt)) {
      throw new Error("素材清单包含无效项目");
    }
    if (!/^assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(item.path) || item.path.includes("..")) throw new Error("素材包包含不安全的文件路径");
    const kind = String(item.kind);
    const mimeType = String(item.mimeType).toLowerCase();
    if (item.inLibrary !== undefined && typeof item.inLibrary !== "boolean") throw new Error("素材清单包含无效项目");
    const validMimeType = kind === "image" ? /^image\/[a-z0-9.+-]+$/.test(mimeType)
      : kind === "video" ? /^video\/[a-z0-9.+-]+$/.test(mimeType)
        : mimeType === "text/plain";
    if (!validMimeType) throw new Error(`素材类型与文件格式不匹配：${item.path}`);
    if (ids.has(item.id) || paths.has(item.path)) throw new Error("素材包包含重复的素材 ID 或路径");
    ids.add(item.id);
    paths.add(item.path);
    return item as unknown as AssetDescriptor;
  });
}

async function readJsonFile(file: File): Promise<ImportedCanvasFile> {
  if (file.size > MAX_JSON_BYTES) throw new Error("JSON 画布文件超过 20 MB 限制");
  const parsed = JSON.parse(await file.text()) as unknown;
  if (isRecord(parsed) && parsed.format === FORMAT && parsed.mode !== "json") throw new Error("完整素材包请使用 ZIP 文件导入");
  const { project, descriptors } = parseEnvelope(parsed);
  if (descriptors.length) throw new Error("此 JSON 文件不支持内嵌素材，请使用完整素材包");
  return { project, assets: [] };
}

async function readBundleFile(file: File): Promise<ImportedCanvasFile> {
  if (file.size > MAX_BUNDLE_BYTES) throw new Error("完整素材包超过 220 MB 限制");
  const zipReader = new ZipReader(new BlobReader(file));
  try {
    const entries = await zipReader.getEntries();
    if (entries.length > MAX_ASSET_COUNT + 1) throw new Error("素材包文件数量超出限制");
    const byName = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) {
      if (entry.directory || entry.symlink || entry.executable || entry.filename.includes("..") || entry.filename.includes("\\") || entry.filename.startsWith("/")) throw new Error("素材包包含不安全的文件路径或项目");
      if (byName.has(entry.filename)) throw new Error("素材包包含重复文件");
      byName.set(entry.filename, entry);
    }
    const manifestEntry = byName.get("manifest.json");
    if (!manifestEntry || !Number.isFinite(manifestEntry.uncompressedSize) || manifestEntry.uncompressedSize < 0 || manifestEntry.uncompressedSize > MAX_JSON_BYTES) throw new Error("完整素材包缺少有效的 manifest.json");
    if (manifestEntry.directory) throw new Error("完整素材包清单不是文件");
    const manifestBlob = await readZipEntryBlob(manifestEntry, "application/json", MAX_JSON_BYTES);
    const envelopeValue = JSON.parse(await manifestBlob.text()) as unknown;
    if (!isRecord(envelopeValue) || envelopeValue.format !== FORMAT || envelopeValue.mode !== "bundle") throw new Error("这不是 Infinite Canvas 完整素材包");
    const { project, descriptors: rawDescriptors } = parseEnvelope(envelopeValue);
    const descriptors = validateAssetDescriptors(rawDescriptors);
    const referencedIds = referencedAssetIds(project);
    if (referencedIds.length !== descriptors.length || referencedIds.some((id) => !descriptors.some((descriptor) => descriptor.id === id))) throw new Error("素材清单与画布引用不一致，无法保证完整恢复");
    const expectedPaths = new Set(["manifest.json", ...descriptors.map((asset) => asset.path)]);
    if (byName.size !== expectedPaths.size || [...byName.keys()].some((path) => !expectedPaths.has(path))) throw new Error("素材包文件与素材清单不匹配");
    let totalBytes = 0;
    const importedAssets = [] as ImportedCanvasFile["assets"];
    for (const descriptor of descriptors) {
      const entry = byName.get(descriptor.path);
      if (!entry || entry.directory || !Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_ASSETS_BYTES) throw new Error(`素材文件无效：${descriptor.path}`);
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_ASSETS_BYTES) throw new Error("完整素材包解压后超过 200 MB 限制");
      const blob = await readZipEntryBlob(entry, descriptor.mimeType, MAX_ASSETS_BYTES - (totalBytes - entry.uncompressedSize));
      if (blob.size !== entry.uncompressedSize) throw new Error(`素材文件大小校验失败：${descriptor.path}`);
      if (!blob.size && descriptor.kind !== "text") throw new Error(`素材文件为空：${descriptor.path}`);
      const { id: sourceId, path: _path, mimeType, ...metadata } = descriptor;
      const asset = { ...metadata, url: "", storageMimeType: mimeType, ...(metadata.kind === "text" ? { content: await blob.text() } : {}) };
      importedAssets.push({ sourceId, asset, blob });
    }
    return { project, assets: importedAssets };
  } finally {
    await zipReader.close();
  }
}

export async function readCanvasTransferFile(file: File): Promise<ImportedCanvasFile> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json") || file.type === "application/json") return readJsonFile(file);
  if (name.endsWith(".zip") || file.type.includes("zip")) return readBundleFile(file);
  const firstCharacter = (await file.slice(0, 1).text()).trim();
  if (firstCharacter === "{") return readJsonFile(file);
  return readBundleFile(file);
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export async function deliverCanvasFile(fileName: string, blob: Blob) {
  if (Capacitor.isNativePlatform()) {
    const path = `exports/${fileName}`;
    if (!blob.size) await Filesystem.writeFile({ path, data: "", directory: Directory.Cache, recursive: true });
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
      const data = toBase64(bytes);
      if (offset === 0) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
      else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    }
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: fileName, files: [uri], dialogTitle: "导出画布" });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function canvasFileName(project: MobileCanvasProject, extension: "json" | "zip") {
  const title = project.title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 80) || "canvas";
  return `${title}.${extension}`;
}
