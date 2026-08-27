import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { SessionBinding } from "../domain/session-binding.js";
import type { LoggerLike, LogFields } from "../logging/logger.js";
import {
  type OpenCodeHostHealthProbeOptions,
  type OpenCodeHostHealthTarget,
  type OpenCodeHttpHealth,
  type OpenCodeSseState,
  probeOpenCodeHostsHealth,
} from "../opencode/diagnostics.js";

export type SessionMetricOperation = "created" | "closed" | "unbound";
export type MetricsScrapeResult = "success" | "error";

export type MetricsSnapshot = Readonly<{
  body: string;
  contentType: string;
}>;

export type MetricsExporterLike = {
  scrape(): Promise<MetricsSnapshot>;
};

type MetricsHostRuntime = Readonly<{
  id: string;
  config: Readonly<{
    baseUrl: string;
    username: string;
    password?: string;
  }>;
  sseMonitor: Readonly<{
    status(): OpenCodeSseState;
  }>;
}>;

type MetricsHostSource = {
  defaultHost(): MetricsHostRuntime;
  list(): readonly MetricsHostRuntime[];
};

type MetricsStateSource = {
  list(): readonly Pick<SessionBinding, "hostId">[];
};

type ProbeHostsOptions = Readonly<{
  emitDegradedLog?: boolean;
  observeDuration?: (hostId: string, durationSeconds: number) => void;
}>;

type ProbeHosts = (
  targets: readonly OpenCodeHostHealthTarget[],
  probe?: (options: OpenCodeHostHealthProbeOptions) => Promise<OpenCodeHttpHealth>,
  options?: ProbeHostsOptions,
) => Promise<
  readonly Readonly<{
    id: string;
    isDefault: boolean;
    http: OpenCodeHttpHealth;
    sse: OpenCodeSseState;
  }>[]
>;

type PrometheusMetricsOptions = Readonly<{
  version: string;
  hosts: MetricsHostSource;
  state: MetricsStateSource;
  probeHosts?: ProbeHosts;
}>;

const METRIC_PREFIX = "opencode_discord_bridge_";
const SESSION_EVENT_OPERATION: Readonly<Record<string, SessionMetricOperation | undefined>> = {
  "session.created": "created",
  "session.closed": "closed",
  "session.unbound": "unbound",
};

export class PrometheusMetrics implements MetricsExporterLike {
  readonly #hosts: MetricsHostSource;
  readonly #state: MetricsStateSource;
  readonly #probeHosts: ProbeHosts;
  readonly #configuredHostIds: ReadonlySet<string>;
  readonly #registry = new Registry();
  readonly #info: Gauge<"version">;
  readonly #ready: Gauge;
  readonly #httpHealthy: Gauge<"host_id">;
  readonly #sseConnected: Gauge<"host_id">;
  readonly #boundSessions: Gauge<"host_id">;
  readonly #sessionOperations: Counter<"host_id" | "operation">;
  readonly #healthProbeDuration: Histogram<"host_id">;
  readonly #scrapes: Counter<"result">;

