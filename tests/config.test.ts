import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "client",
  DISCORD_GUILD_ID: "guild",
  DISCORD_PARENT_CHANNEL_ID: "parent",
  DISCORD_ALLOWED_USER_IDS: "1, 2",
  OPENCODE_ALLOWED_ROOTS: "/tmp/repos,/srv/repos",
};

describe("loadConfig", () => {
  it("parses allowlists and secure permission default", () => {
    const config = loadConfig(baseEnv);
    expect([...config.allowedUserIds]).toEqual(["1", "2"]);
    expect(config.allowPermissionAlways).toBe(false);
    expect(config.opencodeBaseUrl).toBe("http://127.0.0.1:4096");
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
