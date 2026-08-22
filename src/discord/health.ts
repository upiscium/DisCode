import type { OpenCodeHttpHealth, OpenCodeSseState } from "../opencode/diagnostics.js";

export function renderHealthDiagnostic(
  http: OpenCodeHttpHealth,
  sse: OpenCodeSseState,
): string {
  const ready = http.kind === "healthy" && sse === "connected";
  return [
    `Bridge: **${ready ? "ready" : "degraded"}**`,
    `OpenCode HTTP: **${renderHttpHealth(http)}**`,
    `Global SSE: **${sse}**`,
  ].join("\n");
}

function renderHttpHealth(health: OpenCodeHttpHealth): string {
  switch (health.kind) {
    case "healthy":
      return health.version ? `healthy (${sanitizeInline(health.version)})` : "healthy";
    case "unauthorized":
      return `unauthorized (HTTP ${health.status})`;
    case "http_error":
      return `HTTP ${health.status}`;
    case "invalid_response":
      return "invalid response";
    case "unreachable":
      return "unreachable";
  }
}

function sanitizeInline(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/\*/g, "∗");
}
