import type { GeneratedAsset, MobileCanvasConnection, MobileCanvasNode } from "../types";

type ResourceKind = GeneratedAsset["kind"];

function isGenerationNode(node: MobileCanvasNode) {
  return node.type === "image-generation" || node.type === "video-generation";
}

function getResourceKind(node: MobileCanvasNode, assetsById: Map<string, GeneratedAsset>): ResourceKind | null {
  if (node.type === "text") return "text";
  if (!node.assetId || !["asset", "image-generation", "video-generation"].includes(node.type)) return null;
  return assetsById.get(node.assetId)?.kind || null;
}

function getGroupResources(group: MobileCanvasNode, nodes: MobileCanvasNode[], assetsById: Map<string, GeneratedAsset>) {
  return nodes.filter((node) => node.groupId === group.id && getResourceKind(node, assetsById) !== null);
}

export function canProvideGenerationInput(node: MobileCanvasNode, nodes: MobileCanvasNode[], assetsById: Map<string, GeneratedAsset>) {
  if (node.type === "group") {
    const resources = getGroupResources(node, nodes, assetsById);
    return resources.length > 0 && resources.every((resource) => getResourceKind(resource, assetsById) !== "video");
  }
  const kind = getResourceKind(node, assetsById);
  return kind !== null && kind !== "video";
}

export function getConnectionError(fromNodeId: string, toNodeId: string, nodes: MobileCanvasNode[], assetsById: Map<string, GeneratedAsset>) {
  const from = nodes.find((node) => node.id === fromNodeId);
  const to = nodes.find((node) => node.id === toNodeId);
  if (!from || !to) return "连接的节点已不存在";
  if (from.id === to.id) return "节点不能连接到自身";
  if (!isGenerationNode(to)) return "输入只能连接到生图或视频生成节点";
  if (from.type === "group") {
    const resources = getGroupResources(from, nodes, assetsById);
    if (!resources.length) return "分组中没有可用的文字或图片输入";
    if (resources.some((resource) => getResourceKind(resource, assetsById) === "video")) return "当前接口暂不支持视频素材作为生成输入";
    return null;
  }
  const kind = getResourceKind(from, assetsById);
  if (!kind) return "只有文字节点或已生成的素材可以作为输入";
  if (kind === "video") return "当前接口暂不支持视频素材作为生成输入";
  return null;
}

export function getConnectedResources(nodeId: string, nodes: MobileCanvasNode[], connections: MobileCanvasConnection[], assetsById: Map<string, GeneratedAsset>) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const sources = connections.filter((connection) => connection.toNodeId === nodeId).flatMap((connection) => {
    const source = nodesById.get(connection.fromNodeId);
    if (!source) return [];
    return source.type === "group" ? nodes.filter((node) => node.groupId === source.id && isResourceNode(node, assetsById)) : isResourceNode(source, assetsById) ? [source] : [];
  });
  const seen = new Set<string>();
  return sources.filter((node) => {
    const key = node.assetId ? `asset:${node.assetId}` : `node:${node.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildGenerationInputs(nodeId: string, prompt: string, nodes: MobileCanvasNode[], connections: MobileCanvasConnection[], assetsById: Map<string, GeneratedAsset>) {
  const resources = getConnectedResources(nodeId, nodes, connections, assetsById);
  const upstreamText = resources.flatMap((node) => {
    if (node.type === "text") return [node.prompt?.trim() || ""];
    const asset = node.assetId ? assetsById.get(node.assetId) : undefined;
    return asset?.kind === "text" ? [asset.prompt.trim()] : [];
  }).filter(Boolean);
  const assetIds = resources.flatMap((node) => node.assetIds?.length ? node.assetIds : node.assetId ? [node.assetId] : []);
  const media = [...new Set(assetIds)].map((id) => assetsById.get(id)).filter((asset): asset is GeneratedAsset => Boolean(asset));
  const images = media.filter((asset) => asset.kind === "image" && asset.url);
  return {
    prompt: [prompt.trim(), ...upstreamText].filter(Boolean).join("\n\n"),
    images: images.map((asset) => asset.url),
    imageCount: images.length,
    videoCount: media.filter((asset) => asset.kind === "video").length,
  };
}

function isResourceNode(node: MobileCanvasNode, assetsById: Map<string, GeneratedAsset>) {
  return getResourceKind(node, assetsById) !== null;
}
