import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { AssistantStreamingPublisher } from "./bridge/assistant-streaming-publisher.js";
import { Bridge } from "./bridge/bridge.js";
import { SubagentRuntime } from "./bridge/subagent-runtime.js";
import { ToolSummaryPublisher } from "./bridge/tool-summary-publisher.js";
import { loadConfig } from "./config.js";
import { selectionAutocomplete } from "./discord/selection-autocomplete.js";
import { DirectoryPolicy } from "./domain/directory-policy.js";
import type { OpenCodeHostConfig } from "./domain/host-registry.js";
import { Logger } from "./logging/logger.js";
import { PrometheusMetrics } from "./metrics/prometheus.js";
import { MetricsServer } from "./metrics/server.js";
import { OpenCodeChildSessionGateway } from "./opencode/child-session-gateway.js";
import { OpenCodeSseMonitor, setOpenCodeHealthLogger } from "./opencode/diagnostics.js";
import {
  type OpenCodeHostRuntime,
  OpenCodeHostRuntimeRegistry,
} from "./opencode/host-runtime-registry.js";
import { ObservedOpenCodeGateway } from "./opencode/observed-gateway.js";
import { createOpenCodeDirectoryResolver } from "./opencode/remote-directory-resolver.js";
import { SubagentInspector } from "./opencode/subagent-inspector.js";
import { OpenCodeTodoGateway } from "./opencode/todo-gateway.js";
import { loadSecretEnvironment } from "./secrets.js";
import { StateStore } from "./state/state-store.js";

const BRIDGE_VERSION = "0.1.0";

loadSecretEnvironment();
if (existsSync(".env")) {
  loadEnvFile(".env");
}

const config = loadConfig();
const baseLogger = new Logger({
  level: config.logLevel,
  format: config.logFormat,
  secrets: [
    config.discordToken,
    ...config.hostRegistry.list().flatMap((host) => {
      if (!host.password) return [];
      const basicCredential = Buffer.from(`${host.username}:${host.password}`, "utf8").toString(
        "base64",
      );
      return [host.password, basicCredential, `Basic ${basicCredential}`];
    }),
  ],
});
setOpenCodeHealthLogger(baseLogger);

const defaultHostId = config.hostRegistry.defaultHost().id;
const state = new StateStore(config.stateFile, defaultHostId);
await state.load();
for (const binding of state.list()) {
  if (!config.hostRegistry.has(binding.hostId)) {
    throw new Error(
      `State binding ${binding.threadId} references unknown OpenCode host: ${binding.hostId}`,
    );
  }
}

const hostRuntimes = config.hostRegistry.list().map((host): OpenCodeHostRuntime => {
  const streamingPublisher = new AssistantStreamingPublisher({
    enabled: config.streamAssistantText,
    hostId: host.id,
    discordToken: config.discordToken,
    state,
    logger: baseLogger,
  });
  const toolSummaryPublisher = new ToolSummaryPublisher({
    enabled: config.showToolSummaries,
    hostId: host.id,
    discordToken: config.discordToken,
    state,
    logger: baseLogger,
  });
  const gateway = new ObservedOpenCodeGateway({
    hostId: host.id,
    baseUrl: host.baseUrl,
    username: host.username,
    ...(host.password ? { password: host.password } : {}),
    observers: [toolSummaryPublisher, streamingPublisher],
    logger: baseLogger,
  });

  return {
    id: host.id,
    config: host,
    gateway,
    child: new OpenCodeChildSessionGateway({
      hostId: host.id,
      baseUrl: host.baseUrl,
      username: host.username,
      ...(host.password ? { password: host.password } : {}),
    }),
    todo: new OpenCodeTodoGateway({
      baseUrl: host.baseUrl,
      username: host.username,
      ...(host.password ? { password: host.password } : {}),
    }),
    sseMonitor: new OpenCodeSseMonitor(),
    authorizeDirectory: lazyDirectoryAuthorizer(host),
  };
});

const hosts = new OpenCodeHostRuntimeRegistry(defaultHostId, hostRuntimes);
const metrics = new PrometheusMetrics({
  version: BRIDGE_VERSION,
  hosts,
  state,
});
const bridgeLogger = metrics.instrumentLogger(baseLogger);
const metricsServer = new MetricsServer({
  enabled: config.metricsEnabled,
  host: config.metricsHost,
  port: config.metricsPort,
  exporter: metrics,
  logger: baseLogger,
});
const bridge = new Bridge({
  config,
  state,
  hosts,
  logger: bridgeLogger,
  subagents: new SubagentRuntime({
    state,
    inspector: new SubagentInspector({
      gatewayFor: (hostId) => hosts.get(hostId).child,
      todoGatewayFor: (hostId) => hosts.get(hostId).todo,
    }),
    logger: bridgeLogger,
  }),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void bridge
      .stop()
      .finally(() => metricsServer.stop())
      .finally(() => process.exit(0));
  });
}

process.on("unhandledRejection", (error) => {
  baseLogger.error("process.unhandled_rejection", "Unhandled promise rejection", {}, error);
});

await metricsServer.start();
void warmPersistedSelectionCatalogs();
await bridge.start();

async function warmPersistedSelectionCatalogs(): Promise<void> {
  const seen = new Set<string>();
  const requests: Array<Promise<unknown>> = [];

  for (const binding of state.list()) {
    const key = JSON.stringify([binding.hostId, binding.directory]);
    if (seen.has(key)) continue;
    seen.add(key);

    for (const kind of ["model", "agent"] as const) {
      requests.push(
        selectionAutocomplete(hosts, {
          kind,
          directory: binding.directory,
          hostId: binding.hostId,
        }),
      );
    }
  }

  await Promise.allSettled(requests);
}

function lazyDirectoryAuthorizer(host: OpenCodeHostConfig): (directory: string) => Promise<string> {
  let policyPromise: Promise<DirectoryPolicy> | undefined;
  return async (directory: string): Promise<string> => {
    if (!policyPromise) {
      policyPromise = DirectoryPolicy.createWithResolver(
        host.allowedRoots,
        createOpenCodeDirectoryResolver(host),
      ).catch((error) => {
        policyPromise = undefined;
        throw error;
      });
    }
    return (await policyPromise).authorize(directory);
  };
}
