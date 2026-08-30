import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SubagentPanelManager } from "../src/bridge/subagent-panel-manager.js";
import { renderSubagentList } from "../src/discord/subagent.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import type { SubagentRoot } from "../src/domain/subagent-graph.js";
import type {
  SubagentInspectionList,
  SubagentInspector,
} from "../src/opencode/subagent-inspector.js";
import { StateStore } from "../src/state/state-store.js";

const binding: SessionBinding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  hostId: "local",
  sessionId: "session-1",
  directory: "/repo",
  title: "repo",
  createdBy: "user-1",
  createdAt: "2026-08-22T00:00:00.000Z",
};

const list: SubagentInspectionList = {
  items: [],
  depthBoundaryReached: false,
  sessionLimitReached: false,
};

type TestInspector = Pick<SubagentInspector, "listDescendants">;

async function fixture(
  options: {
    panelId?: string;
    existingContent?: string;
    fetchError?: unknown;
    sendGate?: Promise<void>;
    editGate?: Promise<void>;
    inspector?: TestInspector;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "ocdb-subagent-panel-"));
  const state = new StateStore(join(dir, "state.json"), "local");
  await state.load();
  await state.put({
    ...binding,
    ...(options.panelId ? { subagentPanelMessageId: options.panelId } : {}),
  });
  const edit = vi.fn(async () => {
    await options.editGate;
  });
  const fetchMessage = vi.fn(async () => {
    if (options.fetchError) throw options.fetchError;
    return {
      id: options.panelId ?? "panel-1",
      content: options.existingContent ?? "old",
      edit,
    };
  });
  const send = vi.fn(async () => {
    await options.sendGate;
    return { id: "created-panel" };
  });
  const thread = {
    isThread: () => true,
    messages: { fetch: fetchMessage },
    send,
  };
  const fetchThread = vi.fn(async () => thread);
  const discord = { channels: { fetch: fetchThread } };
  const inspector: TestInspector = options.inspector ?? {
    listDescendants: vi.fn(async (_root: SubagentRoot) => list),
  };
  const manager = new SubagentPanelManager({
    discord: discord as never,
    state,
    inspector,
  });
  return { manager, state, inspector, send, edit, fetchMessage, fetchThread };
}

