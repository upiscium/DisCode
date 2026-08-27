import { describe, expect, it } from "vitest";
import { Logger } from "../src/logging/logger.js";

const fixedNow = () => new Date("2026-08-27T12:34:56.789Z");

describe("Logger", () => {
  it("writes one structured JSON record with stable event and scalar context", () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: "debug",
      format: "json",
      write: (line) => lines.push(line),
      now: fixedNow,
    });

    logger.info("session.created", "OpenCode session created", {
      host_id: "host-1",
      session_id: "ses_123",
      thread_id: "thread-123",
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      timestamp: "2026-08-27T12:34:56.789Z",
      level: "info",
      event: "session.created",
      message: "OpenCode session created",
      host_id: "host-1",
      session_id: "ses_123",
      thread_id: "thread-123",
    });
  });

  it("redacts known secret values and sensitive fields without serializing raw objects or stacks", () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: "debug",
      format: "json",
      secrets: ["TOKEN_SENTINEL", "PASSWORD_SENTINEL"],
      write: (line) => lines.push(line),
      now: fixedNow,
    });

    logger.error(
      "discord.interaction_failed",
      "request failed with TOKEN_SENTINEL",
      {
        host_id: "host-1",
        authorization: "Bearer TOKEN_SENTINEL",
        password_hint: "PASSWORD_SENTINEL",
        prompt: "do not retain this prompt",
        raw_config: { DISCORD_TOKEN: "TOKEN_SENTINEL" },
      },
      new Error("PASSWORD_SENTINEL exploded"),
    );

    const line = lines[0] ?? "";
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(line).not.toContain("TOKEN_SENTINEL");
    expect(line).not.toContain("PASSWORD_SENTINEL");
    expect(line).not.toContain("do not retain this prompt");
    expect(line).not.toContain("DISCORD_TOKEN");
    expect(line).not.toContain("stack");
    expect(record.authorization).toBe("[REDACTED]");
    expect(record.password_hint).toBe("[REDACTED]");
    expect(record.prompt).toBe("[OMITTED]");
    expect(record.raw_config).toBe("[OMITTED]");
    expect(record.error_type).toBe("Error");
    expect(record.error_message).toBe("[REDACTED] exploded");
  });

  it("filters records below the configured level", () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: "warn",
      format: "json",
      write: (line) => lines.push(line),
      now: fixedNow,
    });

    logger.debug("debug.hidden", "hidden");
    logger.info("info.hidden", "hidden");
    logger.warn("warn.visible", "visible");
    logger.error("error.visible", "visible");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"event":"warn.visible"');
    expect(lines[1]).toContain('"event":"error.visible"');
  });

  it("supports readable pretty output while preserving structured context", () => {
    const lines: string[] = [];
    const logger = new Logger({
      level: "info",
      format: "pretty",
      write: (line) => lines.push(line),
      now: fixedNow,
    });

    logger.info("bridge.started", "Bridge started", { host_count: 2 });

    expect(lines[0]).toBe(
      "2026-08-27T12:34:56.789Z INFO bridge.started: Bridge started host_count=2",
    );
  });
});
