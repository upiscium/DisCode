import { afterEach, describe, expect, it, vi } from "vitest";
import { openCodeCommand } from "../src/discord/commands.js";
import { renderHealthDiagnostic } from "../src/discord/health.js";
import { OpenCodeSseMonitor, probeOpenCodeHealth } from "../src/opencode/diagnostics.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operator health diagnostics", () => {
  it("registers /oc health independently of a bound session", () => {
    const command = openCodeCommand.toJSON();
    expect(command.options?.some((option) => option.name === "health")).toBe(true);
  });

  it("probes authenticated OpenCode health and renders ready", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ healthy: true, version: "1.18.20" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const health = await probeOpenCodeHealth({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "test-secret",
    });

    expect(health).toEqual({ kind: "healthy", version: "1.18.20" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe("http://127.0.0.1:4096/global/health");
    expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("opencode:test-secret", "utf8").toString("base64")}`,
    );

    const rendered = renderHealthDiagnostic(health, "connected");
    expect(rendered).toContain("Bridge: **ready**");
    expect(rendered).toContain("OpenCode HTTP: **healthy (1.18.20)**");
    expect(rendered).toContain("Global SSE: **connected**");
    expect(rendered).not.toContain("test-secret");
  });

  it("does not report ready when HTTP is healthy but SSE is disconnected", () => {
    const rendered = renderHealthDiagnostic(
      { kind: "healthy", version: "1.18.20" },
      "disconnected",
    );

    expect(rendered).toContain("Bridge: **degraded**");
    expect(rendered).toContain("Global SSE: **disconnected**");
  });

  it("returns a diagnostic result for auth failure instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );

    const health = await probeOpenCodeHealth({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "wrong-secret",
    });

    expect(health).toEqual({ kind: "unauthorized", status: 401 });
    expect(renderHealthDiagnostic(health, "connected")).toContain(
      "OpenCode HTTP: **unauthorized (HTTP 401)**",
    );
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
    expect(renderHealthDiagnostic(health, "disconnected")).toContain(
      "OpenCode HTTP: **unreachable**",
    );
  });

  it("marks SSE disconnected when event heartbeat freshness expires", () => {
    const monitor = new OpenCodeSseMonitor(25_000);

    expect(monitor.status(1000)).toBe("disconnected");
    monitor.observe(1000);
    expect(monitor.status(25_999)).toBe("connected");
    expect(monitor.status(26_001)).toBe("disconnected");
  });
});
