import { type LoggerLike, noopLogger } from "../logging/logger.js";

export type OpenCodeHttpHealth =
  | { kind: "healthy"; version?: string }
  | { kind: "unauthorized"; status: number }
  | { kind: "http_error"; status: number }
  | { kind: "invalid_response" }
  | { kind: "unreachable" };

export type OpenCodeSseState = "connected" | "disconnected";

export type OpenCodeHealthProbeOptions = Readonly<{
  baseUrl: string;
  username: string;
  password?: string;
  timeoutMs?: number;
}>;

export type OpenCodeHostHealthTarget = Readonly<{
  id: string;
  isDefault: boolean;
  baseUrl: string;
  username: string;
  password?: string;
  sse: OpenCodeSseState;
}>;

export type OpenCodeHostHealthDiagnostic = Readonly<{
  id: string;
  isDefault: boolean;
  http: OpenCodeHttpHealth;
  sse: OpenCodeSseState;
}>;

export type OpenCodeHostHealthProbeRunOptions = Readonly<{
  emitDegradedLog?: boolean;
  observeDuration?: (hostId: string, durationSeconds: number) => void;
  now?: () => number;
}>;

let healthLogger: LoggerLike = noopLogger;

export function setOpenCodeHealthLogger(logger: LoggerLike): void {
  healthLogger = logger;
}

export async function probeOpenCodeHealth(
  options: OpenCodeHealthProbeOptions,
): Promise<OpenCodeHttpHealth> {
  const headers: Record<string, string> = {};
  if (options.password) {
    const credentials = Buffer.from(`${options.username}:${options.password}`, "utf8").toString(
      "base64",
    );
    headers.Authorization = `Basic ${credentials}`;
  }

  try {
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/global/health`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });

    if (response.status === 401 || response.status === 403) {
      return { kind: "unauthorized", status: response.status };
    }
    if (!response.ok) {
      return { kind: "http_error", status: response.status };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "invalid_response" };
    }
    if (!isRecord(body) || body.healthy !== true) {
      return { kind: "invalid_response" };
    }

    return {
      kind: "healthy",
      ...(typeof body.version === "string" ? { version: body.version } : {}),
    };
  } catch {
    return { kind: "unreachable" };
  }
}

export async function probeOpenCodeHostsHealth(
  targets: readonly OpenCodeHostHealthTarget[],
  probe: (options: OpenCodeHealthProbeOptions) => Promise<OpenCodeHttpHealth> = probeOpenCodeHealth,
  options: OpenCodeHostHealthProbeRunOptions = {},
): Promise<readonly OpenCodeHostHealthDiagnostic[]> {
  const now = options.now ?? (() => performance.now());
  const diagnostics = await Promise.all(
    targets.map(async (target) => {
      const startedAt = now();
      let http: OpenCodeHttpHealth;
      try {
        http = await probe({
          baseUrl: target.baseUrl,
          username: target.username,
          ...(target.password ? { password: target.password } : {}),
        });
      } catch {
        http = { kind: "unreachable" };
      } finally {
        options.observeDuration?.(target.id, Math.max(0, (now() - startedAt) / 1000));
      }

      return {
        id: target.id,
        isDefault: target.isDefault,
        http,
        sse: target.sse,
      };
    }),
  );

  if (options.emitDegradedLog !== false) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.http.kind === "healthy" && diagnostic.sse === "connected") continue;
      healthLogger.warn("opencode.health_degraded", "OpenCode host health degraded", {
        host_id: diagnostic.id,
        http_state: diagnostic.http.kind,
        sse_state: diagnostic.sse,
        ...healthHttpStatusField(diagnostic.http),
      });
    }
  }

  return diagnostics;
}

export class OpenCodeSseMonitor {
  readonly #staleAfterMs: number;
  #lastEventAt: number | undefined;

  constructor(staleAfterMs = 25_000) {
    this.#staleAfterMs = staleAfterMs;
  }

  observe(now = Date.now()): void {
    this.#lastEventAt = now;
  }

  status(now = Date.now()): OpenCodeSseState {
    if (this.#lastEventAt === undefined) return "disconnected";
    return now - this.#lastEventAt <= this.#staleAfterMs ? "connected" : "disconnected";
  }
}

function healthHttpStatusField(health: OpenCodeHttpHealth): { http_status?: number } {
  if (health.kind === "unauthorized" || health.kind === "http_error") {
    return { http_status: health.status };
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
