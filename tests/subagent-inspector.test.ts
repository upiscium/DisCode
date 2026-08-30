import { describe, expect, it, vi } from "vitest";
import { renderSubagentDetail, renderSubagentList } from "../src/discord/subagent.js";
import type { NormalizedTranscript } from "../src/opencode/child-session-gateway.js";
import { SubagentInspector } from "../src/opencode/subagent-inspector.js";
import { normalizeOpenCodeTodoList } from "../src/opencode/todo-gateway.js";

const root = { hostId: "host-a", directory: "/repo", sessionId: "root" };
const child = {
  hostId: "host-a",
  id: "child",
  parentId: "root",
  directory: "/repo",
  title: "Inspect tests",
  createdAt: 1,
  updatedAt: 2,
};

function fixture(options: { todoFails?: boolean } = {}) {
  const recentMessages: NormalizedTranscript[] = [
    {
      id: "message-1",
      sessionId: "child",
      role: "user",
      agent: "explore",
      model: { providerID: "openai", modelID: "gpt-test" },
      textParts: ["Inspect the tests"],
      toolActivity: [{ tool: "read", status: "completed" }],
    },
  ];
  const gateway = {
    listChildren: vi.fn(async (_directory: string, parentId: string) =>
      parentId === "root" ? [child] : [],
    ),
    getSession: vi.fn(async () => child),
    getStatus: vi.fn(async () => "busy" as const),
    listStatuses: vi.fn(async () => ({ child: "busy" as const })),
    getRecentMessages: vi.fn(async (): Promise<NormalizedTranscript[]> => recentMessages),
  };
  const normalizedTodos = normalizeOpenCodeTodoList([
    { content: "Review coverage", status: "pending", priority: "high" },
  ]);
  if (!normalizedTodos) throw new Error("test TODO fixture must normalize");
  const todo = {
    listTodos: vi.fn(async () => {
      if (options.todoFails) throw new Error("TODO unavailable");
      return normalizedTodos;
    }),
  };
  const inspector = new SubagentInspector({
    gatewayFor: (hostId) => {
      expect(hostId).toBe("host-a");
      return gateway;
    },
    todoGatewayFor: (hostId) => {
      expect(hostId).toBe("host-a");
      return todo;
    },
  });
  return { inspector, gateway, todo, normalizedTodos };
}

describe("SubagentInspector", () => {
  it("loads current metadata outward from the bound root", async () => {
    const { inspector, gateway } = fixture();

    const result = await inspector.listDescendants(root);

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "child",
        parentSessionId: "root",
        rootSessionId: "root",
        hostId: "host-a",
        directory: "/repo",
        depth: 1,
        status: "busy",
        agent: "explore",
        model: { providerID: "openai", modelID: "gpt-test" },
      }),
    ]);
    expect(gateway.getRecentMessages).toHaveBeenCalledWith("/repo", "child", 6);
    expect(gateway.listStatuses).toHaveBeenCalledTimes(1);
    expect(gateway.getStatus).not.toHaveBeenCalled();
    expect(renderSubagentList(result)).toContain("Inspect tests");
  });

  it("returns current transcript, safe tool activity, and normalized child TODO", async () => {
    const { inspector, todo, normalizedTodos } = fixture();

    const detail = await inspector.inspectDescendant(root, "child");

    expect(detail).toMatchObject({
      id: "child",
      messages: [expect.objectContaining({ role: "user", textParts: ["Inspect the tests"] })],
      toolActivity: [{ tool: "read", status: "completed" }],
      todos: normalizedTodos,
      todoUnavailable: false,
    });
    expect(todo.listTodos).toHaveBeenCalledWith("/repo", "child");
    if (!detail) throw new Error("expected reachable child detail");
    const rendered = renderSubagentDetail(detail);
    expect(rendered).toContain("User: Inspect the tests");
    expect(rendered).toContain("[ ] Review coverage");
  });

  it("derives agent and model from one latest message context", async () => {
    const { inspector, gateway } = fixture();
    gateway.getRecentMessages.mockResolvedValueOnce([
      {
        id: "older",
        sessionId: "child",
        role: "user",
        agent: "older-agent",
        model: { providerID: "provider", modelID: "older-model" },
        textParts: [],
        toolActivity: [],
      },
      {
        id: "newer",
        sessionId: "child",
        role: "assistant",
        model: { providerID: "provider", modelID: "newer-model" },
        textParts: [],
        toolActivity: [],
      },
    ]);

    const result = await inspector.listDescendants(root);

    expect(result.items[0]).toMatchObject({
      model: { providerID: "provider", modelID: "newer-model" },
    });
    expect(result.items[0]).not.toHaveProperty("agent");
  });

  it("keeps child inspection usable when optional TODO retrieval fails", async () => {
    const { inspector } = fixture({ todoFails: true });

    const detail = await inspector.inspectDescendant(root, "child");

    expect(detail).toMatchObject({ id: "child", todoUnavailable: true });
    expect(detail?.messages).toHaveLength(1);
    expect(detail).not.toHaveProperty("todos");
  });

  it("does not inspect an arbitrary session outside the resolved graph", async () => {
    const { inspector, gateway, todo } = fixture();

    const detail = await inspector.inspectDescendant(root, "unrelated");

    expect(detail).toBeUndefined();
    expect(gateway.getSession).not.toHaveBeenCalled();
    expect(todo.listTodos).not.toHaveBeenCalled();
  });

  it("fails closed if current child identity moves outside root authority", async () => {
    const { inspector, gateway } = fixture();
    gateway.getSession.mockResolvedValueOnce({ ...child, directory: "/other" });

    await expect(inspector.inspectDescendant(root, "child")).rejects.toThrow("identity changed");
  });
});