describe("SubagentPanelManager", () => {
  it("creates an empty panel with mentions disabled", async () => {
    const { manager, state, send } = await fixture();
    await expect(manager.refreshBinding(binding)).resolves.toEqual(list);
    expect(send).toHaveBeenCalledWith({
      content: renderSubagentList(list),
      allowedMentions: { parse: [] },
    });
    expect(state.getByThread(binding.threadId)?.subagentPanelMessageId).toBe("created-panel");
  });

  it("edits an existing panel and skips identical content", async () => {
    const first = await fixture({ panelId: "panel-1", existingContent: "old" });
    await first.manager.refreshBinding(binding);
    expect(first.edit).toHaveBeenCalledTimes(1);
    const same = await fixture({
      panelId: "panel-1",
      existingContent: renderSubagentList(list),
    });
    await same.manager.refreshBinding(binding);
    expect(same.edit).not.toHaveBeenCalled();
    expect(same.send).not.toHaveBeenCalled();
  });

  it("converges an existing managed panel when a reachable child becomes idle", async () => {
    const child = {
      id: "child-1",
      parentId: binding.sessionId,
      parentSessionId: binding.sessionId,
      rootSessionId: binding.sessionId,
      directory: binding.directory,
      hostId: binding.hostId,
      depth: 1,
    };
    const busy: SubagentInspectionList = {
      items: [{ ...child, status: "busy" }],
      depthBoundaryReached: false,
      sessionLimitReached: false,
    };
    const idle: SubagentInspectionList = {
      items: [{ ...child, status: "idle" }],
      depthBoundaryReached: false,
      sessionLimitReached: false,
    };
    const inspector = {
      listDescendants: vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(idle),
    };
    const { manager, edit, send } = await fixture({
      panelId: "panel-1",
      existingContent: "old",
      inspector,
    });

    await manager.refreshBinding(binding);
    await manager.refreshBinding(binding);

    expect(edit).toHaveBeenNthCalledWith(1, {
      content: expect.stringContaining("Status: busy"),
      allowedMentions: { parse: [] },
    });
    expect(edit).toHaveBeenNthCalledWith(2, {
      content: expect.stringContaining("Status: idle"),
      allowedMentions: { parse: [] },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("recreates once for Discord unknown-message and propagates transient failures", async () => {
    const missing = await fixture({ panelId: "deleted", fetchError: { code: 10008 } });
    await missing.manager.refreshBinding(binding);
    expect(missing.send).toHaveBeenCalledTimes(1);

    const transient = new Error("unavailable");
    const failed = await fixture({ panelId: "panel-1", fetchError: transient });
    await expect(failed.manager.refreshBinding(binding)).rejects.toBe(transient);
    expect(failed.send).not.toHaveBeenCalled();
  });

  it("uses the canonical captured root and serializes concurrent refreshes", async () => {
    const inspector = { listDescendants: vi.fn(async () => list) };
    const { manager, inspector: actual, send } = await fixture({ inspector });
    const [first, second] = await Promise.all([
      manager.refreshBinding(binding),
      manager.refreshBinding({ ...binding, hostId: "local", directory: "/repo" }),
    ]);
    expect(first).toEqual(list);
    expect(second).toEqual(list);
    expect(actual.listDescendants).toHaveBeenCalledWith({
      hostId: "local",
      directory: "/repo",
      sessionId: "session-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the binding changes while inspection is awaiting", async () => {
    let release!: (value: SubagentInspectionList) => void;
    const inspector = {
      listDescendants: vi.fn(
        () =>
          new Promise<SubagentInspectionList>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const { manager, state, send } = await fixture({ inspector });
    const refresh = manager.refreshBinding(binding);
    await vi.waitFor(() => expect(inspector.listDescendants).toHaveBeenCalled());
    await state.put({ ...binding, sessionId: "changed" });
    release(list);
    await expect(refresh).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("serializes removal behind send and skips a refresh queued after removal", async () => {
    let release!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, state, inspector, send, fetchThread } = await fixture({ sendGate });
    const publication = manager.refreshBinding(binding);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    const removal = manager.runExclusive(binding.threadId, () => state.remove(binding.threadId));
    const queuedRefresh = manager.refreshBinding(binding);
    expect(state.getByThread(binding.threadId)).toBeDefined();
    release();

    await publication;
    await removal;
    await expect(queuedRefresh).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(inspector.listDescendants).toHaveBeenCalledTimes(1);
    expect(fetchThread).toHaveBeenCalledTimes(1);
    expect(state.getByThread(binding.threadId)).toBeUndefined();
  });

  it("serializes rebind behind edit and skips a refresh for the old binding", async () => {
    let release!: () => void;
    const editGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, state, inspector, send, edit, fetchThread } = await fixture({
      panelId: "panel-1",
      existingContent: "old",
      editGate,
    });
    const publication = manager.refreshBinding(binding);
    await vi.waitFor(() => expect(edit).toHaveBeenCalled());

    const rebound = manager.runExclusive(binding.threadId, async () => {
      await state.put({ ...binding, sessionId: "rebound" });
    });
    const queuedRefresh = manager.refreshBinding(binding);
    expect(state.getByThread(binding.threadId)?.sessionId).toBe("session-1");
    release();

    await publication;
    await rebound;
    await expect(queuedRefresh).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(inspector.listDescendants).toHaveBeenCalledTimes(1);
    expect(fetchThread).toHaveBeenCalledTimes(1);
    expect(state.getByThread(binding.threadId)?.sessionId).toBe("rebound");
  });
});
