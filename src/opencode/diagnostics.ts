export type OpenCodeHttpHealth =
  | { kind: "healthy"; version?: string }
  | { kind: "unauthorized"; status: number }
  | { kind: "http_error"; status: number }
  | { kind: "invalid_response" }
  | { kind: "unreachable" };

export type OpenCodeSseState = "connected" | "disconnected";

export async function probeOpenCodeHealth(options: {
  baseUrl: string;
  username: string;
  password?: string;
  timeoutMs?: number;
}): Promise<OpenCodeHttpHealth> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
