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

describe("metrics config", () => {
  it("defaults metrics to disabled loopback port 9464", () => {
    const config = loadConfig(baseEnv);
    expect(config.metricsEnabled).toBe(false);
    expect(config.metricsHost).toBe("127.0.0.1");
    expect(config.metricsPort).toBe(9464);
  });

  it("accepts explicit metrics listener configuration", () => {
    const config = loadConfig({
      ...baseEnv,
      OCB_METRICS_ENABLED: "true",
      OCB_METRICS_HOST: "0.0.0.0",
      OCB_METRICS_PORT: "19464",
    });
    expect(config.metricsEnabled).toBe(true);
    expect(config.metricsHost).toBe("0.0.0.0");
    expect(config.metricsPort).toBe(19464);
  });

  it("fails closed on invalid metrics configuration", () => {
    expect(() => loadConfig({ ...baseEnv, OCB_METRICS_ENABLED: "yes" })).toThrow(
      /Expected boolean/,
    );
    expect(() => loadConfig({ ...baseEnv, OCB_METRICS_HOST: "   " })).toThrow(/OCB_METRICS_HOST/);
    expect(() => loadConfig({ ...baseEnv, OCB_METRICS_PORT: "0" })).toThrow(/OCB_METRICS_PORT/);
    expect(() => loadConfig({ ...baseEnv, OCB_METRICS_PORT: "65536" })).toThrow(/OCB_METRICS_PORT/);
    expect(() => loadConfig({ ...baseEnv, OCB_METRICS_PORT: "9.5" })).toThrow(/OCB_METRICS_PORT/);
  });
});
