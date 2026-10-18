import { Capacitor, registerPlugin } from "@capacitor/core";

const PREFIX = "[mikasa-app]";
const NativeAppLogger = registerPlugin<{ write(options: { level: string; message: string }): Promise<void> }>("AppLogger");

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:")) return `[data-url:${value.length} chars]`;
    return value
      .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
      .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret|cookie|session(?:[_-]?id)?|x-auth-session)["']?\s*[:=]\s*["']?)[^,\s}"']+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /key|token|authorization|password|secret|cookie|session/i.test(key) ? "[redacted]" : redact(item)]));
  }
  return value;
}

function write(method: "info" | "warn" | "error", message: string, details?: unknown) {
  const safeDetails = details === undefined ? undefined : redact(details);
  if (Capacitor.getPlatform() === "android") {
    const line = safeDetails === undefined ? message : `${message} ${JSON.stringify(safeDetails)}`;
    void NativeAppLogger.write({ level: method, message: `${PREFIX} ${line}` }).catch(() => {});
    return;
  }
  console[method](...(safeDetails === undefined ? [PREFIX, message] : [PREFIX, message, safeDetails]));
}

export const logger = {
  info: (message: string, details?: unknown) => write("info", message, details),
  warn: (message: string, details?: unknown) => write("warn", message, details),
  error: (message: string, details?: unknown) => write("error", message, details),
};
