import { describe, expect, it, vi } from "vitest";
import {
  executeCloseMutation,
  executeUnbindMutation,
  lifecycleBlockReason,
  renderLifecycleBlock,
  runManagedPanelMutation,
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
    await executeCloseMutation({
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
      executeCloseMutation({
        deleteSession: async () => {
          throw new Error("delete failed");
        },
        removeBinding,
      }),
    ).rejects.toThrow("delete failed");

    expect(removeBinding).not.toHaveBeenCalled();
  });

  it("unbind can only remove the binding", async () => {
    const removeBinding = vi.fn(async () => undefined);

    await executeUnbindMutation({ removeBinding });

    expect(removeBinding).toHaveBeenCalledTimes(1);
  });

  it("acquires the TODO queue before the SubAgent queue", async () => {
    const calls: string[] = [];
    const serializer = (name: string) => ({
      async runBindingMutation<T>(_threadId: string, operation: () => Promise<T>): Promise<T> {
        calls.push(`${name}:enter`);
        const result = await operation();
        calls.push(`${name}:exit`);
        return result;
      },
    });

    await runManagedPanelMutation(
      "thread",
      serializer("todo"),
      serializer("subagent"),
      async () => {
        calls.push("mutation");
      },
    );

    expect(calls).toEqual([
      "todo:enter",
      "subagent:enter",
      "mutation",
      "subagent:exit",
      "todo:exit",
    ]);
  });
});
