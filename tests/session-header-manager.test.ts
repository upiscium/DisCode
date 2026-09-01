import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionHeaderManager } from "../src/bridge/session-header-manager.js";
import { renderSessionHeader } from "../src/discord/session-header.js";
import { StateStore } from "../src/state/state-store.js";

const baseBinding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  hostId: "local",
  sessionId: "session-1",
  directory: "/repo",
  title: "repo",
  createdBy: "user-1",
  createdAt: "2026-08-22T00:00:00.000Z",
  model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.6" },
  agent: "review",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(options?: {
  headerMessageId?: string;
  existingContent?: string;
  contextGate?: ReturnType<typeof deferred>;
  sendGate?: ReturnType<typeof deferred>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "ocdb-header-"));
  const state = new StateStore(join(dir, "state.json"), "local");
  await state.load();
  await state.put({
    ...baseBinding,
    ...(options?.headerMessageId ? { headerMessageId: options.headerMessageId } : {}),
  });

  const edit = vi.fn(async (_options: { content: string; allowedMentions?: unknown }) => undefined);
  const deleteMessage = vi.fn(async () => undefined);
  const fetchMessage = vi.fn(async () => ({
    id: options?.headerMessageId ?? "header-1",
    content: options?.existingContent ?? "old header",
    edit,
  }));
  const send = vi.fn(async (_options: { content: string; allowedMentions?: unknown }) => {
    await options?.sendGate?.promise;
    return { id: "created-header", delete: deleteMessage };
  });
  const thread = {
    isThread: () => true,
    messages: { fetch: fetchMessage },
    send,
  };
  const discord = {
    channels: { fetch: vi.fn(async () => thread) },
  };
  const opencode = {
    sessionHeaderContext: vi.fn(async () => {
      await options?.contextGate?.promise;
      return {
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.6" },
        branch: "feat/header",
      };
    }),
  };

  const manager = new SessionHeaderManager({
    discord: discord as never,
    state,
    gatewayFor: (hostId) => {
      expect(hostId).toBe("local");
      return opencode as never;
    },
  });
  return { manager, state, send, fetchMessage, edit, deleteMessage, opencode };
}

describe("SessionHeaderManager", () => {
  it("lazily creates and persists a managed header for bindings", async () => {
    const { manager, state, send, fetchMessage } = await fixture();

    await manager.refreshSession("local", "session-1");

    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchMessage).not.toHaveBeenCalled();
    expect(state.getByThread("thread-1")?.headerMessageId).toBe("created-header");
    expect(send.mock.calls[0]?.[0]?.content).toContain("Latest actual model: `openai/gpt-5.6`");
    expect(send.mock.calls[0]?.[0]?.content).toContain(
      "Discord model preference: `openrouter/anthropic/claude-sonnet-4.6`",
    );
    expect(send.mock.calls[0]?.[0]?.content).toContain("Discord agent preference: `review`");
  });

  it("skips Discord edits when the rendered header is unchanged", async () => {
    const content = renderSessionHeader({
      hostId: "local",
      sessionId: "session-1",
      directory: "/repo",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      preferenceModel: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.6" },
      preferenceAgent: "review",
      branch: "feat/header",
    });
    const { manager, edit } = await fixture({
      headerMessageId: "header-1",
      existingContent: content,
    });

    await manager.refreshSession("local", "session-1");

    expect(edit).not.toHaveBeenCalled();
  });

  it("edits an existing managed header when context changes", async () => {
    const { manager, edit } = await fixture({
      headerMessageId: "header-1",
      existingContent: "old header",
    });

    await manager.refreshSession("local", "session-1");

    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]?.content).toContain("Host: `local`");
    expect(edit.mock.calls[0]?.[0]?.content).toContain("Branch: `feat/header`");
    expect(edit.mock.calls[0]?.[0]?.content).toContain("Latest actual agent: `build`");
    expect(edit.mock.calls[0]?.[0]?.content).toContain("Discord agent preference: `review`");
  });

  it("serializes an initial create behind a concurrent refresh", async () => {
    const contextGate = deferred();
    const { manager, send } = await fixture({ contextGate });

    const refresh = manager.refreshSession("local", "session-1");
    await vi.waitFor(() => expect(send).not.toHaveBeenCalled());
    const initial = manager.createInitialHeader(baseBinding, {
      send,
      isThread: () => true,
      messages: { fetch: vi.fn() },
    } as never);
    contextGate.resolve();

    await Promise.all([refresh, initial]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not publish a refresh after its binding is removed during OpenCode I/O", async () => {
    const contextGate = deferred();
    const { manager, state, send, opencode } = await fixture({ contextGate });

    const refresh = manager.refreshSession("local", "session-1");
    await vi.waitFor(() => expect(opencode.sessionHeaderContext).toHaveBeenCalledTimes(1));
    await state.remove("thread-1");
    contextGate.resolve();
    await refresh;

    expect(send).not.toHaveBeenCalled();
    expect(state.getByThread("thread-1")).toBeUndefined();
  });

  it("does not publish a refresh for a replacement binding", async () => {
    const contextGate = deferred();
    const { manager, state, send, opencode } = await fixture({ contextGate });

    const refresh = manager.refreshSession("local", "session-1");
    await vi.waitFor(() => expect(opencode.sessionHeaderContext).toHaveBeenCalledTimes(1));
    await state.put({ ...baseBinding, directory: "/replacement" });
    contextGate.resolve();
    await refresh;

    expect(send).not.toHaveBeenCalled();
    expect(state.getByThread("thread-1")?.directory).toBe("/replacement");
  });

  it("does not persist an initial header after its binding is removed during Discord I/O", async () => {
    const sendGate = deferred();
    const { manager, state, send, deleteMessage } = await fixture({ sendGate });

    const initial = manager.createInitialHeader(baseBinding, {
      send,
      isThread: () => true,
      messages: { fetch: vi.fn() },
    } as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await state.remove("thread-1");
    sendGate.resolve();
    await initial;

    expect(state.getByThread("thread-1")).toBeUndefined();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("deletes a lazy refresh header when its binding is removed during Discord I/O", async () => {
    const sendGate = deferred();
    const { manager, state, send, deleteMessage } = await fixture({ sendGate });

    const refresh = manager.refreshSession("local", "session-1");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await state.remove("thread-1");
    sendGate.resolve();
    await refresh;

    expect(state.getByThread("thread-1")).toBeUndefined();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });
});
