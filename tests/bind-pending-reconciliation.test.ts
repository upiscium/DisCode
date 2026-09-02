import { describe, expect, it, vi } from "vitest";
import { reconcilePendingAfterBind } from "../src/bridge/bind-pending-reconciliation.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import { noopLogger } from "../src/logging/logger.js";

const binding: SessionBinding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  hostId: "adam",
  sessionId: "session-1",
  directory: "/private/repo",
  title: "Sensitive title",
  createdBy: "user-1",
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("reconcilePendingAfterBind", () => {
  it("runs Question and Permission recovery independently", async () => {
    const questions = vi.fn(async () => {
      throw new Error("question failure");
    });
    const permissions = vi.fn(async () => undefined);

    await reconcilePendingAfterBind({
      binding,
      questions,
      permissions,
      logger: noopLogger,
    });

    expect(questions).toHaveBeenCalledTimes(1);
    expect(permissions).toHaveBeenCalledTimes(1);
  });

  it("still runs Permission recovery when Question recovery throws synchronously", async () => {
    const permissions = vi.fn(async () => undefined);

    await expect(
      reconcilePendingAfterBind({
        binding,
        questions: () => {
          throw new Error("synchronous failure");
        },
        permissions,
        logger: noopLogger,
      }),
    ).resolves.toBeUndefined();

    expect(permissions).toHaveBeenCalledTimes(1);
  });

  it("logs both failures with safe bounded identifiers and still resolves", async () => {
    const warn = vi.fn<typeof noopLogger.warn>();

    await expect(
      reconcilePendingAfterBind({
        binding,
        questions: async () => {
          throw new Error("Question text /private/repo");
        },
        permissions: async () => {
          throw new Error("permission pattern /private/repo");
        },
        logger: { ...noopLogger, warn },
      }),
    ).resolves.toBeUndefined();

    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      "opencode.question_reconcile_failed",
      "opencode.permission_reconcile_failed",
    ]);
    for (const call of warn.mock.calls) {
      expect(call[2]).toEqual({
        host_id: "adam",
        session_id: "session-1",
        thread_id: "thread-1",
        trigger: "bind",
      });
      expect(JSON.stringify(call[2])).not.toContain("/private/repo");
      expect(JSON.stringify(call[2])).not.toContain("Sensitive title");
    }
  });

  it("bounds and replaces control characters in reconciliation log identifiers", async () => {
    const warn = vi.fn<typeof noopLogger.warn>();
    const unsafeBinding = {
      ...binding,
      hostId: `host\n${"h".repeat(300)}`,
      sessionId: `session\r${"s".repeat(300)}`,
      threadId: `thread\u001b${"t".repeat(300)}`,
    };

    await reconcilePendingAfterBind({
      binding: unsafeBinding,
      questions: async () => {
        throw new Error("failed");
      },
      permissions: async () => undefined,
      logger: { ...noopLogger, warn },
    });

    const fields = warn.mock.calls[0]?.[2] as Record<string, string>;
    for (const key of ["host_id", "session_id", "thread_id"]) {
      expect(fields[key]?.length).toBeLessThanOrEqual(256);
      expect(fields[key]).not.toContain("\n");
      expect(fields[key]).not.toContain("\r");
      expect(fields[key]).not.toContain(String.fromCharCode(0x1b));
      expect(fields[key]).toContain("�");
    }
  });
});
