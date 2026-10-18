export type MobilePrompt = {
  id: string;
  title: string;
  prompt: string;
  description: string;
  coverUrl: string;
  tags: string[];
  category: string;
};

const sourceBase = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources";
const sourceNames = [
  ["banana-prompt-quicker", "Banana Prompt Quicker"],
  ["davidwu-gpt-image2-prompts", "DavidWu GPT Image 2"],
  ["freestylefly-gpt-image-2", "Freestylefly GPT Image 2"],
  ["awesome-gpt-image", "Awesome GPT Image"],
  ["awesome-gpt4o-image-prompts", "Awesome GPT-4o"],
  ["youmind-gpt-image-2", "YouMind GPT Image 2"],
  ["youmind-nano-banana-pro", "YouMind Nano Banana Pro"],
] as const;

function absoluteUrl(baseUrl: string, value: string) {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

let promptCache: { expiresAt: number; items: MobilePrompt[] } | null = null;
let pendingRequest: Promise<MobilePrompt[]> | null = null;

export function fetchPromptLibrary() {
  if (promptCache && promptCache.expiresAt > Date.now()) return Promise.resolve(promptCache.items);
  if (pendingRequest) return pendingRequest;
  pendingRequest = Promise.allSettled(sourceNames.map(async ([id, category]) => {
    const sourceUrl = `${sourceBase}/${id}.json`;
    const response = await fetch(sourceUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`${category}: HTTP ${response.status}`);
    const values: unknown = await response.json();
    if (!Array.isArray(values)) throw new Error(`${category}: 数据格式无效`);
    return values.flatMap((value, index): MobilePrompt[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      if (typeof item.title !== "string" || typeof item.prompt !== "string") return [];
      const title = item.title.trim();
      const prompt = item.prompt.trim();
      if (!title || !prompt) return [];
      const referenceImages = Array.isArray(item.referenceImageUrls) ? item.referenceImageUrls.filter((url): url is string => typeof url === "string") : [];
      const cover = typeof item.coverUrl === "string" ? item.coverUrl : "";
      return [{
        id: typeof item.id === "string" ? item.id : `${id}-${index + 1}`,
        title,
        prompt,
        description: typeof item.description === "string" ? item.description : "",
        coverUrl: absoluteUrl(sourceUrl, cover || referenceImages[0] || ""),
        tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
        category,
      }];
    });
  })).then((results) => {
    const items = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (!items.length) throw new Error("提示词库暂时无法加载，请检查网络后重试");
    promptCache = { items, expiresAt: Date.now() + 30 * 60 * 1000 };
    return items;
  }).finally(() => { pendingRequest = null; });
  return pendingRequest;
}
