import { describe, expect, it, vi } from "vitest";
import { noopLogger } from "../src/logging/logger.js";
import { PrometheusMetrics } from "../src/metrics/prometheus.js";
import type {
  OpenCodeHostHealthProbeOptions,
  OpenCodeHostHealthTarget,
  OpenCodeHttpHealth,
} from "../src/opencode/diagnostics.js";

type ProbeOptions = Readonly<{
  emitDegradedLog?: boolean;
  observeDuration?: (hostId: string, durationSeconds: number) => void;
}>;

function fixture() {
  let host2Healthy = true;
  let host2Sse: "connected" | "disconnected" = "connected";
  const stateBindings = [
    { hostId: "host-1", sessionId: "ses_PRIVATE", threadId: "thread_PRIVATE" },
    { hostId: "host-1", directory: "/private/repo" },
    { hostId: "host-2" },
  ];
  const host1 = {
    id: "host-1",
    config: {
      baseUrl: "http://127.0.0.1:4096",
      username: "METRICS_USER_SENTINEL",
      password: "PASSWORD_SENTINEL",
    },
    sseMonitor: { status: () => "connected" as const },
  };
  const host2 = {
    id: "host-2",
    config: {
      baseUrl: "http://10.12.0.2:4096",
      username: "SECOND_METRICS_USER_SENTINEL",
      password: "SECOND_PASSWORD_SENTINEL",
    },
    sseMonitor: { status: () => host2Sse },
  };
  const hosts = {
    defaultHost: () => host1,
    list: () => [host1, host2],
  };
  const state = {
    list: () => stateBindings,
  };
  const probeHosts = vi.fn(
    async (
      targets: readonly OpenCodeHostHealthTarget[],
      _probe?: (options: OpenCodeHostHealthProbeOptions) => Promise<OpenCodeHttpHealth>,
      options?: ProbeOptions,
    ) => {
      for (const target of targets) {
        options?.observeDuration?.(target.id, target.id === "host-1" ? 0.02 : 0.03);
      }
      return targets.map((target) => ({
        id: target.id,
        isDefault: target.isDefault,
        http:
          target.id === "host-2" && !host2Healthy
            ? ({ kind: "unreachable" } as const)
            : ({ kind: "healthy", version: "1.18.16" } as const),
        sse: target.sse,
      }));
    },
  );

  return {
    hosts,
    state,
    probeHosts,
    stateBindings,
    setHost2Healthy: (value: boolean) => {
      host2Healthy = value;
    },
    setHost2Sse: (value: "connected" | "disconnected") => {
      host2Sse = value;
    },
  };
}

