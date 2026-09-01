import { describe, expect, it, vi } from "vitest";
import { PermissionPublicationTracker } from "../src/bridge/permission-publication.js";
import { reconcilePendingPermissions } from "../src/bridge/permission-reconciliation.js";
import { noopLogger } from "../src/logging/logger.js";
import type { OpenCodePermissionRequest } from "../src/opencode/gateway.js";

function permission(id: string, sessionID: string): OpenCodePermissionRequest {
  return {
    id,
    sessionID,
    type: "bash",
    title: "bash",
    pattern: ["git status"],
  };
}

describe("reconcilePendingPermissions", () => {
  it("publishes only requests matching host, session, and queried directory", async () => {
    const publish = vi.fn(async () => undefined);
    const host1List = vi.fn(async (directory: string) => {
      if (directory === "/repo/a") {
        return [permission("per_a", "ses_same"), permission("per_unbound", "ses_unbound")];
      }
      return [permission("per_wrong_dir", "ses_same")];
    });
    const host2List = vi.fn(async () => [permission("per_b", "ses_same")]);

    await reconcilePendingPermissions({
      bindings: [
        { hostId: "host-1", sessionId: "ses_same", directory: "/repo/a" },
        { hostId: "host-1", sessionId: "ses_other", directory: "/repo/other" },
        { hostId: "host-2", sessionId: "ses_same", directory: "/repo/b" },
      ],
      hosts: [
        { id: "host-1", listPermissions: host1List },
        { id: "host-2", listPermissions: host2List },
      ],
      publish,
      logger: noopLogger,
    });

    expect(host1List).toHaveBeenCalledWith("/repo/a");
    expect(host1List).toHaveBeenCalledWith("/repo/other");
    expect(host2List).toHaveBeenCalledWith("/repo/b");
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith("host-1", "/repo/a", permission("per_a", "ses_same"));
    expect(publish).toHaveBeenCalledWith("host-2", "/repo/b", permission("per_b", "ses_same"));
  });

  it("isolates one host list failure and logs only bounded host context", async () => {
    const warn = vi.fn<typeof noopLogger.warn>();
    const publish = vi.fn(async () => undefined);

    await reconcilePendingPermissions({
      bindings: [
        { hostId: "host-1", sessionId: "ses_1", directory: "/private/one" },
        { hostId: "host-2", sessionId: "ses_2", directory: "/private/two" },
      ],
      hosts: [
        {
          id: "host-1",
          listPermissions: async () => {
            throw new Error("PASSWORD_SENTINEL /private/one raw metadata");
          },
        },
        {
          id: "host-2",
          listPermissions: async () => [permission("per_2", "ses_2")],
        },
      ],
      publish,
      logger: { ...noopLogger, warn },
    });

    expect(publish).toHaveBeenCalledWith("host-2", "/private/two", permission("per_2", "ses_2"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe("opencode.permission_reconcile_failed");
    expect(warn.mock.calls[0]?.[2]).toEqual({ host_id: "host-1" });
  });

  it("supports targeted singleton binding and host reconciliation", async () => {
    const listPermissions = vi.fn(async () => [permission("per_1", "ses_1")]);
    const publish = vi.fn(async () => undefined);

    await reconcilePendingPermissions({
      bindings: [{ hostId: "host-1", sessionId: "ses_1", directory: "/repo" }],
      hosts: [{ id: "host-1", listPermissions }],
      publish,
      logger: noopLogger,
    });

    expect(listPermissions).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      "host-1",
      "/repo",
      permission("per_1", "ses_1"),
    );
  });

  it("coalesces targeted reconciliation racing a live event through the existing tracker", async () => {
    const tracker = new PermissionPublicationTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => gate);
    const request = permission("per_1", "ses_1");
    const publish = (_hostId: string, _directory: string, value: OpenCodePermissionRequest) =>
      tracker.publish("host-1", value, send).then(() => undefined);

    const reconcile = reconcilePendingPermissions({
      bindings: [{ hostId: "host-1", sessionId: "ses_1", directory: "/repo" }],
      hosts: [{ id: "host-1", listPermissions: async () => [request] }],
      publish,
      logger: noopLogger,
    });
    const live = tracker.publish("host-1", request, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();

    await Promise.all([reconcile, live]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
