import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { validateHomeDirectory } from "./domain/host-directory-input.js";
import { HostRegistry, type OpenCodeHostConfig } from "./domain/host-registry.js";
import { type LogFormat, type LogLevel, parseLogFormat, parseLogLevel } from "./logging/logger.js";

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
  metricsEnabled: boolean;
  metricsHost: string;
  metricsPort: number;
  hostRegistry: HostRegistry;
  opencodeBaseUrl: string;
  opencodeUsername: string;
  opencodePassword?: string;
  allowedRoots: readonly string[];
  stateFile: string;
};

type TomlConfig = {
  discord: {
    clientId: string;
    guildId: string;
    parentChannelId: string;
    allowedUserIds: string[];
    allowPermissionAlways: boolean;
    streamAssistantText: boolean;
    showToolSummaries: boolean;
  };
  routing: { defaultHost: string };
  hosts: Readonly<
    Record<
      string,
      {
        baseUrl: string;
        username: string;
        passwordEnv: string;
        allowedRoots: readonly string[];
        homeDirectory?: string;
      }
    >
  >;
  logging: { level: LogLevel; format: LogFormat };
  metrics: { enabled: boolean; address: string; port: number };
};

export function readConfigFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read TOML config file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function tomlObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a table`);
  return value;
}

function tomlBool(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function tomlLogLevel(value: unknown): LogLevel {
  if (value === undefined) return "info";
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new Error("logging.level must be one of: debug, info, warn, error");
}

function tomlLogFormat(value: unknown): LogFormat {
  if (value === undefined) return "json";
  if (value === "json" || value === "pretty") return value;
  throw new Error("logging.format must be one of: json, pretty");
}

export function parseTomlConfig(contents: string): TomlConfig {
  let parsed: unknown;
  try {
    parsed = parse(contents);
  } catch {
    throw new Error("TOML config is malformed");
  }
  const root = tomlObject(parsed, "TOML config");
  assertOnlyKeys(root, ["discord", "routing", "host", "logging", "metrics"], "TOML config");
  const discord = tomlObject(root.discord, "discord");
  assertOnlyKeys(
    discord,
    [
      "client_id",
      "guild_id",
      "parent_channel_id",
      "allowed_user_ids",
      "allow_permission_always",
      "stream_assistant_text",
      "show_tool_summaries",
    ],
    "discord",
  );
  const routing = tomlObject(root.routing, "routing");
  assertOnlyKeys(routing, ["default_host"], "routing");
  const logging = root.logging === undefined ? {} : tomlObject(root.logging, "logging");
  assertOnlyKeys(logging, ["level", "format"], "logging");
  const metrics = root.metrics === undefined ? {} : tomlObject(root.metrics, "metrics");
  assertOnlyKeys(metrics, ["enabled", "address", "port"], "metrics");
  const hostTable = tomlObject(root.host, "host");
  const hosts: Record<
    string,
    {
      baseUrl: string;
      username: string;
      passwordEnv: string;
      allowedRoots: readonly string[];
      homeDirectory?: string;
    }
  > = {};
  for (const [id, value] of Object.entries(hostTable)) {
    const host = tomlObject(value, `host.${id}`);
    assertOnlyKeys(
      host,
      ["base_url", "username", "password_env", "allowed_roots", "home_directory"],
      `host.${id}`,
    );
    const homeDirectory =
      host.home_directory === undefined
        ? undefined
        : validateHomeDirectory(host.home_directory, `host.${id}.home_directory`);
    hosts[id] = {
      baseUrl: stringField(host.base_url, `host.${id}.base_url`),
      username: stringField(host.username, `host.${id}.username`),
      passwordEnv: stringField(host.password_env, `host.${id}.password_env`),
      allowedRoots: normalizeAllowedRoots(host.allowed_roots, `host.${id}.allowed_roots`),
      ...(homeDirectory === undefined ? {} : { homeDirectory }),
    };
  }
  if (Object.keys(hosts).length === 0) throw new Error("host must contain at least one host");
  const ids = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${label} must contain at least one user ID`);
    }
    return value.map((item, index) => stringField(item, `${label}[${index}]`));
  };
  const defaultHost = stringField(routing.default_host, "routing.default_host");
  new HostRegistry(
    defaultHost,
    Object.entries(hosts).map(([id, host]) => ({
      id,
      baseUrl: normalizeBaseUrl(host.baseUrl, `host.${id}.base_url`),
      username: host.username,
      ...(host.homeDirectory ? { homeDirectory: host.homeDirectory } : {}),
      allowedRoots: host.allowedRoots,
    })),
  );
  for (const [id, host] of Object.entries(hosts)) {
    host.passwordEnv = tomlHostPasswordEnv(host.passwordEnv, id, `host.${id}.password_env`);
  }
  return {
    discord: {
      clientId: stringField(discord.client_id, "discord.client_id"),
      guildId: stringField(discord.guild_id, "discord.guild_id"),
      parentChannelId: stringField(discord.parent_channel_id, "discord.parent_channel_id"),
      allowedUserIds: ids(discord.allowed_user_ids, "discord.allowed_user_ids"),
      allowPermissionAlways: tomlBool(
        discord.allow_permission_always,
        "discord.allow_permission_always",
        false,
      ),
      streamAssistantText: tomlBool(
        discord.stream_assistant_text,
        "discord.stream_assistant_text",
        false,
      ),
      showToolSummaries: tomlBool(
        discord.show_tool_summaries,
        "discord.show_tool_summaries",
        false,
      ),
    },
    routing: { defaultHost },
    hosts,
    logging: { level: tomlLogLevel(logging.level), format: tomlLogFormat(logging.format) },
    metrics: {
      enabled: tomlBool(metrics.enabled, "metrics.enabled", false),
      address:
        metrics.address === undefined
          ? "127.0.0.1"
          : stringField(metrics.address, "metrics.address"),
      port: metrics.port === undefined ? 9464 : numberPort(metrics.port, "metrics.port"),
    },
  };
}

