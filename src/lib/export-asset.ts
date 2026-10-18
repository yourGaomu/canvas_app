import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { API_BASE_URL } from "../api/client";
import type { GeneratedAsset } from "../types";

function getExtension(asset: GeneratedAsset, mimeType: string) {
  if (asset.kind === "text") return "txt";
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.toLowerCase();
  if (subtype === "jpeg") return "jpg";
  if (subtype && /^[a-z0-9]+$/.test(subtype)) return subtype;
  return asset.kind === "video" ? "mp4" : "png";
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function getAssetUrl(value: string) {
  return new URL(value, API_BASE_URL || window.location.origin).toString();
}

function getAssetHeaders(url: string, apiToken: string) {
  if (!apiToken) return undefined;
  try {
    const assetOrigin = new URL(url).origin;
    const apiOrigin = new URL(API_BASE_URL || window.location.origin).origin;
    return assetOrigin === apiOrigin ? { Authorization: `Bearer ${apiToken}` } : undefined;
  } catch {
    return undefined;
  }
}

export async function exportAsset(asset: GeneratedAsset, apiToken = "") {
  const filename = `infinite-canvas-${asset.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const assetUrl = getAssetUrl(asset.url);
  const headers = getAssetHeaders(assetUrl, apiToken);
  if (Capacitor.isNativePlatform()) {
    const dataMatch = assetUrl.match(/^data:([^;,]+)?;base64,(.+)$/);
    const mimeType = dataMatch?.[1] || (asset.kind === "video" ? "video/mp4" : asset.kind === "text" ? "text/plain" : "image/png");
    const path = `exports/${filename}.${getExtension(asset, mimeType)}`;
    if (assetUrl.startsWith("data:")) {
      const blob = await (await fetch(assetUrl)).blob();
      await Filesystem.writeFile({ path, data: dataMatch?.[2] || toBase64(new Uint8Array(await blob.arrayBuffer())), directory: Directory.Cache, recursive: true });
    } else {
      await Filesystem.downloadFile({ url: assetUrl, path, directory: Directory.Cache, recursive: true, headers });
    }
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: filename, files: [uri], dialogTitle: "导出或保存素材" });
    return;
  }

  const response = await fetch(assetUrl, { headers });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.${getExtension(asset, blob.type)}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
