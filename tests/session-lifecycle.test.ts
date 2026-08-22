import { describe, expect, it } from "vitest";
import { lifecycleBlockReason, renderLifecycleBlock } from "../src/bridge/session-lifecycle.js";

describe("session lifecycle policy", () => {
  it("allows idle or missing status when no Ask is pending", () => {
    expect(lifecycleBlockReason(undefined, false)).toBeUndefined();
    expect(lifecycleBlockReason("idle", false)).toBeUndefined();
  });

  it("blocks busy and retry sessions", () => {
    expect(lifecycleBlockReason("busy", false)).toEqual({
      kind: "active-session",
      status: "busy",
    });
    expect(lifecycleBlockReason("retry", false)).toEqual({
      kind: "active-session",
      status: "retry",
    });
  });

  it("prioritizes a pending Ask as the lifecycle blocker", () => {
    expect(lifecycleBlockReason("busy", true)).toEqual({ kind: "pending-question" });
    expect(renderLifecycleBlock({ kind: "pending-question" })).toMatch(/Ask is still pending/);
  });

  it("does not imply automatic abort", () => {
    expect(
      renderLifecycleBlock({ kind: "active-session", status: "busy" }),
    ).toContain("use `/oc abort`, then retry");
  });
});
