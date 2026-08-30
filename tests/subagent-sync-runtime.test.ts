import { describe, expect, it, vi } from "vitest";
import { type Panels, SubagentSyncRuntime } from "../src/bridge/subagent-sync-runtime.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import type { SubagentInspectionList } from "../src/opencode/subagent-inspector.js";

const binding = (overrides: Partial<SessionBinding> = {}): SessionBinding => ({
  threadId: "thread",
  parentChannelId: "parent",
  hostId: "host",
  sessionId: "root",
  directory: "/repo",
  title: "not part of sync",
  createdBy: "user",
  createdAt: "now",
  ...overrides,
});

function inspection(root: SessionBinding, childId = "child"): SubagentInspectionList {
  return {
    items: [
      {
        id: childId,
        parentId: root.sessionId,
        parentSessionId: root.sessionId,
        rootSessionId: root.sessionId,
        directory: root.directory,
        hostId: root.hostId,
        depth: 1,
        status: "busy",
      },
    ],
    depthBoundaryReached: false,
    sessionLimitReached: false,
  };
}

function make(bindings: SessionBinding[] = [binding()]) {
  const current = bindings;
  const refreshBinding = vi.fn(async (item: SessionBinding) => inspection(item));
  const runExclusive = vi.fn(async (_threadId: string, operation: () => Promise<unknown>) =>
    operation(),
  );
  const panels = { refreshBinding, runExclusive } as unknown as Panels;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = new SubagentSyncRuntime({
    state: {
      list: () => current,
      getByThread: (threadId) => current.find((item) => item.threadId === threadId),
    },
    panels,
    logger,
  });
  return { current, refreshBinding, runExclusive, logger, runtime };
}

describe("SubagentSyncRuntime", () => {
  it("refreshes startup bindings and delegates mutations", async () => {
    const { refreshBinding, runExclusive, runtime } = make();
    await runtime.reconcileStartup();
    expect(refreshBinding).toHaveBeenCalledWith(binding());

    const operation = vi.fn(async () => 7);
    await expect(runtime.runBindingMutation("thread", operation)).resolves.toBe(7);
    expect(runExclusive).toHaveBeenCalledWith("thread", operation);
  });

  it("routes indexed events without exposing payload content", async () => {
    const { refreshBinding, logger, runtime } = make();
    await runtime.refreshInitial(binding());
    runtime.applyEvent("host", "/repo", {
      type: "session.status",
      properties: { sessionID: "child", title: "secret", content: "secret" },
    });
    await runtime.drainBinding("thread");

    expect(refreshBinding).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
  });

  it("uses exact state fallback for a cold event", async () => {
    const { refreshBinding, runtime } = make();
    runtime.applyEvent("host", "/repo", {
      type: "session.created",
      properties: { info: { id: "new-child", parentID: "root", directory: "/repo" } },
    });
    await runtime.drainBinding("thread");
    expect(refreshBinding).toHaveBeenCalledTimes(1);
  });

  it("selects both old child and new parent roots on reparent", async () => {
    const first = binding({ threadId: "first", sessionId: "root-a" });
    const second = binding({ threadId: "second", sessionId: "root-b" });
    const { refreshBinding, runtime } = make([first, second]);
    await runtime.reconcileStartup();

    runtime.applyEvent("host", "/repo", {
      type: "session.updated",
      properties: { info: { id: "child", parentID: "root-b", directory: "/repo" } },
    });
    await Promise.all([runtime.drainBinding("first"), runtime.drainBinding("second")]);
    expect(refreshBinding).toHaveBeenCalledTimes(4);
  });

  it("continues startup after failure and rebuilds the next index", async () => {
    const first = binding({ threadId: "first" });
    const second = binding({ threadId: "second", sessionId: "other" });
    const { refreshBinding, runtime } = make([first, second]);
    refreshBinding.mockImplementation(async (item) => {
      if (item.threadId === "first") throw new Error("temporary");
      return inspection(item, "rebuilt");
    });
    await runtime.reconcileStartup();

    runtime.applyEvent("host", "/repo", {
      type: "session.status",
      properties: { sessionID: "rebuilt" },
    });
    await runtime.drainBinding("second");
    expect(refreshBinding).toHaveBeenCalledTimes(3);
  });

  it("reconciles only the exact reconnecting host", async () => {
    const local = binding();
    const remote = binding({ threadId: "other", hostId: "other-host" });
    const { refreshBinding, runtime } = make([local, remote]);
    await runtime.reconcileHost("host");
    expect(refreshBinding).toHaveBeenCalledTimes(1);
    expect(refreshBinding).toHaveBeenCalledWith(local);
  });

  it("does not fan out equal child IDs across directories on deletion", async () => {
    const first = binding({ threadId: "first", directory: "/one" });
    const second = binding({ threadId: "second", directory: "/two" });
    const { refreshBinding, runtime } = make([first, second]);
    refreshBinding.mockImplementation(async (item) => inspection(item, "same-child"));
    await runtime.reconcileStartup();

    runtime.applyEvent("host", "/one", {
      type: "session.deleted",
      properties: { info: { id: "same-child", directory: "/one" } },
    });
    await runtime.drainBinding("first");
    expect(refreshBinding).toHaveBeenCalledTimes(3);
    expect(refreshBinding).toHaveBeenLastCalledWith(first);
  });

  it("coalesces an in-flight burst to one follow-up", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { refreshBinding, runtime } = make();
    refreshBinding.mockImplementation(async (item) => {
      await gate;
      return inspection(item);
    });

    const event = { type: "session.status", properties: { sessionID: "unknown" } };
    runtime.applyEvent("host", "/repo", event);
    runtime.applyEvent("host", "/repo", event);
    release();
    await runtime.drainBinding("thread");
    expect(refreshBinding).toHaveBeenCalledTimes(2);
  });

  it("does not index a successful refresh after state removal", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { current, refreshBinding, runtime } = make();
    refreshBinding.mockImplementation(async (item) => {
      await gate;
      return inspection(item);
    });
    const firstBinding = current[0];
    if (!firstBinding) throw new Error("missing test binding");

    const initial = runtime.refreshInitial(firstBinding);
    current.splice(0, 1);
    release();
    await initial;
    runtime.applyEvent("host", "/repo", {
      type: "session.status",
      properties: { sessionID: "child" },
    });
    await runtime.drainBinding("thread");
    expect(refreshBinding).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated events and isolates hosts", async () => {
    const { refreshBinding, runtime } = make();
    await runtime.refreshInitial(binding());
    runtime.applyEvent("other-host", "/repo", {
      type: "session.status",
      properties: { sessionID: "child" },
    });
    runtime.applyEvent("host", "/other", { type: "message.updated", properties: {} });
    await runtime.drainBinding("thread");
    expect(refreshBinding).toHaveBeenCalledTimes(1);
  });

  it("forgets indexed bindings after state removal", async () => {
    const { current, refreshBinding, runtime } = make();
    const item = binding();
    await runtime.refreshInitial(item);
    current.splice(0, 1);
    runtime.forgetBinding(item);
    runtime.applyEvent("host", "/repo", {
      type: "session.status",
      properties: { sessionID: "child" },
    });
    await runtime.drainBinding("thread");
    expect(refreshBinding).toHaveBeenCalledTimes(1);
  });
});