function tomlHostPasswordEnv(value: unknown, hostId: string, label: string): string {
  const name = stringField(value, label);
  const expected = `OPENCODE_HOST_${hostId.toUpperCase().replaceAll("-", "_")}_PASSWORD`;
  if (name !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
  return name;
}

function numberPort(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return value;
}

export function resolveTomlSecrets(config: TomlConfig, env: NodeJS.ProcessEnv): HostRegistry {
  const hosts = Object.entries(config.hosts).map(([id, host]): OpenCodeHostConfig => {
    const password = env[host.passwordEnv]?.trim();
    if (!password) throw new Error(`Missing required environment variable: ${host.passwordEnv}`);
    return {
      id,
      baseUrl: normalizeBaseUrl(host.baseUrl, `host.${id}.base_url`),
      username: host.username,
      password,
      ...(host.homeDirectory === undefined ? {} : { homeDirectory: host.homeDirectory }),
      allowedRoots: host.allowedRoots,
    };
  });
  return new HostRegistry(config.routing.defaultHost, hosts);
}

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

function nonEmpty(value: string | undefined, fallback: string, key: string): string {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (!normalized) throw new Error(`${key} must be a non-empty string`);
  return normalized;
}

function port(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${key} must be an integer from 1 to 65535`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${key} must be an integer from 1 to 65535`);
  }
  return parsed;
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
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL using http or https`);
  }
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
  const homeDirectory =
    env.OPENCODE_HOME_DIRECTORY === undefined
      ? undefined
      : validateHomeDirectory(env.OPENCODE_HOME_DIRECTORY, "OPENCODE_HOME_DIRECTORY");
  const host: OpenCodeHostConfig = {
    id: "default",
    baseUrl,
    username: env.OPENCODE_SERVER_USERNAME?.trim() || "opencode",
    ...(password ? { password } : {}),
    allowedRoots: Object.freeze(allowedRoots.map((root) => resolve(root))),
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
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
    assertOnlyKeys(
      item,
      ["id", "baseUrl", "username", "passwordEnv", "allowedRoots", "homeDirectory"],
      label,
    );

    const id = stringField(item.id, `${label}.id`);
    const baseUrl = normalizeBaseUrl(
      stringField(item.baseUrl, `${label}.baseUrl`),
      `${label}.baseUrl`,
    );
    const username = stringField(item.username, `${label}.username`);
    const allowedRoots = normalizeAllowedRoots(item.allowedRoots, `${label}.allowedRoots`);
    const homeDirectory =
      item.homeDirectory === undefined
        ? undefined
        : validateHomeDirectory(item.homeDirectory, `${label}.homeDirectory`);

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
      ...(homeDirectory ? { homeDirectory } : {}),
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
  if (Object.hasOwn(env, "OCB_CONFIG_FILE")) {
    const configPath = env.OCB_CONFIG_FILE?.trim();
    if (!configPath) throw new Error("OCB_CONFIG_FILE must be a non-empty path");
    return loadTomlConfig(configPath, env);
  }
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
    metricsEnabled: boolean(env.OCB_METRICS_ENABLED, false),
    metricsHost: nonEmpty(env.OCB_METRICS_HOST, "127.0.0.1", "OCB_METRICS_HOST"),
    metricsPort: port(env.OCB_METRICS_PORT, 9464, "OCB_METRICS_PORT"),
    hostRegistry,
    opencodeBaseUrl: defaultHost.baseUrl,
    opencodeUsername: defaultHost.username,
    ...(defaultHost.password ? { opencodePassword: defaultHost.password } : {}),
    allowedRoots: defaultHost.allowedRoots,
    stateFile: resolve(env.STATE_FILE?.trim() || ".data/state.json"),
  };
}

function loadTomlConfig(path: string, env: NodeJS.ProcessEnv): AppConfig {
  const parsed = parseTomlConfig(readConfigFile(path));
  const hostRegistry = resolveTomlSecrets(parsed, env);
  const defaultHost = hostRegistry.defaultHost();
  return {
    discordToken: required(env, "DISCORD_TOKEN"),
    discordClientId: parsed.discord.clientId,
    discordGuildId: parsed.discord.guildId,
    discordParentChannelId: parsed.discord.parentChannelId,
    allowedUserIds: new Set(parsed.discord.allowedUserIds),
    allowPermissionAlways: parsed.discord.allowPermissionAlways,
    streamAssistantText: parsed.discord.streamAssistantText,
    showToolSummaries: parsed.discord.showToolSummaries,
    logLevel: parsed.logging.level,
    logFormat: parsed.logging.format,
    metricsEnabled: parsed.metrics.enabled,
    metricsHost: parsed.metrics.address,
    metricsPort: parsed.metrics.port,
    hostRegistry,
    opencodeBaseUrl: defaultHost.baseUrl,
    opencodeUsername: defaultHost.username,
    ...(defaultHost.password ? { opencodePassword: defaultHost.password } : {}),
    allowedRoots: defaultHost.allowedRoots,
    stateFile: resolve(env.STATE_FILE?.trim() || ".data/state.json"),
  };
}
