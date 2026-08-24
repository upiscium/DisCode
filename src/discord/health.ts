import type { OpenCodeHostHealthDiagnostic, OpenCodeHttpHealth } from "../opencode/diagnostics.js";

export function renderHealthDiagnostic(hosts: readonly OpenCodeHostHealthDiagnostic[]): string {
  const readyCount = hosts.filter(isReady).length;
  const bridgeReady = hosts.length > 0 && readyCount === hosts.length;
  const lines = [
    `Bridge: **${bridgeReady ? "ready" : "degraded"}**`,
    `Hosts: **${readyCount}/${hosts.length} ready**`,
  ];

  for (const host of hosts) {
    lines.push(
      "",
      `Host \`${sanitizeCode(host.id)}\`${host.isDefault ? " (default)" : ""}: **${isReady(host) ? "ready" : "degraded"}**`,
      `OpenCode HTTP: **${renderHttpHealth(host.http)}**`,
      `Global SSE: **${host.sse}**`,
    );
  }

  return lines.join("\n");
}

function isReady(host: OpenCodeHostHealthDiagnostic): boolean {
  return host.http.kind === "healthy" && host.sse === "connected";
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

function sanitizeCode(value: string): string {
  return value.replace(/`/g, "ˋ").replace(/[\r\n]/g, " ");
}
