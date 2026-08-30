import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodoRuntime } from "../src/bridge/todo-runtime.js";
import { StateStore } from "../src/state/state-store.js";

const localBinding = {
  threadId: "thread-local",
  parentChannelId: "parent-1",
  hostId: "local",
  sessionId: "session-local",
  directory: "/repo/local",
  title: "local",
  createdBy: "user-1",
  createdAt: "2026-08-30T00:00:00.000Z",
};

const remoteBinding = {
  ...localBinding,
  threadId: "thread-remote",
  hostId: "remote",
  sessionId: "session-remote",
  directory: "/repo/remote",
  title: "remote",
};

describe("TodoRuntime", () => {
  let state: StateStore;
  let panels: {
    refreshSession: ReturnType<typeof vi.fn>;
    runExclusive: ReturnType<typeof vi.fn>;
    updateFromEvent: ReturnType<typeof vi.fn>;
  };
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let runtime: TodoRuntime;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-todo-runtime-"));
    state = new StateStore(join(dir, "state.json"), "local");
    await state.load();
    panels = {
      refreshSession: vi.fn(async () => undefined),
      runExclusive: vi.fn(async (_threadId: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
      updateFromEvent: vi.fn(async () => undefined),
    };
    logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    runtime = new TodoRuntime({ state, panels: panels as never, logger: logger as never });
  });

  it("refreshes current OpenCode state for the command's bound thread only", async () => {
    await state.put(localBinding);
    const reply = vi.fn(async () => undefined);
    const options = { getString: vi.fn(() => "attacker-override") };

    await runtime.handleCommand({ channelId: localBinding.threadId, reply, options } as never);

    expect(panels.refreshSession).toHaveBeenCalledWith("local", "session-local");
    expect(options.getString).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "TODO panel refreshed from current OpenCode state.",
      }),
    );
  });

  it("rejects /oc todo outside a bound thread", async () => {
    const reply = vi.fn(async () => undefined);

    await runtime.handleCommand({ channelId: "unbound", reply } as never);

    expect(panels.refreshSession).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "This is not a bound OpenCode thread." }),
    );
  });

  it("normalizes todo.updated before routing the authoritative event payload", async () => {
    const todos = [{ content: "secret TODO body", status: "pending", priority: "high" }];

    await runtime.applyEvent("local", "/repo/local", {
      sessionID: "session-local",
      todos,
    });
    await runtime.applyEvent("local", "/repo/local", {
      sessionID: "session-local",
      todos: [{ content: "malformed" }],
    });

    expect(panels.updateFromEvent).toHaveBeenCalledTimes(1);
    expect(panels.updateFromEvent).toHaveBeenCalledWith(
      "local",
      "/repo/local",
      "session-local",
      todos,
    );
  });

  it("triggers a bounded initial refresh after session binding", async () => {
    await state.put(localBinding);

    await runtime.refreshInitial(localBinding);

    expect(panels.refreshSession).toHaveBeenCalledWith("local", "session-local");
  });

  it("continues startup reconciliation after one binding fails", async () => {
    await state.put(localBinding);
    await state.put(remoteBinding);
    panels.refreshSession
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce(undefined);

    await runtime.reconcileStartup();

    expect(panels.refreshSession).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "discord.todo_panel_failed",
      expect.any(String),
      expect.objectContaining({ host_id: "local", trigger: "startup" }),
      expect.any(Error),
    );
  });

  it("reconciles only bindings on the reconnected host", async () => {
    await state.put(localBinding);
    await state.put(remoteBinding);

    await runtime.reconcileHost("remote");

    expect(panels.refreshSession).toHaveBeenCalledTimes(1);
    expect(panels.refreshSession).toHaveBeenCalledWith("remote", "session-remote");
  });

  it("does not place TODO content in bounded failure logs", async () => {
    const todoBody = "private TODO body";
    panels.refreshSession.mockRejectedValueOnce(new Error(todoBody));

    await runtime.refreshInitial(localBinding);

    const serializedCalls = JSON.stringify(logger.warn.mock.calls);
    expect(serializedCalls).not.toContain(todoBody);
  });

  it("serializes binding removal with managed panel publication", async () => {
    const remove = vi.fn(async () => undefined);

    await runtime.runBindingMutation("thread-local", remove);

    expect(panels.runExclusive).toHaveBeenCalledWith("thread-local", remove);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
