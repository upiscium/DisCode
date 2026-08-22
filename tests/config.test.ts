import { describe, expect, it } from "vitest";
import { loadConfig, loadHostRegistry } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "client",
  DISCORD_GUILD_ID: "guild",
  DISCORD_PARENT_CHANNEL_ID: "parent",
  DISCORD_ALLOWED_USER_IDS: "1, 2",
  OPENCODE_ALLOWED_ROOTS: "/tmp/repos,/srv/repos",
};

const registryJson = JSON.stringify({
  defaultHost: "lab",
  hosts: [
    {
      id: "local",
      baseUrl: "http://127.0.0.1:4096/",
      username: "opencode",
      passwordEnv: "OPENCODE_HOST_LOCAL_PASSWORD",
      allowedRoots: ["/tmp/local"],
    },
    {
      id: "lab",
      baseUrl: "https://lab.example.test:4096/",
      username: "bridge",
      passwordEnv: "OPENCODE_HOST_LAB_PASSWORD",
      allowedRoots: ["/srv/lab", "/srv/lab"],
    },
  ],
});

describe("loadConfig", () => {
  it("parses allowlists and secure feature defaults", () => {
    const config = loadConfig(baseEnv);
    expect([...config.allowedUserIds]).toEqual(["1", "2"]);
    expect(config.allowPermissionAlways).toBe(false);
    expect(config.streamAssistantText).toBe(false);
    expect(config.showToolSummaries).toBe(false);
    expect(config.opencodeBaseUrl).toBe("http://127.0.0.1:4096");
  });

  it("builds a legacy single-host registry without changing runtime fields", () => {
    const config = loadConfig({
      ...baseEnv,
      OPENCODE_SERVER_USERNAME: "legacy-user",
      OPENCODE_SERVER_PASSWORD: "legacy-secret",
    });

    expect(config.hostRegistry.defaultHost().id).toBe("default");
    expect(config.hostRegistry.list()).toHaveLength(1);
    expect(config.opencodeUsername).toBe("legacy-user");
    expect(config.opencodePassword).toBe("legacy-secret");
    expect(config.allowedRoots).toEqual(["/tmp/repos", "/srv/repos"]);
  });

  it("projects the configured default host into the existing single-host runtime view", () => {
    const config = loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "client",
      DISCORD_GUILD_ID: "guild",
      DISCORD_PARENT_CHANNEL_ID: "parent",
      DISCORD_ALLOWED_USER_IDS: "1",
      OPENCODE_HOSTS_JSON: registryJson,
      OPENCODE_HOST_LOCAL_PASSWORD: "local-secret",
      OPENCODE_HOST_LAB_PASSWORD: "lab-secret",
    });

    expect(config.hostRegistry.list().map((host) => host.id)).toEqual(["local", "lab"]);
    expect(config.hostRegistry.defaultHost().id).toBe("lab");
    expect(config.opencodeBaseUrl).toBe("https://lab.example.test:4096");
    expect(config.opencodeUsername).toBe("bridge");
    expect(config.opencodePassword).toBe("lab-secret");
    expect(config.allowedRoots).toEqual(["/srv/lab"]);
  });

  it("allows buffered assistant streaming to be enabled explicitly", () => {
    const config = loadConfig({ ...baseEnv, DISCORD_STREAM_ASSISTANT_TEXT: "true" });
    expect(config.streamAssistantText).toBe(true);
  });

  it("allows redacted tool summaries to be enabled explicitly", () => {
    const config = loadConfig({ ...baseEnv, DISCORD_SHOW_TOOL_SUMMARIES: "true" });
    expect(config.showToolSummaries).toBe(true);
  });

  it("requires an explicit user allowlist", () => {
    expect(() => loadConfig({ ...baseEnv, DISCORD_ALLOWED_USER_IDS: "" })).toThrow(
      /DISCORD_ALLOWED_USER_IDS/,
    );
  });

  it("rejects non-http OpenCode URLs", () => {
    expect(() => loadConfig({ ...baseEnv, OPENCODE_BASE_URL: "ssh://localhost" })).toThrow(
      /http or https/,
    );
  });
});

describe("loadHostRegistry", () => {
  it("resolves passwordEnv without retaining the env variable name", () => {
    const registry = loadHostRegistry({
      OPENCODE_HOSTS_JSON: registryJson,
      OPENCODE_HOST_LOCAL_PASSWORD: "local-secret",
      OPENCODE_HOST_LAB_PASSWORD: "lab-secret",
    });

    expect(registry.get("local").password).toBe("local-secret");
    expect(JSON.stringify(registry)).not.toContain("OPENCODE_HOST_LOCAL_PASSWORD");
    expect(JSON.stringify(registry)).not.toContain("local-secret");
  });

  it("rejects URL userinfo and unknown fields", () => {
    const withCredentials = JSON.stringify({
      defaultHost: "local",
      hosts: [
        {
          id: "local",
          baseUrl: "http://user:secret@127.0.0.1:4096",
          username: "opencode",
          allowedRoots: ["/tmp"],
        },
      ],
    });
    expect(() => loadHostRegistry({ OPENCODE_HOSTS_JSON: withCredentials })).toThrow(
      /must not contain URL credentials/,
    );

    const withUnknown = JSON.stringify({
      defaultHost: "local",
      hosts: [
        {
          id: "local",
          baseUrl: "http://127.0.0.1:4096",
          username: "opencode",
          allowedRoots: ["/tmp"],
          unexpected: true,
        },
      ],
    });
    expect(() => loadHostRegistry({ OPENCODE_HOSTS_JSON: withUnknown })).toThrow(/unknown field/);
  });

  it("rejects missing password env, duplicate host IDs, and unknown defaults", () => {
    expect(() =>
      loadHostRegistry({
        OPENCODE_HOSTS_JSON: JSON.stringify({
          defaultHost: "local",
          hosts: [
            {
              id: "local",
              baseUrl: "http://127.0.0.1:4096",
              username: "opencode",
              passwordEnv: "MISSING_PASSWORD",
              allowedRoots: ["/tmp"],
            },
          ],
        }),
      }),
    ).toThrow(/MISSING_PASSWORD/);

    expect(() =>
      loadHostRegistry({
        OPENCODE_HOSTS_JSON: JSON.stringify({
          defaultHost: "local",
          hosts: [
            {
              id: "local",
              baseUrl: "http://127.0.0.1:4096",
              username: "opencode",
              allowedRoots: ["/tmp"],
            },
            {
              id: "local",
              baseUrl: "http://127.0.0.1:4097",
              username: "opencode",
              allowedRoots: ["/srv"],
            },
          ],
        }),
      }),
    ).toThrow(/Duplicate OpenCode host ID/);

    expect(() =>
      loadHostRegistry({
        OPENCODE_HOSTS_JSON: JSON.stringify({
          defaultHost: "missing",
          hosts: [
            {
              id: "local",
              baseUrl: "http://127.0.0.1:4096",
              username: "opencode",
              allowedRoots: ["/tmp"],
            },
          ],
        }),
      }),
    ).toThrow(/Default OpenCode host is not registered/);
  });
});
