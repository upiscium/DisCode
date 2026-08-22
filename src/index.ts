import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { AssistantStreamingPublisher } from "./bridge/assistant-streaming-publisher.js";
import { Bridge } from "./bridge/bridge.js";
import { loadConfig } from "./config.js";
import { DirectoryPolicy } from "./domain/directory-policy.js";
import { StreamingOpenCodeGateway } from "./opencode/streaming-gateway.js";
import { StateStore } from "./state/state-store.js";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const config = loadConfig();
const policy = await DirectoryPolicy.create(config.allowedRoots);
const state = new StateStore(config.stateFile);
await state.load();
const streamingPublisher = new AssistantStreamingPublisher({
  enabled: config.streamAssistantText,
  discordToken: config.discordToken,
  state,
});
const opencode = new StreamingOpenCodeGateway({
  baseUrl: config.opencodeBaseUrl,
  username: config.opencodeUsername,
  ...(config.opencodePassword ? { password: config.opencodePassword } : {}),
  publisher: streamingPublisher,
});
const bridge = new Bridge({ config, policy, state, opencode });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void bridge.stop().finally(() => process.exit(0));
  });
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection", error);
});

await bridge.start();
