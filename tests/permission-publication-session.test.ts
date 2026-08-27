import { describe, expect, it } from "vitest";
import { PermissionPublicationTracker } from "../src/bridge/permission-publication.js";
import type { OpenCodePermissionRequest } from "../src/opencode/gateway.js";

function request(id: string, sessionID: string): OpenCodePermissionRequest {
  return { id, sessionID, type: "bash", title: "bash", pattern: ["git status"] };
}

describe("PermissionPublicationTracker session cleanup", () => {
  it("clears only matching host/session entries", async () => {
    const tracker = new PermissionPublicationTracker();
    const a = request("per_a", "ses_same");
    const b = request("per_b", "ses_same");
    const c = request("per_c", "ses_other");

    await tracker.publish("host-1", a, async () => undefined);
    await tracker.publish("host-2", b, async () => undefined);
    await tracker.publish("host-1", c, async () => undefined);

    tracker.clearSession("host-1", "ses_same");

    expect(tracker.current("host-1", "per_a")).toBeUndefined();
    expect(tracker.current("host-2", "per_b")).toEqual(b);
    expect(tracker.current("host-1", "per_c")).toEqual(c);
  });
});
