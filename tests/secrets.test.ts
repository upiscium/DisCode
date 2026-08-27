import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadSecretEnvironment, resolveSecretsFilePath } from "../src/secrets.js";

const registryJson = JSON.stringify({
  defaultHost: "host-1",
  hosts: [
    {
      id: "host-1",
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      passwordEnv: "OPENCODE_HOST_1_PASSWORD",
      allowedRoots: ["/tmp/repos"],
    },
  ],
});

describe("secret environment loader", () => {
  it("expands ~/ relative to the runtime user's home", () => {
    expect(resolveSecretsFilePath("~/secrets/ocb_secrets.env", { home: "/home/tester" })).toBe(
      "/home/tester/secrets/ocb_secrets.env",
    );
  });

  it("keeps absolute paths and resolves relative paths from cwd", () => {
    expect(resolveSecretsFilePath("/run/secrets/ocb.env", { cwd: "/srv/app" })).toBe(
      "/run/secrets/ocb.env",
    );
    expect(resolveSecretsFilePath("secrets/ocb.env", { cwd: "/srv/app" })).toBe(
      "/srv/app/secrets/ocb.env",
    );
  });

  it("loads Discord and multi-host secrets without overriding existing environment values", () => {
    const env: NodeJS.ProcessEnv = {
      OCB_SECRETS_FILE: "~/secrets/ocb_secrets.env",
      DISCORD_TOKEN: "environment-token",
      DISCORD_CLIENT_ID: "client",
      DISCORD_GUILD_ID: "guild",
      DISCORD_PARENT_CHANNEL_ID: "parent",
      DISCORD_ALLOWED_USER_IDS: "1",
      OPENCODE_HOSTS_JSON: registryJson,
    };

    loadSecretEnvironment({
      env,
      home: "/home/tester",
      readFile: (path) => {
        expect(path).toBe("/home/tester/secrets/ocb_secrets.env");
        return ["DISCORD_TOKEN=secret-file-token", "OPENCODE_HOST_1_PASSWORD=host-secret"].join(
          "\n",
        );
      },
    });

    const config = loadConfig(env);
    expect(config.discordToken).toBe("environment-token");
    expect(config.hostRegistry.get("host-1").password).toBe("host-secret");
  });

  it("loads legacy OpenCode password from the secret file", () => {
    const env: NodeJS.ProcessEnv = {
      OCB_SECRETS_FILE: "/run/secrets/ocb.env",
      DISCORD_CLIENT_ID: "client",
      DISCORD_GUILD_ID: "guild",
      DISCORD_PARENT_CHANNEL_ID: "parent",
      DISCORD_ALLOWED_USER_IDS: "1",
      OPENCODE_ALLOWED_ROOTS: "/tmp/repos",
    };

    loadSecretEnvironment({
      env,
      readFile: () => "DISCORD_TOKEN=token\nOPENCODE_SERVER_PASSWORD=legacy-secret\n",
    });

    const config = loadConfig(env);
    expect(config.discordToken).toBe("token");
    expect(config.opencodePassword).toBe("legacy-secret");
  });

  it("fails closed without exposing secret content when the configured file cannot be read", () => {
    expect(() =>
      loadSecretEnvironment({
        env: { OCB_SECRETS_FILE: "/missing/ocb.env" },
        readFile: () => {
          throw new Error("contains-super-secret-value");
        },
      }),
    ).toThrow("Failed to read OCB_SECRETS_FILE: /missing/ocb.env");
  });

  it("rejects malformed secret environment lines without echoing their content", () => {
    const malformed = "DISCORD_TOKEN=do-not-print-me\nnot-an-assignment";
    let error: unknown;
    try {
      loadSecretEnvironment({
        env: { OCB_SECRETS_FILE: "/tmp/ocb.env" },
        readFile: () => malformed,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Invalid OCB_SECRETS_FILE syntax");
    expect(String(error)).not.toContain("do-not-print-me");
  });

  it("rejects unsupported ~user path syntax", () => {
    expect(() => resolveSecretsFilePath("~someone/secrets.env", { home: "/home/tester" })).toThrow(
      /supports '~' only/,
    );
  });
});
