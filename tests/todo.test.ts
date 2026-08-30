import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TodoPanelManager } from "../src/bridge/todo-panel-manager.js";
import { renderTodoPanel } from "../src/discord/todo.js";
import type { OpenCodeEvent } from "../src/opencode/gateway.js";
import {
  normalizeOpenCodeTodoList,
  normalizeOpenCodeTodoUpdated,
} from "../src/opencode/todo-gateway.js";
import { StateStore } from "../src/state/state-store.js";

const binding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  hostId: "local",
  sessionId: "session-1",
  directory: "/repo",
  title: "repo",
  createdBy: "user-1",
  createdAt: "2026-08-30T00:00:00.000Z",
};

const todos = [
  { id: "1", content: "Implement cache", status: "in_progress", priority: "high" },
  { id: "2", content: "Add tests", status: "pending", priority: "medium" },
  { id: "3", content: "Update docs", status: "completed", priority: "low" },
  { id: "4", content: "Old approach", status: "cancelled", priority: "low" },
];

describe("OpenCode TODO normalization", () => {
  it("normalizes the stable session TODO payload", () => {
    expect(normalizeOpenCodeTodoList(todos)).toEqual(todos);
    expect(
      normalizeOpenCodeTodoList([
        { content: "No id required by Bridge", status: "pending", priority: "high" },
      ]),
    ).toEqual([{ content: "No id required by Bridge", status: "pending", priority: "high" }]);
  });

  it("rejects malformed TODO payloads", () => {
    expect(normalizeOpenCodeTodoList({ todos })).toBeUndefined();
    expect(
      normalizeOpenCodeTodoList([{ content: "missing status", priority: "low" }]),
    ).toBeUndefined();
  });

  it("normalizes the pinned todo.updated properties shape", () => {
    const event = {
      type: "todo.updated",
      properties: { sessionID: "session-1", todos },
    } satisfies Extract<OpenCodeEvent, { type: "todo.updated" }>;
    expect(normalizeOpenCodeTodoUpdated(event.properties)).toEqual({
      sessionID: "session-1",
      todos,
    });
    expect(
      normalizeOpenCodeTodoUpdated({
        sessionID: "session-1",
        todos: [{ content: "missing fields" }],
      }),
    ).toBeUndefined();
  });

  it("rejects unreasonably large TODO event fields before rendering", () => {
    expect(
      normalizeOpenCodeTodoUpdated({
        sessionID: "session-1",
        todos: [{ content: "x".repeat(4_001), status: "pending", priority: "high" }],
      }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTodoUpdated({
        sessionID: "session-1",
        todos: Array.from({ length: 501 }, () => ({
          content: "item",
          status: "pending",
          priority: "low",
        })),
      }),
    ).toBeUndefined();
  });
});

describe("renderTodoPanel", () => {
  it("renders all OpenCode statuses and priorities distinctly", () => {
    const rendered = renderTodoPanel(todos);
    expect(rendered).toContain("[~] `high` Implement cache");
    expect(rendered).toContain("[ ] `medium` Add tests");
    expect(rendered).toContain("[x] `low` Update docs");
    expect(rendered).toContain("[-] `low` Old approach");
    expect(rendered).toContain("pending 1 · in progress 1 · completed 1 · cancelled 1");
  });

  it("defines an explicit empty state", () => {
    expect(renderTodoPanel([])).toContain("No current TODO items");
  });

  it("bounds long panels and reports omitted items", () => {
    const rendered = renderTodoPanel(
      Array.from({ length: 80 }, (_, index) => ({
        content: `Task ${index} ${"x".repeat(80)}`,
        status: "pending",
        priority: "medium",
      })),
      700,
    );
    expect(rendered.length).toBeLessThanOrEqual(700);
    expect(rendered).toMatch(/… \+\d+ more/);
  });

  it("neutralizes mentions and markdown-like TODO content", () => {
    const rendered = renderTodoPanel([
      { content: "@everyone **danger** `code`", status: "pending", priority: "high" },
    ]);
    expect(rendered).not.toContain("@everyone");
    expect(rendered).toContain("＠everyone");
    expect(rendered).toContain("\\*\\*danger\\*\\*");
  });
});

describe("TodoPanelManager", () => {
  async function fixture(options?: {
    todoMessageId?: string;
    existingContent?: string;
    fetchError?: unknown;
  }) {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-todo-"));
    const state = new StateStore(join(dir, "state.json"), "local");
    await state.load();
    await state.put({
      ...binding,
      ...(options?.todoMessageId ? { todoMessageId: options.todoMessageId } : {}),
    });

    const edit = vi.fn(
      async (_options: { content: string; allowedMentions?: unknown }) => undefined,
    );
    const fetchMessage = vi.fn(async () => {
      if (options?.fetchError) throw options.fetchError;
      return {
        id: options?.todoMessageId ?? "todo-1",
        content: options?.existingContent ?? "old TODO",
        edit,
      };
    });
    const send = vi.fn(async (_options: { content: string; allowedMentions?: unknown }) => ({
      id: "created-todo",
    }));
    const thread = {
      isThread: () => true,
      messages: { fetch: fetchMessage },
      send,
    };
    const discord = {
      channels: { fetch: vi.fn(async () => thread) },
    };
    const gateway = {
      listTodos: vi.fn(async (_directory: string, _sessionId: string) => todos),
    };
    const manager = new TodoPanelManager({
      discord: discord as never,
      state,
      gatewayFor: (hostId) => {
        expect(hostId).toBe("local");
        return gateway;
      },
    });
    return { manager, state, gateway, send, fetchMessage, edit };
  }

  it("creates one managed panel and persists only its Discord message id", async () => {
    const { manager, state, gateway, send, fetchMessage } = await fixture();
    await manager.refreshSession("local", "session-1");

    expect(gateway.listTodos).toHaveBeenCalledWith("/repo", "session-1");
    expect(fetchMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.getByThread("thread-1")?.todoMessageId).toBe("created-todo");
    expect(state.getByThread("thread-1")).not.toHaveProperty("todos");
  });

  it("edits the existing managed panel instead of posting duplicates", async () => {
    const { manager, send, edit } = await fixture({
      todoMessageId: "todo-1",
      existingContent: "old TODO",
    });
    await manager.updateFromEvent("local", "/repo", "session-1", todos);

    expect(send).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]?.content).toContain("Implement cache");
  });

  it("does not edit when the rendered content is unchanged", async () => {
    const content = renderTodoPanel(todos);
    const { manager, send, edit } = await fixture({
      todoMessageId: "todo-1",
      existingContent: content,
    });

    await manager.updateFromEvent("local", "/repo", "session-1", todos);

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("recreates a managed panel when its persisted Discord message was deleted", async () => {
    const { manager, state, send } = await fixture({
      todoMessageId: "deleted-todo",
      fetchError: { code: 10008 },
    });
    await manager.refreshSession("local", "session-1");

    expect(send).toHaveBeenCalledTimes(1);
    expect(state.getByThread("thread-1")?.todoMessageId).toBe("created-todo");
  });

  it("propagates transient Discord fetch failures without sending", async () => {
    const transient = new Error("Discord unavailable");
    const { manager, send } = await fixture({
      todoMessageId: "todo-1",
      fetchError: transient,
    });

    await expect(manager.refreshSession("local", "session-1")).rejects.toBe(transient);
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores TODO events unless host, session, and directory match exactly", async () => {
    const { manager, send } = await fixture();

    await manager.updateFromEvent("other", "/repo", "session-1", todos);
    await manager.updateFromEvent("local", "/other", "session-1", todos);
    await manager.updateFromEvent("local", "/repo", "other-session", todos);
    await manager.updateFromEvent("local", "/repo", "unknown-session", todos);
    expect(send).not.toHaveBeenCalled();

    await manager.updateFromEvent("local", "/repo", "session-1", todos);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent refreshes per binding so only one panel is created", async () => {
    const { manager, send } = await fixture();

    await Promise.all([
      manager.refreshSession("local", "session-1"),
      manager.refreshSession("local", "session-1"),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("revalidates current refresh authority after waiting in the binding queue", async () => {
    const { manager, state, gateway, send } = await fixture();

    const refresh = manager.refreshSession("local", "session-1");
    await state.put({
      ...binding,
      hostId: "other",
      sessionId: "other-session",
      directory: "/other",
    });
    await refresh;

    expect(gateway.listTodos).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
