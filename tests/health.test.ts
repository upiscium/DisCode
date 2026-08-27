import { afterEach, describe, expect, it, vi } from "vitest";
import { openCodeCommand } from "../src/discord/commands.js";
import { renderHealthDiagnostic } from "../src/discord/health.js";
import { type LoggerLike, noopLogger } from "../src/logging/logger.js";
import {
  type OpenCodeHealthProbeOptions,
  type OpenCodeHttpHealth,
  OpenCodeSseMonitor,
  probeOpenCodeHealth,
  probeOpenCodeHostsHealth,
  setOpenCodeHealthLogger,
} from "../src/opencode/diagnostics.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setOpenCodeHealthLogger(noopLogger);
});

describe("operator health diagnostics", () => {
  it("registers /oc health independently of a bound session", () => {
    const command = openCodeCommand.toJSON();
    expect(command.options?.some((option) => option.name === "health")).toBe(true);
  });

  it("probes authenticated OpenCode health", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ healthy: true, version: "1.18.20" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const fixtureCredential = ["fixture", "credential"].join("-");

    const health = await probeOpenCodeHealth({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: fixtureCredential,
    });

    expect(health).toEqual({ kind: "healthy", version: "1.18.20" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe("http://127.0.0.1:4096/global/health");
    expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from(`opencode:${fixtureCredential}`, "utf8").toString("base64")}`,
    );
  });

  it("probes configured hosts concurrently and preserves registry order", async () => {
    const resolvers = new Map<string, (health: OpenCodeHttpHealth) => void>();
    const probe = vi.fn(
      (options: OpenCodeHealthProbeOptions) =>
        new Promise<OpenCodeHttpHealth>((resolve) => {
          resolvers.set(options.baseUrl, resolve);
        }),
    );

    const resultPromise = probeOpenCodeHostsHealth(
      [
        {
          id: "local",
          isDefault: true,
          baseUrl: "http://127.0.0.1:4096",
          username: "opencode",
          sse: "connected",
        },
        {
          id: "secondary",
          isDefault: false,
          baseUrl: "http://127.0.0.1:4097",
          username: "opencode",
          sse: "disconnected",
        },
      ],
      probe,
    );

    expect(probe).toHaveBeenCalledTimes(2);
    expect(resolvers.size).toBe(2);

    resolvers.get("http://127.0.0.1:4097")?.({ kind: "unreachable" });
    resolvers.get("http://127.0.0.1:4096")?.({ kind: "healthy", version: "1.18.20" });

    await expect(resultPromise).resolves.toEqual([
      {
        id: "local",
        isDefault: true,
        http: { kind: "healthy", version: "1.18.20" },
        sse: "connected",
      },
      {
        id: "secondary",
        isDefault: false,
        http: { kind: "unreachable" },
        sse: "disconnected",
      },
    ]);
  });

  it("isolates a thrown host probe failure as unreachable", async () => {
    const probe = vi.fn(
      async (options: OpenCodeHealthProbeOptions): Promise<OpenCodeHttpHealth> => {
        if (options.baseUrl.endsWith(":4097")) throw new Error("connection refused");
        return { kind: "healthy", version: "1.18.20" };
      },
    );

    const health = await probeOpenCodeHostsHealth(
      [
        {
          id: "local",
          isDefault: true,
          baseUrl: "http://127.0.0.1:4096",
          username: "opencode",
          sse: "connected",
        },
        {
          id: "secondary",
          isDefault: false,
          baseUrl: "http://127.0.0.1:4097",
          username: "opencode",
          sse: "connected",
        },
      ],
      probe,
    );

    expect(health[0]?.http).toEqual({ kind: "healthy", version: "1.18.20" });
    expect(health[1]?.http).toEqual({ kind: "unreachable" });
  });

  it("logs degraded host health with stable host-aware fields and no endpoint payload", async () => {
    const warn = vi.fn<LoggerLike["warn"]>();
    setOpenCodeHealthLogger({ ...noopLogger, warn });

    await probeOpenCodeHostsHealth(
      [
        {
          id: "host-1",
          isDefault: true,
          baseUrl: "http://127.0.0.1:4096",
          username: "opencode",
          sse: "connected",
        },
        {
          id: "host-2",
          isDefault: false,
          baseUrl: "http://10.12.0.2:4096",
          username: "opencode",
          sse: "disconnected",
        },
      ],
      async (options) =>
        options.baseUrl.includes("10.12.0.2")
          ? { kind: "unreachable" }
          : { kind: "healthy", version: "1.18.20" },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("opencode.health_degraded", "OpenCode host health degraded", {
      host_id: "host-2",
      http_state: "unreachable",
      sse_state: "disconnected",
    });
    const loggedFields = warn.mock.calls[0]?.[2] ?? {};
    expect(JSON.stringify(loggedFields)).not.toContain("10.12.0.2");
    expect(loggedFields).not.toHaveProperty("base_url");
    expect(loggedFields).not.toHaveProperty("username");
  });

  it("renders aggregate ready state when every host is healthy and connected", () => {
    const rendered = renderHealthDiagnostic([
      {
        id: "local",
        isDefault: true,
        http: { kind: "healthy", version: "1.18.20" },
        sse: "connected",
      },
      {
        id: "secondary",
        isDefault: false,
        http: { kind: "healthy", version: "1.18.20" },
        sse: "connected",
      },
    ]);

    expect(rendered).toContain("Bridge: **ready**");
    expect(rendered).toContain("Hosts: **2/2 ready**");
    expect(rendered).toContain("Host `local` (default): **ready**");
    expect(rendered).toContain("Host `secondary`: **ready**");
    expect(rendered).toContain("OpenCode HTTP: **healthy (1.18.20)**");
    expect(rendered).toContain("Global SSE: **connected**");
  });

  it("renders degraded aggregate state without hiding healthy hosts", () => {
    const rendered = renderHealthDiagnostic([
      {
        id: "local",
        isDefault: true,
        http: { kind: "healthy", version: "1.18.20" },
        sse: "connected",
      },
      {
        id: "secondary",
        isDefault: false,
        http: { kind: "unreachable" },
        sse: "disconnected",
      },
    ]);

    expect(rendered).toContain("Bridge: **degraded**");
    expect(rendered).toContain("Hosts: **1/2 ready**");
    expect(rendered).toContain("Host `local` (default): **ready**");
    expect(rendered).toContain("Host `secondary`: **degraded**");
    expect(rendered).toContain("OpenCode HTTP: **unreachable**");
    expect(rendered).not.toContain("127.0.0.1");
  });

  it("renders legacy single-host configuration naturally", () => {
    const rendered = renderHealthDiagnostic([
      {
        id: "default",
        isDefault: true,
        http: { kind: "healthy" },
        sse: "connected",
      },
    ]);

    expect(rendered).toContain("Bridge: **ready**");
    expect(rendered).toContain("Hosts: **1/1 ready**");
    expect(rendered).toContain("Host `default` (default): **ready**");
  });

  it("returns a diagnostic result for auth failure instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );
    const invalidCredential = ["invalid", "credential"].join("-");

    const health = await probeOpenCodeHealth({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: invalidCredential,
    });

    expect(health).toEqual({ kind: "unauthorized", status: 401 });
    expect(
      renderHealthDiagnostic([
        {
          id: "default",
          isDefault: true,
          http: health,
          sse: "connected",
        },
      ]),
    ).toContain("OpenCode HTTP: **unauthorized (HTTP 401)**");
  });

  it("returns unreachable when the health request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );

    const health = await probeOpenCodeHealth({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    expect(health).toEqual({ kind: "unreachable" });
  });

  it("marks SSE disconnected when event heartbeat freshness expires", () => {
    const monitor = new OpenCodeSseMonitor(25_000);

    expect(monitor.status(1000)).toBe("disconnected");
    monitor.observe(1000);
    expect(monitor.status(25_999)).toBe("connected");
    expect(monitor.status(26_001)).toBe("disconnected");
  });
});