  constructor(options: PrometheusMetricsOptions) {
    this.#hosts = options.hosts;
    this.#state = options.state;
    this.#probeHosts = options.probeHosts ?? probeOpenCodeHostsHealth;
    this.#configuredHostIds = new Set(this.#hosts.list().map((host) => host.id));

    this.#info = new Gauge({
      name: `${METRIC_PREFIX}info`,
      help: "Static OpenCode Discord Bridge build information.",
      labelNames: ["version"] as const,
      registers: [this.#registry],
    });
    this.#ready = new Gauge({
      name: `${METRIC_PREFIX}ready`,
      help: "1 when every configured OpenCode host is HTTP healthy and SSE connected.",
      registers: [this.#registry],
    });
    this.#httpHealthy = new Gauge({
      name: `${METRIC_PREFIX}opencode_host_http_healthy`,
      help: "Whether the configured OpenCode host HTTP health probe is healthy.",
      labelNames: ["host_id"] as const,
      registers: [this.#registry],
    });
    this.#sseConnected = new Gauge({
      name: `${METRIC_PREFIX}opencode_host_sse_connected`,
      help: "Whether the configured OpenCode host SSE monitor is connected.",
      labelNames: ["host_id"] as const,
      registers: [this.#registry],
    });
    this.#boundSessions = new Gauge({
      name: `${METRIC_PREFIX}bound_sessions`,
      help: "Current persisted Discord/OpenCode bindings by configured host.",
      labelNames: ["host_id"] as const,
      registers: [this.#registry],
    });
    this.#sessionOperations = new Counter({
      name: `${METRIC_PREFIX}session_operations_total`,
      help: "Successful Bridge session lifecycle operations in this process lifetime.",
      labelNames: ["host_id", "operation"] as const,
      registers: [this.#registry],
    });
    this.#healthProbeDuration = new Histogram({
      name: `${METRIC_PREFIX}health_probe_duration_seconds`,
      help: "Authenticated OpenCode HTTP health probe duration by configured host.",
      labelNames: ["host_id"] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3],
      registers: [this.#registry],
    });
    this.#scrapes = new Counter({
      name: `${METRIC_PREFIX}metrics_scrapes_total`,
      help: "Metrics scrape attempts by bounded result category.",
      labelNames: ["result"] as const,
      registers: [this.#registry],
    });

    this.#info.labels(options.version).set(1);
    this.#ready.set(0);
    this.#scrapes.labels("success").inc(0);
    this.#scrapes.labels("error").inc(0);
    for (const hostId of this.#configuredHostIds) {
      this.#httpHealthy.labels(hostId).set(0);
      this.#sseConnected.labels(hostId).set(0);
      this.#boundSessions.labels(hostId).set(0);
      for (const operation of ["created", "closed", "unbound"] as const) {
        this.#sessionOperations.labels(hostId, operation).inc(0);
      }
    }
  }

  instrumentLogger(logger: LoggerLike): LoggerLike {
    const observe = (event: string, fields: LogFields | undefined): void => {
      const operation = SESSION_EVENT_OPERATION[event];
      if (!operation) return;
      const hostId = fields?.host_id;
      if (typeof hostId !== "string" || !this.#configuredHostIds.has(hostId)) return;
      this.#sessionOperations.labels(hostId, operation).inc();
    };

    return {
      debug: (event, message, fields) => {
        observe(event, fields);
        logger.debug(event, message, fields);
      },
      info: (event, message, fields) => {
        observe(event, fields);
        logger.info(event, message, fields);
      },
      warn: (event, message, fields, error) => {
        observe(event, fields);
        logger.warn(event, message, fields, error);
      },
      error: (event, message, fields, error) => {
        observe(event, fields);
        logger.error(event, message, fields, error);
      },
    };
  }

  async scrape(): Promise<MetricsSnapshot> {
    try {
      const defaultHostId = this.#hosts.defaultHost().id;
      const targets = this.#hosts.list().map((runtime) => ({
        id: runtime.id,
        isDefault: runtime.id === defaultHostId,
        baseUrl: runtime.config.baseUrl,
        username: runtime.config.username,
        ...(runtime.config.password ? { password: runtime.config.password } : {}),
        sse: runtime.sseMonitor.status(),
      }));

      const health = await this.#probeHosts(targets, undefined, {
        emitDegradedLog: false,
        observeDuration: (hostId, durationSeconds) => {
          if (!this.#configuredHostIds.has(hostId)) return;
          this.#healthProbeDuration.labels(hostId).observe(durationSeconds);
        },
      });

      let allReady = health.length === targets.length;
      for (const diagnostic of health) {
        if (!this.#configuredHostIds.has(diagnostic.id)) continue;
        const httpHealthy = diagnostic.http.kind === "healthy";
        const sseConnected = diagnostic.sse === "connected";
        this.#httpHealthy.labels(diagnostic.id).set(httpHealthy ? 1 : 0);
        this.#sseConnected.labels(diagnostic.id).set(sseConnected ? 1 : 0);
        allReady &&= httpHealthy && sseConnected;
      }
      this.#ready.set(allReady ? 1 : 0);
      this.#refreshBoundSessions();

      const body = await this.#registry.metrics();
      this.#scrapes.labels("success").inc();
      return { body, contentType: this.#registry.contentType };
    } catch (error) {
      this.#scrapes.labels("error").inc();
      throw error;
    }
  }

  #refreshBoundSessions(): void {
    const counts = new Map<string, number>(
      [...this.#configuredHostIds].map((hostId) => [hostId, 0]),
    );
    for (const binding of this.#state.list()) {
      if (!counts.has(binding.hostId)) continue;
      counts.set(binding.hostId, (counts.get(binding.hostId) ?? 0) + 1);
    }
    for (const [hostId, count] of counts) {
      this.#boundSessions.labels(hostId).set(count);
    }
  }
}
