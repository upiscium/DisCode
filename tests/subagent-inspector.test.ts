import { describe, expect, it, vi } from "vitest";
import { renderSubagentDetail, renderSubagentList } from "../src/discord/subagent.js";
import {
  type NormalizedTranscript,
  normalizeTranscript,
} from "../src/opencode/child-session-gateway.js";
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
      textTruncated: false,
      partsOmitted: 0,
      toolActivityOmitted: 0,
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
        textTruncated: false,
        partsOmitted: 0,
        toolActivityOmitted: 0,
      },
      {
        id: "newer",
        sessionId: "child",
        role: "assistant",
        model: { providerID: "provider", modelID: "newer-model" },
        textParts: [],
        toolActivity: [],
        textTruncated: false,
        partsOmitted: 0,
        toolActivityOmitted: 0,
      },
    ]);

    const result = await inspector.listDescendants(root);

    expect(result.items[0]).toMatchObject({
      model: { providerID: "provider", modelID: "newer-model" },
    });
    expect(result.items[0]).not.toHaveProperty("agent");
  });

  it("keeps the descendant list usable with one long valid child message", async () => {
    const { inspector, gateway } = fixture();
    const longMessage = normalizeTranscript(
      {
        info: {
          id: "long-message",
          sessionID: "child",
          role: "user",
          agent: "explore",
          model: { providerID: "openai", modelID: "gpt-test" },
        },
        parts: Array.from({ length: 45 }, () => ({ type: "text", text: "x".repeat(2_001) })),
      },
      "child",
    );
    if (!longMessage) throw new Error("valid long transcript must normalize");
    gateway.getRecentMessages.mockResolvedValueOnce([longMessage]);

    const result = await inspector.listDescendants(root);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "child", agent: "explore" });
    expect(longMessage).toMatchObject({ textTruncated: true, partsOmitted: 5 });
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

  it("drops descendants when an ancestor detaches before final graph validation", async () => {
    const ancestor = { ...child, id: "ancestor", title: "Ancestor" };
    const nested = { ...child, id: "nested", parentId: "ancestor", title: "Nested" };
    let rootLookups = 0;
    const gateway = {
      listChildren: vi.fn(async (_directory: string, parentId: string) => {
        if (parentId === "root") {
          rootLookups += 1;
          return rootLookups === 1 ? [ancestor] : [{ ...ancestor, directory: "/other" }];
        }
        return parentId === "ancestor" ? [nested] : [];
      }),
      getSession: vi.fn(async (_directory: string, id: string) =>
        id === "ancestor" ? ancestor : nested,
      ),
      getStatus: vi.fn(async () => "busy" as const),
      listStatuses: vi.fn(async () => ({ ancestor: "busy" as const, nested: "busy" as const })),
      getRecentMessages: vi.fn(async (): Promise<NormalizedTranscript[]> => []),
    };
    const inspector = new SubagentInspector({ gatewayFor: () => gateway });

    const result = await inspector.listDescendants(root);

    expect(result.items).toEqual([]);
  });

  it("returns no nested detail when its ancestor detaches after observational reads", async () => {
    const ancestor = { ...child, id: "ancestor", title: "Ancestor" };
    const nested = { ...child, id: "nested", parentId: "ancestor", title: "Nested" };
    let rootLookups = 0;
    const gateway = {
      listChildren: vi.fn(async (_directory: string, parentId: string) => {
        if (parentId === "root") {
          rootLookups += 1;
          return rootLookups === 1 ? [ancestor] : [];
        }
        return parentId === "ancestor" ? [nested] : [];
      }),
      getSession: vi.fn(async () => nested),
      getStatus: vi.fn(async () => "busy" as const),
      listStatuses: vi.fn(async () => ({ nested: "busy" as const })),
      getRecentMessages: vi.fn(async (): Promise<NormalizedTranscript[]> => []),
    };
    const inspector = new SubagentInspector({ gatewayFor: () => gateway });

    await expect(inspector.inspectDescendant(root, "nested")).resolves.toBeUndefined();
  });

  it("returns no detail when the child stays reachable but its lineage changes", async () => {
    const parentA = { ...child, id: "parent-a", title: "Parent A" };
    const parentC = { ...child, id: "parent-c", title: "Parent C" };
    const nested = { ...child, id: "nested", parentId: "parent-a", title: "Nested" };
    let rootLookups = 0;
    let parentALookups = 0;
    let parentCLookups = 0;
    const gateway = {
      listChildren: vi.fn(async (_directory: string, parentId: string) => {
        if (parentId === "root") {
          rootLookups += 1;
          return [parentA, parentC];
        }
        if (parentId === "parent-a") {
          parentALookups += 1;
          return parentALookups === 1 ? [nested] : [];
        }
        if (parentId === "parent-c") {
          parentCLookups += 1;
          return parentCLookups === 1 ? [] : [{ ...nested, parentId: "parent-c" }];
        }
        return [];
      }),
      getSession: vi.fn(async () => nested),
      getStatus: vi.fn(async () => "busy" as const),
      listStatuses: vi.fn(async () => ({ nested: "busy" as const })),
      getRecentMessages: vi.fn(async (): Promise<NormalizedTranscript[]> => []),
    };
    const inspector = new SubagentInspector({ gatewayFor: () => gateway });

    await expect(inspector.inspectDescendant(root, "nested")).resolves.toBeUndefined();
    expect(rootLookups).toBe(2);
  });

  it("returns no detail when a direct child detaches before final graph validation", async () => {
    const { inspector, gateway } = fixture();
    let rootLookups = 0;
    gateway.listChildren.mockImplementation(async (_directory: string, parentId: string) => {
      if (parentId !== "root") return [];
      rootLookups += 1;
      return rootLookups === 1 ? [child] : [];
    });

    await expect(inspector.inspectDescendant(root, "child")).resolves.toBeUndefined();
  });

  it("filters detached list entries while retaining unaffected children", async () => {
    const detached = { ...child, id: "detached", title: "Detached" };
    const stable = { ...child, id: "stable", title: "Stable" };
    let rootLookups = 0;
    const sessions = { detached, stable };
    const gateway = {
      listChildren: vi.fn(async (_directory: string, parentId: string) => {
        if (parentId !== "root") return [];
        rootLookups += 1;
        return rootLookups === 1 ? [detached, stable] : [stable];
      }),
      getSession: vi.fn(async (_directory: string, id: string) => {
        const session = sessions[id as keyof typeof sessions];
        if (!session) throw new Error("unexpected test session");
        return session;
      }),
      getStatus: vi.fn(async () => "busy" as const),
      listStatuses: vi.fn(async () => ({ detached: "busy" as const, stable: "busy" as const })),
      getRecentMessages: vi.fn(async (): Promise<NormalizedTranscript[]> => []),
    };
    const inspector = new SubagentInspector({ gatewayFor: () => gateway });

    const result = await inspector.listDescendants(root);

    expect(result.items.map((item) => item.id)).toEqual(["stable"]);
  });

  it("keeps inspection when the final graph has the same lineage", async () => {
    const { inspector } = fixture();

    const result = await inspector.inspectDescendant(root, "child");

    expect(result).toEqual(
      expect.objectContaining({ id: "child", parentSessionId: "root", depth: 1 }),
    );
  });
});
