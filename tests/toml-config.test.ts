import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, parseTomlConfig } from "../src/config.js";

const toml = `
[discord]
client_id = "toml-client"
guild_id = "toml-guild"
parent_channel_id = "toml-parent"
allowed_user_ids = ["42", "43"]

[routing]
default_host = "remote"

[host.local]
base_url = "http://127.0.0.1:4096"
username = "local"
password_env = "OPENCODE_HOST_LOCAL_PASSWORD"
allowed_roots = ["/tmp"]

[host.remote]
base_url = "https://remote.example.test/"
username = "remote"
password_env = "OPENCODE_HOST_REMOTE_PASSWORD"
allowed_roots = ["/srv"]
`;

const tempDirectories: string[] = [];

function fileWith(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "discode-config-"));
  tempDirectories.push(directory);
  const path = join(directory, "config.toml");
  writeFileSync(path, contents);
  return path;
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected action to throw");
}

describe("TOML configuration", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is authoritative and applies secure defaults", () => {
    const config = loadConfig({
      OCB_CONFIG_FILE: fileWith(toml),
      DISCORD_TOKEN: "runtime-token",
      OPENCODE_HOST_LOCAL_PASSWORD: "local-secret",
      OPENCODE_HOST_REMOTE_PASSWORD: "remote-secret",
      DISCORD_CLIENT_ID: "legacy-client",
      OPENCODE_HOSTS_JSON: "invalid legacy value",
      OCB_LOG_FORMAT: "pretty",
    });
    expect(config.discordClientId).toBe("toml-client");
    expect(config.hostRegistry.defaultHost().id).toBe("remote");
    expect(config.logFormat).toBe("json");
    expect(config.metricsEnabled).toBe(false);
    expect(config.metricsPort).toBe(9464);
    expect(JSON.stringify(config.hostRegistry)).not.toContain("OPENCODE_HOST_REMOTE_PASSWORD");
  });

  it("loads a single host using its table key as the persistent host ID", () => {
    const singleHostToml = toml
      .replace('default_host = "remote"', 'default_host = "local"')
      .replace(/\n\[host\.remote\][\s\S]*$/, "");
    const config = loadConfig({
      OCB_CONFIG_FILE: fileWith(singleHostToml),
      DISCORD_TOKEN: "runtime-token",
      OPENCODE_HOST_LOCAL_PASSWORD: "local-secret",
    });

    expect(config.hostRegistry.list().map((host) => host.id)).toEqual(["local"]);
    expect(config.hostRegistry.defaultHost().id).toBe("local");
    expect(config.opencodePassword).toBe("local-secret");
  });

  it("derives the exact password environment name from the host ID", () => {
    const adamToml = toml
      .replace('default_host = "remote"', 'default_host = "adam"')
      .replace("[host.local]", "[host.adam]")
      .replace("OPENCODE_HOST_LOCAL_PASSWORD", "OPENCODE_HOST_ADAM_PASSWORD")
      .replace(/\n\[host\.remote\][\s\S]*$/, "");
    expect(
      loadConfig({
        OCB_CONFIG_FILE: fileWith(adamToml),
        DISCORD_TOKEN: "runtime-token",
        OPENCODE_HOST_ADAM_PASSWORD: "adam-secret",
      }).hostRegistry.defaultHost().password,
    ).toBe("adam-secret");

    expect(() =>
      parseTomlConfig(
        adamToml.replace("OPENCODE_HOST_ADAM_PASSWORD", "OPENCODE_HOST_EVE_PASSWORD"),
      ),
    ).toThrow(/OPENCODE_HOST_ADAM_PASSWORD/);

    const hyphenatedToml = adamToml
      .replace('default_host = "adam"', 'default_host = "host-1"')
      .replace("[host.adam]", "[host.host-1]")
      .replace("OPENCODE_HOST_ADAM_PASSWORD", "OPENCODE_HOST_HOST_1_PASSWORD");
    expect(
      loadConfig({
        OCB_CONFIG_FILE: fileWith(hyphenatedToml),
        DISCORD_TOKEN: "runtime-token",
        OPENCODE_HOST_HOST_1_PASSWORD: "host-1-secret",
      }).hostRegistry.defaultHost().password,
    ).toBe("host-1-secret");
  });

  it("requires a non-empty config-file setting and reports directory reads deterministically", () => {
    expect(() => loadConfig({ OCB_CONFIG_FILE: "" })).toThrow(/OCB_CONFIG_FILE/);
    expect(() => loadConfig({ OCB_CONFIG_FILE: "/path/that/does/not/exist" })).toThrow(
      /Unable to read TOML config file/,
    );
    const directory = mkdtempSync(join(tmpdir(), "discode-config-dir-"));
    expect(() => loadConfig({ OCB_CONFIG_FILE: directory })).toThrow(
      /Unable to read TOML config file/,
    );
  });

  it("rejects malformed and unknown TOML fields without exposing contents", () => {
    expect(() => parseTomlConfig("[discord\nsecret = 'never-log-this'")).toThrow(/malformed/);
    expect(() => parseTomlConfig(`${toml}\n[unexpected]\nvalue = "x"`)).toThrow(/unknown field/);
    const error = captureError(() => parseTomlConfig("[discord]\nclient_id = 'secret-content'"));
    expect(error.message).not.toContain("secret-content");
  });

  it("rejects unknown fields in every supported table", () => {
    const discordUnknown = toml.replace(
      'allowed_user_ids = ["42", "43"]',
      'unexpected = true\nallowed_user_ids = ["42", "43"]',
    );
    const hostUnknown = `${toml}\nunexpected = true`;
    const loggingUnknown = `${toml}\n[logging]\nunexpected = true`;
    const metricsUnknown = `${toml}\n[metrics]\nunexpected = true`;
    for (const [source, table] of [
      [discordUnknown, "discord"],
      [hostUnknown, "host"],
      [loggingUnknown, "logging"],
      [metricsUnknown, "metrics"],
    ] as const) {
      expect(() => parseTomlConfig(source), table).toThrow(/unknown field/);
    }
    expect(() => parseTomlConfig(`${toml}\n[unexpected]\nvalue = true`)).toThrow(/unknown field/);
  });

  it("supports explicit secure-feature settings and metrics", () => {
    const source = `${toml.replace(
      'allowed_user_ids = ["42", "43"]',
      'allowed_user_ids = ["42", "43"]\nallow_permission_always = true\nstream_assistant_text = true\nshow_tool_summaries = true',
    )}
[logging]
level = "debug"
format = "pretty"
[metrics]
enabled = true
address = "0.0.0.0"
port = 9999
`;
    const config = loadConfig({
      OCB_CONFIG_FILE: fileWith(source),
      DISCORD_TOKEN: "token",
      OPENCODE_HOST_LOCAL_PASSWORD: "local",
      OPENCODE_HOST_REMOTE_PASSWORD: "remote",
    });
    expect(config.allowPermissionAlways).toBe(true);
    expect(config.streamAssistantText).toBe(true);
    expect(config.showToolSummaries).toBe(true);
    expect(config.logLevel).toBe("debug");
    expect(config.logFormat).toBe("pretty");
    expect(config.metricsEnabled).toBe(true);
    expect(config.metricsHost).toBe("0.0.0.0");
    expect(config.metricsPort).toBe(9999);
  });

  it("isolates hosts, preserves canonical IDs, and resolves only referenced secrets", () => {
    const config = loadConfig({
      OCB_CONFIG_FILE: fileWith(toml),
      DISCORD_TOKEN: "token",
      OPENCODE_HOST_LOCAL_PASSWORD: "local-secret",
      OPENCODE_HOST_REMOTE_PASSWORD: "remote-secret",
    });
    expect(config.hostRegistry.list().map((host) => host.id)).toEqual(["local", "remote"]);
    expect(config.hostRegistry.get("local").password).toBe("local-secret");
    expect(config.hostRegistry.get("remote").password).toBe("remote-secret");
    expect(JSON.stringify(config.hostRegistry)).not.toContain("PASSWORD");
    expect(JSON.stringify(config.hostRegistry)).not.toContain("secret");
  });

  it("rejects direct passwords and invalid host topology", () => {
    const directPasswordError = captureError(() =>
      parseTomlConfig(`${toml}\npassword = "direct-secret"`),
    );
    expect(directPasswordError.message).toMatch(/unknown field/);
    expect(directPasswordError.message).not.toContain("direct-secret");
    expect(() =>
      parseTomlConfig(toml.replace("OPENCODE_HOST_LOCAL_PASSWORD", "DISCORD_TOKEN")),
    ).toThrow(/OPENCODE_HOST_LOCAL_PASSWORD/);
    expect(() =>
      parseTomlConfig(
        toml.replace('base_url = "http://127.0.0.1:4096"', 'base_url = "ftp://host"'),
      ),
    ).toThrow(/http or https/);
    expect(() =>
      parseTomlConfig(
        toml.replace('base_url = "http://127.0.0.1:4096"', 'base_url = "http://user:pass@host"'),
      ),
    ).toThrow(/URL credentials/);
    const invalidUrlError = captureError(() =>
      parseTomlConfig(
        toml.replace(
          'base_url = "http://127.0.0.1:4096"',
          'base_url = "not-a-url-containing-secret"',
        ),
      ),
    );
    expect(invalidUrlError.message).toMatch(/valid URL/);
    expect(invalidUrlError.message).not.toContain("containing-secret");
    expect(() =>
      parseTomlConfig(toml.replace('allowed_roots = ["/tmp"]', "allowed_roots = []")),
    ).toThrow(/at least one path/);
    expect(() => parseTomlConfig(toml.replace("[host.local]", '[host."BAD"]'))).toThrow(
      /Invalid OpenCode host ID/,
    );
    expect(() =>
      loadConfig({
        OCB_CONFIG_FILE: fileWith(
          toml.replace('default_host = "remote"', 'default_host = "missing"'),
        ),
        DISCORD_TOKEN: "token",
        OPENCODE_HOST_LOCAL_PASSWORD: "local",
        OPENCODE_HOST_REMOTE_PASSWORD: "remote",
      }),
    ).toThrow(/Default OpenCode host is not registered/);
  });

  it("rejects missing and empty referenced passwords without leaking values", () => {
    for (const password of [undefined, ""]) {
      const env: NodeJS.ProcessEnv = {
        OCB_CONFIG_FILE: fileWith(toml),
        DISCORD_TOKEN: "token",
        OPENCODE_HOST_LOCAL_PASSWORD: password,
        OPENCODE_HOST_REMOTE_PASSWORD: "remote",
      };
      const error = captureError(() => loadConfig(env));
      expect(error.message).toContain("OPENCODE_HOST_LOCAL_PASSWORD");
      expect(error.message).not.toContain("remote-secret");
    }
  });
});
