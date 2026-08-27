import { resolve } from "node:path";
import { HostRegistry, type OpenCodeHostConfig } from "./domain/host-registry.js";
import {
  type LogFormat,
  type LogLevel,
  parseLogFormat,
  parseLogLevel,
} from "./logging/logger.js";

export type AppConfig = {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  discordParentChannelId: string;
  allowedUserIds: ReadonlySet<string>;
  allowPermissionAlways: boolean;
  streamAssistantText: boolean;
  showToolSummaries: boolean;
  logLevel: LogLevel;
  logFormat: LogFormat;
  hostRegistry: HostRegistry;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBaseUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain URL credentials`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeAllowedRoots(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one path`);
  }
  const roots = value.map((item, index) => resolve(stringField(item, `${label}[${index}]`)));
  return Object.freeze([...new Set(roots)]);
}

function legacyHostRegistry(env: NodeJS.ProcessEnv): HostRegistry {
  const allowedRoots = csv(required(env, "OPENCODE_ALLOWED_ROOTS"));
  if (allowedRoots.length === 0) {
    throw new Error("OPENCODE_ALLOWED_ROOTS must contain at least one path");
  }

  const baseUrl = normalizeBaseUrl(
    env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096",
    "OPENCODE_BASE_URL",
  );
  const password = env.OPENCODE_SERVER_PASSWORD?.trim();
  const host: OpenCodeHostConfig = {
    id: "default",
    baseUrl,
    username: env.OPENCODE_SERVER_USERNAME?.trim() || "opencode",
    ...(password ? { password } : {}),
    allowedRoots: Object.freeze(allowedRoots.map((root) => resolve(root))),
  };
  return new HostRegistry("default", [host]);
}

function configuredHostRegistry(raw: string, env: NodeJS.ProcessEnv): HostRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `OPENCODE_HOSTS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error("OPENCODE_HOSTS_JSON must be a JSON object");
  assertOnlyKeys(parsed, ["defaultHost", "hosts"], "OPENCODE_HOSTS_JSON");

  const defaultHost = stringField(parsed.defaultHost, "OPENCODE_HOSTS_JSON.defaultHost");
  if (!Array.isArray(parsed.hosts) || parsed.hosts.length === 0) {
    throw new Error("OPENCODE_HOSTS_JSON.hosts must contain at least one host");
  }

  const hosts = parsed.hosts.map((item, index): OpenCodeHostConfig => {
    const label = `OPENCODE_HOSTS_JSON.hosts[${index}]`;
    if (!isRecord(item)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(item, ["id", "baseUrl", "username", "passwordEnv", "allowedRoots"], label);

    const id = stringField(item.id, `${label}.id`);
    const baseUrl = normalizeBaseUrl(
      stringField(item.baseUrl, `${label}.baseUrl`),
      `${label}.baseUrl`,
    );
    const username = stringField(item.username, `${label}.username`);
    const allowedRoots = normalizeAllowedRoots(item.allowedRoots, `${label}.allowedRoots`);

    let password: string | undefined;
    if (item.passwordEnv !== undefined) {
      const passwordEnv = stringField(item.passwordEnv, `${label}.passwordEnv`);
      password = required(env, passwordEnv);
    }

    return {
      id,
      baseUrl,
      username,
      ...(password ? { password } : {}),
      allowedRoots,
    };
  });

  return new HostRegistry(defaultHost, hosts);
}

export function loadHostRegistry(env: NodeJS.ProcessEnv = process.env): HostRegistry {
  const raw = env.OPENCODE_HOSTS_JSON?.trim();
  return raw ? configuredHostRegistry(raw, env) : legacyHostRegistry(env);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowedUserIds = new Set(csv(required(env, "DISCORD_ALLOWED_USER_IDS")));
  if (allowedUserIds.size === 0) {
    throw new Error("DISCORD_ALLOWED_USER_IDS must contain at least one user ID");
  }

  const hostRegistry = loadHostRegistry(env);
  const defaultHost = hostRegistry.defaultHost();

  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    discordClientId: required(env, "DISCORD_CLIENT_ID"),
    discordGuildId: required(env, "DISCORD_GUILD_ID"),
    discordParentChannelId: required(env, "DISCORD_PARENT_CHANNEL_ID"),
    allowedUserIds,
    allowPermissionAlways: boolean(env.DISCORD_ALLOW_PERMISSION_ALWAYS, false),
    streamAssistantText: boolean(env.DISCORD_STREAM_ASSISTANT_TEXT, false),
    showToolSummaries: boolean(env.DISCORD_SHOW_TOOL_SUMMARIES, false),
    logLevel: parseLogLevel(env.OCB_LOG_LEVEL, "info"),
    logFormat: parseLogFormat(env.OCB_LOG_FORMAT, "pretty"),
    hostRegistry,
    opencodeBaseUrl: defaultHost.baseUrl,
    opencodeUsername: defaultHost.username,
    ...(defaultHost.password ? { opencodePassword: defaultHost.password } : {}),
    allowedRoots: defaultHost.allowedRoots,
    stateFile: resolve(env.STATE_FILE?.trim() || ".data/state.json"),
  };
}
