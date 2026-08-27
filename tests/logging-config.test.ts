import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "client",
  DISCORD_GUILD_ID: "guild",
  DISCORD_PARENT_CHANNEL_ID: "parent",
  DISCORD_ALLOWED_USER_IDS: "1",
  OPENCODE_ALLOWED_ROOTS: "/tmp/repos",
};

describe("logging config", () => {
  it("defaults manual runtime logging to info/pretty", () => {
    const config = loadConfig(baseEnv);
    expect(config.logLevel).toBe("info");
    expect(config.logFormat).toBe("pretty");
  });

  it("accepts explicit log level and format", () => {
    const config = loadConfig({
      ...baseEnv,
      OCB_LOG_LEVEL: "debug",
      OCB_LOG_FORMAT: "json",
    });
    expect(config.logLevel).toBe("debug");
    expect(config.logFormat).toBe("json");
  });

  it("fails closed on invalid log level or format", () => {
    expect(() => loadConfig({ ...baseEnv, OCB_LOG_LEVEL: "trace" })).toThrow(/OCB_LOG_LEVEL/);
    expect(() => loadConfig({ ...baseEnv, OCB_LOG_FORMAT: "text" })).toThrow(/OCB_LOG_FORMAT/);
  });
});
