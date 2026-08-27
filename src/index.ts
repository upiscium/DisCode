import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { AssistantStreamingPublisher } from "./bridge/assistant-streaming-publisher.js";
import { Bridge } from "./bridge/bridge.js";
import { ToolSummaryPublisher } from "./bridge/tool-summary-publisher.js";
import { loadConfig } from "./config.js";
import { DirectoryPolicy } from "./domain/directory-policy.js";
import type { OpenCodeHostConfig } from "./domain/host-registry.js";
import { OpenCodeSseMonitor } from "./opencode/diagnostics.js";
import {
  type OpenCodeHostRuntime,
  OpenCodeHostRuntimeRegistry,
} from "./opencode/host-runtime-registry.js";
import { ObservedOpenCodeGateway } from "./opencode/observed-gateway.js";
import { createOpenCodeDirectoryResolver } from "./opencode/remote-directory-resolver.js";
import { loadSecretEnvironment } from "./secrets.js";
import { StateStore } from "./state/state-store.js";

loadSecretEnvironment();
if (existsSync(".env")) {
  loadEnvFile(".env");
}

const config = loadConfig();
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
  });
  const toolSummaryPublisher = new ToolSummaryPublisher({
    enabled: config.showToolSummaries,
    hostId: host.id,
    discordToken: config.discordToken,
    state,
  });
  const gateway = new ObservedOpenCodeGateway({
    baseUrl: host.baseUrl,
    username: host.username,
    ...(host.password ? { password: host.password } : {}),
    observers: [toolSummaryPublisher, streamingPublisher],
  });

  return {
    id: host.id,
    config: host,
    gateway,
    sseMonitor: new OpenCodeSseMonitor(),
    authorizeDirectory: lazyDirectoryAuthorizer(host),
  };
});

const hosts = new OpenCodeHostRuntimeRegistry(defaultHostId, hostRuntimes);
const bridge = new Bridge({ config, state, hosts });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void bridge.stop().finally(() => process.exit(0));
  });
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection", error);
});

await bridge.start();

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
