import { apiRequest, modelCapability } from "./client";
import type { Model } from "../types";
import { logger } from "../lib/logger";

export async function listModels(apiToken: string): Promise<Model[]> {
  logger.info("models:list:start");
  const payload = await apiRequest<{ data?: Array<{ id?: string }> } | Array<{ id?: string }>>("/v1/models", { token: apiToken });
  const rows = Array.isArray(payload) ? payload : payload.data || [];
  const models = rows
    .map((item) => String(item.id || "").trim())
    .filter(Boolean)
    .map((id) => ({ id, capability: modelCapability(id) }));
  logger.info("models:list:success", { count: models.length, models: models.map((model) => model.id) });
  return models;
}