describe("PrometheusMetrics", () => {
  it("exports low-cardinality ready, host, binding, operation, duration, and info metrics", async () => {
    const fx = fixture();
    const metrics = new PrometheusMetrics({
      version: "0.1.0",
      hosts: fx.hosts,
      state: fx.state,
      probeHosts: fx.probeHosts,
    });
    const logger = metrics.instrumentLogger(noopLogger);

    logger.info("session.created", "created", {
      host_id: "host-1",
      session_id: "ses_LOG_SENTINEL",
      thread_id: "thread_LOG_SENTINEL",
      directory: "/private/log/repo",
    });
    logger.info("session.unbound", "unbound", { host_id: "host-1" });
    logger.info("session.closed", "closed", { host_id: "host-2" });
    logger.info("session.created", "unknown host ignored", { host_id: "unconfigured-host" });

    const snapshot = await metrics.scrape();

    expect(snapshot.contentType).toContain("text/plain");
    expect(snapshot.body).toContain('opencode_discord_bridge_info{version="0.1.0"} 1');
    expect(snapshot.body).toContain("opencode_discord_bridge_ready 1");
    expect(snapshot.body).toContain(
      'opencode_discord_bridge_opencode_host_http_healthy{host_id="host-1"} 1',
    );
    expect(snapshot.body).toContain(
      'opencode_discord_bridge_opencode_host_http_healthy{host_id="host-2"} 1',
    );
    expect(snapshot.body).toContain(
      'opencode_discord_bridge_opencode_host_sse_connected{host_id="host-2"} 1',
    );
    expect(snapshot.body).toContain('opencode_discord_bridge_bound_sessions{host_id="host-1"} 2');
    expect(snapshot.body).toContain('opencode_discord_bridge_bound_sessions{host_id="host-2"} 1');
    expect(snapshot.body).toContain(
      'opencode_discord_bridge_session_operations_total{host_id="host-1",operation="created"} 1',
    );
    expect(snapshot.body).toContain(
      'opencode_discord_bridge_session_operations_total{host_id="host-1",operation="unbound"} 1',
    );
    expect(snapshot.body).toContain(
      'opencode_discord_bridge_session_operations_total{host_id="host-2",operation="closed"} 1',
    );
    expect(snapshot.body).toContain(
      'opencode_discord_bridge_health_probe_duration_seconds_count{host_id="host-1"} 1',
    );
    expect(fx.probeHosts.mock.calls[0]?.[2]?.emitDegradedLog).toBe(false);
  });

  it("tracks degraded and recovered health using the same ready semantics as /oc health", async () => {
    const fx = fixture();
    const metrics = new PrometheusMetrics({
      version: "0.1.0",
      hosts: fx.hosts,
      state: fx.state,
      probeHosts: fx.probeHosts,
    });

    fx.setHost2Healthy(false);
    fx.setHost2Sse("disconnected");
    const degraded = await metrics.scrape();
    expect(degraded.body).toContain("opencode_discord_bridge_ready 0");
    expect(degraded.body).toContain(
      'opencode_discord_bridge_opencode_host_http_healthy{host_id="host-1"} 1',
    );
    expect(degraded.body).toContain(
      'opencode_discord_bridge_opencode_host_http_healthy{host_id="host-2"} 0',
    );
    expect(degraded.body).toContain(
      'opencode_discord_bridge_opencode_host_sse_connected{host_id="host-2"} 0',
    );

    fx.setHost2Healthy(true);
    fx.setHost2Sse("connected");
    const recovered = await metrics.scrape();
    expect(recovered.body).toContain("opencode_discord_bridge_ready 1");
    expect(recovered.body).toContain(
      'opencode_discord_bridge_opencode_host_http_healthy{host_id="host-2"} 1',
    );
  });

  it("never exports secrets, endpoints, usernames, or high-cardinality identifiers", async () => {
    const fx = fixture();
    const metrics = new PrometheusMetrics({
      version: "0.1.0",
      hosts: fx.hosts,
      state: fx.state,
      probeHosts: fx.probeHosts,
    });
    const logger = metrics.instrumentLogger(noopLogger);
    logger.info("session.created", "OCB_PROMPT_LEAK_SENTINEL_20260827", {
      host_id: "host-1",
      session_id: "ses_LOG_SENTINEL",
      thread_id: "thread_LOG_SENTINEL",
      directory: "/private/log/repo",
      user_id: "user_SENTINEL",
      guild_id: "guild_SENTINEL",
    });

    const { body } = await metrics.scrape();
    for (const forbidden of [
      "PASSWORD_SENTINEL",
      "SECOND_PASSWORD_SENTINEL",
      "METRICS_USER_SENTINEL",
      "SECOND_METRICS_USER_SENTINEL",
      "127.0.0.1:4096",
      "10.12.0.2:4096",
      "ses_PRIVATE",
      "thread_PRIVATE",
      "/private/repo",
      "ses_LOG_SENTINEL",
      "thread_LOG_SENTINEL",
      "/private/log/repo",
      "user_SENTINEL",
      "guild_SENTINEL",
      "OCB_PROMPT_LEAK_SENTINEL_20260827",
      "unconfigured-host",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("counts unexpected scrape errors with a bounded result label", async () => {
    const fx = fixture();
    let fail = true;
    const probeHosts = vi.fn(async (...args: Parameters<typeof fx.probeHosts>) => {
      if (fail) throw new Error("probe orchestration failed");
      return fx.probeHosts(...args);
    });
    const metrics = new PrometheusMetrics({
      version: "0.1.0",
      hosts: fx.hosts,
      state: fx.state,
      probeHosts,
    });

    await expect(metrics.scrape()).rejects.toThrow(/probe orchestration failed/);
    fail = false;
    const recovered = await metrics.scrape();
    expect(recovered.body).toContain(
      'opencode_discord_bridge_metrics_scrapes_total{result="error"} 1',
    );
  });
});
