import { describe, expect, it, vi } from "vitest";
import {
  executeLifecycleMutation,
  lifecycleBlockReason,
  renderLifecycleBlock,
} from "../src/bridge/session-lifecycle.js";

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
    expect(renderLifecycleBlock({ kind: "active-session", status: "busy" })).toContain(
      "use `/oc abort`, then retry",
    );
  });
});

describe("session lifecycle mutations", () => {
  it("close deletes the OpenCode session before removing the binding", async () => {
    const calls: string[] = [];
    await executeLifecycleMutation("close", {
      deleteSession: vi.fn(async () => {
        calls.push("delete-session");
      }),
      removeBinding: vi.fn(async () => {
        calls.push("remove-binding");
      }),
    });

    expect(calls).toEqual(["delete-session", "remove-binding"]);
  });

  it("close preserves the binding when session deletion fails", async () => {
    const removeBinding = vi.fn(async () => undefined);
    await expect(
      executeLifecycleMutation("close", {
        deleteSession: async () => {
          throw new Error("delete failed");
        },
        removeBinding,
      }),
    ).rejects.toThrow("delete failed");

    expect(removeBinding).not.toHaveBeenCalled();
  });

  it("unbind removes only the binding and never deletes the OpenCode session", async () => {
    const deleteSession = vi.fn(async () => undefined);
    const removeBinding = vi.fn(async () => undefined);

    await executeLifecycleMutation("unbind", { deleteSession, removeBinding });

    expect(deleteSession).not.toHaveBeenCalled();
    expect(removeBinding).toHaveBeenCalledTimes(1);
  });
});
