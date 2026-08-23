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
};

async function fixture(options?: { headerMessageId?: string; existingContent?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "ocdb-header-"));
  const state = new StateStore(join(dir, "state.json"), "local");
  await state.load();
  await state.put({
    ...baseBinding,
    ...(options?.headerMessageId ? { headerMessageId: options.headerMessageId } : {}),
  });

  const edit = vi.fn(async (_options: { content: string; allowedMentions?: unknown }) => undefined);
  const fetchMessage = vi.fn(async () => ({
    id: options?.headerMessageId ?? "header-1",
    content: options?.existingContent ?? "old header",
    edit,
  }));
  const send = vi.fn(async () => ({ id: "created-header" }));
  const thread = {
    isThread: () => true,
    messages: { fetch: fetchMessage },
    send,
  };
  const discord = {
    channels: { fetch: vi.fn(async () => thread) },
  };
  const opencode = {
    sessionHeaderContext: vi.fn(async () => ({
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      branch: "feat/header",
    })),
  };

  const manager = new SessionHeaderManager({
    discord: discord as never,
    state,
    gatewayFor: (hostId) => {
      expect(hostId).toBe("local");
      return opencode as never;
    },
  });
  return { manager, state, send, fetchMessage, edit };
}

describe("SessionHeaderManager", () => {
  it("lazily creates and persists a managed header for legacy bindings", async () => {
    const { manager, state, send, fetchMessage } = await fixture();

    await manager.refreshSession("local", "session-1");

    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchMessage).not.toHaveBeenCalled();
    expect(state.getByThread("thread-1")?.headerMessageId).toBe("created-header");
  });

  it("skips Discord edits when the rendered header is unchanged", async () => {
    const content = renderSessionHeader({
      hostId: "local",
      sessionId: "session-1",
      directory: "/repo",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6" },
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
  });
});
