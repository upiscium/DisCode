import { resolve } from "node:path";

export type AppConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  discordParentChannelId: string;
  allowedUserIds: ReadonlySet<string>;
  allowPermissionAlways: boolean;
  streamAssistantText: boolean;
  showToolSummaries: boolean;
  opencodeBaseUrl: string;
  opencodeUsername: string;
  opencodePassword?: string;
  allowedRoots: readonly string[];
  stateFile: string;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean value, got: ${value}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowedUserIds = new Set(csv(required(env, "DISCORD_ALLOWED_USER_IDS")));
  if (allowedUserIds.size === 0) {
    throw new Error("DISCORD_ALLOWED_USER_IDS must contain at least one user ID");
  }

  const allowedRoots = csv(required(env, "OPENCODE_ALLOWED_ROOTS")).map((root) => resolve(root));
  if (allowedRoots.length === 0) {
    throw new Error("OPENCODE_ALLOWED_ROOTS must contain at least one path");
  }

  const opencodeBaseUrl = env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096";
  const parsedUrl = new URL(opencodeBaseUrl);
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new Error("OPENCODE_BASE_URL must use http or https");
  }

  const password = env.OPENCODE_SERVER_PASSWORD?.trim();

  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    discordClientId: required(env, "DISCORD_CLIENT_ID"),
    discordGuildId: required(env, "DISCORD_GUILD_ID"),
    discordParentChannelId: required(env, "DISCORD_PARENT_CHANNEL_ID"),
    allowedUserIds,
    allowPermissionAlways: boolean(env.DISCORD_ALLOW_PERMISSION_ALWAYS, false),
    streamAssistantText: boolean(env.DISCORD_STREAM_ASSISTANT_TEXT, false),
    showToolSummaries: boolean(env.DISCORD_SHOW_TOOL_SUMMARIES, false),
    opencodeBaseUrl: parsedUrl.toString().replace(/\/$/, ""),
    opencodeUsername: env.OPENCODE_SERVER_USERNAME?.trim() || "opencode",
    ...(password ? { opencodePassword: password } : {}),
    allowedRoots,
    stateFile: resolve(env.STATE_FILE?.trim() || ".data/state.json"),
  };
}
