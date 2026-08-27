import { describe, expect, it, vi } from "vitest";
import { PermissionPublicationTracker } from "../src/bridge/permission-publication.js";
import type { OpenCodePermissionRequest } from "../src/opencode/gateway.js";

const request: OpenCodePermissionRequest = {
  id: "per_1",
  sessionID: "ses_1",
  type: "bash",
  title: "bash",
  pattern: ["git status"],
};

describe("PermissionPublicationTracker", () => {
  it("coalesces concurrent live/reconcile publication into one send", async () => {
    const tracker = new PermissionPublicationTracker();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => gate);

    const first = tracker.publish("host-1", request, send);
    const second = tracker.publish("host-1", request, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release?.();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(tracker.current("host-1", "per_1")).toEqual(request);
  });

  it("rolls back a failed reservation so another publication can retry", async () => {
    const tracker = new PermissionPublicationTracker();
    const failedSend = vi.fn(async () => {
      throw new Error("discord send failed");
    });

    await expect(tracker.publish("host-1", request, failedSend)).rejects.toThrow(
      /discord send failed/,
    );
    expect(tracker.current("host-1", "per_1")).toBeUndefined();

    const retrySend = vi.fn(async () => undefined);
    await expect(tracker.publish("host-1", request, retrySend)).resolves.toBe(true);
    expect(retrySend).toHaveBeenCalledTimes(1);
    expect(tracker.current("host-1", "per_1")).toEqual(request);
  });

  it("clears resolved permissions", async () => {
    const tracker = new PermissionPublicationTracker();
    await tracker.publish("host-1", request, async () => undefined);
    tracker.clear("host-1", request.id);
    expect(tracker.current("host-1", request.id)).toBeUndefined();
  });
});
