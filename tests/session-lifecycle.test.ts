import { describe, expect, it, vi } from "vitest";
import { PermissionPublicationTracker } from "../src/bridge/permission-publication.js";
import { QuestionPublicationTracker } from "../src/bridge/question-publication.js";
import {
  executeCloseMutation,
  executeUnbindMutation,
  lifecycleBlockReason,
  renderLifecycleBlock,
  runManagedPanelMutation,
  runPureUnbindLifecycleMutation,
  SessionLifecycleSerializer,
} from "../src/bridge/session-lifecycle.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import type {
  OpenCodePermissionRequest,
  OpenCodeQuestionRequest,
} from "../src/opencode/gateway.js";

const binding: SessionBinding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  hostId: "host-1",
  sessionId: "session-1",
  directory: "/workspace/project",
  title: "Test session",
  createdBy: "user-1",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const serializer = {
  async runBindingMutation<T>(_threadId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  },
};

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

  it.each(["busy", "retry", "pending Question", "pending Permission", "unreachable"])(
    "pure unbind ignores OpenCode %s state and never invokes destructive APIs",
    async () => {
      const status = vi.fn(async () => {
        throw new Error("OpenCode unavailable");
      });
      const abort = vi.fn();
      const rejectQuestion = vi.fn();
      const replyPermission = vi.fn();
      const deleteSession = vi.fn();
      const removeBinding = vi.fn(async () => undefined);

      await runPureUnbindLifecycleMutation({
        binding,
        currentBinding: () => binding,
        lifecycle: new SessionLifecycleSerializer(),
        todos: serializer,
        subagents: serializer,
        operations: {
          removeBinding,
          forgetBinding: vi.fn(),
          clearPendingQuestions: vi.fn(),
          clearQuestionPublications: vi.fn(),
          clearPermissionPublications: vi.fn(),
        },
      });

      expect(removeBinding).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
      expect(rejectQuestion).not.toHaveBeenCalled();
      expect(replyPermission).not.toHaveBeenCalled();
      expect(deleteSession).not.toHaveBeenCalled();
    },
  );

  it("pure unbind clears transient publications so pending requests can publish after rebind", async () => {
    const question: OpenCodeQuestionRequest = {
      id: "question-1",
      sessionID: binding.sessionId,
      questions: [{ header: "Confirm", question: "Continue?", options: [] }],
    };
    const permission: OpenCodePermissionRequest = {
      id: "permission-1",
      sessionID: binding.sessionId,
      type: "bash",
      title: "bash",
      pattern: ["printf test"],
    };
    const pendingQuestions = new Set([`${binding.hostId}:${binding.sessionId}`]);
    const questions = new QuestionPublicationTracker();
    const permissions = new PermissionPublicationTracker();
    const questionSend = vi.fn(async () => undefined);
    const permissionSend = vi.fn(async () => undefined);
    await questions.publish(binding.hostId, question, questionSend);
    await permissions.publish(binding.hostId, permission, permissionSend);

    await runPureUnbindLifecycleMutation({
      binding,
      currentBinding: () => binding,
      lifecycle: new SessionLifecycleSerializer(),
      todos: serializer,
      subagents: serializer,
      operations: {
        removeBinding: vi.fn(async () => undefined),
        forgetBinding: vi.fn(),
        clearPendingQuestions: () =>
          pendingQuestions.delete(`${binding.hostId}:${binding.sessionId}`),
        clearQuestionPublications: () => questions.clearSession(binding.hostId, binding.sessionId),
        clearPermissionPublications: () =>
          permissions.clearSession(binding.hostId, binding.sessionId),
      },
    });

    expect(pendingQuestions.size).toBe(0);
    expect(questions.current(binding.hostId, question.id)).toBeUndefined();
    expect(permissions.current(binding.hostId, permission.id)).toBeUndefined();
    await expect(questions.publish(binding.hostId, question, questionSend)).resolves.toBe(true);
    await expect(permissions.publish(binding.hostId, permission, permissionSend)).resolves.toBe(
      true,
    );
    expect(questionSend).toHaveBeenCalledTimes(2);
    expect(permissionSend).toHaveBeenCalledTimes(2);
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
