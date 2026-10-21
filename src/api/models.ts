import { apiRequest, modelCapability } from "./client";
import type { Model } from "../types";
import { logger } from "../lib/logger";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function modelRows(payload: unknown): Array<Record<string, unknown>> {
  let current = payload;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Array.isArray(current)) return current.filter(isRecord);
    if (!isRecord(current)) return [];
    for (const key of ["data", "models", "items", "results"]) {
      const value = current[key];
      if (Array.isArray(value)) return value.filter(isRecord);
    }
    const nested = current.data || current.models || current.items || current.results;
    if (!isRecord(nested)) return [];
    current = nested;
  }
  return [];
}

export async function listModels(apiToken: string): Promise<Model[]> {
  logger.info("models:list:start");
  const payload = await apiRequest<unknown>("/v1/models", { token: apiToken });
  const rows = modelRows(payload);
  const models = rows
    .map((item) => String(item.id || item.model_name || item.name || item.model || "").trim())
    .filter(Boolean)
    .map((id) => ({ id, capability: modelCapability(id) }));
  logger.info("models:list:success", { count: models.length, models: models.map((model) => model.id) });
  return models;
}
