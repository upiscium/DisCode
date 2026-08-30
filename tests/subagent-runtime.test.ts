import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { SubagentRuntime } from "../src/bridge/subagent-runtime.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import type { SubagentRoot } from "../src/domain/subagent-graph.js";
import { Logger, type LoggerLike } from "../src/logging/logger.js";

const binding: SessionBinding = {
  threadId: "thread",
  parentChannelId: "parent",
  hostId: "host",
  sessionId: "root",
  directory: "/repo",
  title: "Root",
  createdBy: "user",
  createdAt: "now",
};

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: "child",
    parentId: "root",
    parentSessionId: "root",
    rootSessionId: "root",
    title: "Inspect tests",
    status: "busy" as const,
    agent: "explore",
    depth: 1,
    hostId: "host",
    directory: "/repo",
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...child(),
    messages: [],
    toolActivity: [],
    todoUnavailable: false,
    ...overrides,
  };
}

type TestInteraction = ReturnType<typeof makeInteraction>;

function makeInteraction(options: { channelId?: string; childId?: string; focused?: string } = {}) {
  return {
    channelId: options.channelId ?? "thread",
    reply: vi.fn(async (_response: unknown) => undefined),
    deferReply: vi.fn(async (_response: unknown) => undefined),
    editReply: vi.fn(async (_response: unknown) => undefined),
    respond: vi.fn(async (_choices: unknown) => undefined),
    options: {
      getString: vi.fn(() => options.childId ?? "child"),
      getFocused: vi.fn(() => ({ name: "child", value: options.focused ?? "" })),
    },
  };
}

function createRuntime(
  options: {
    initialBinding?: SessionBinding | undefined;
    inspector?: Record<string, unknown>;
    logger?: LoggerLike;
    now?: () => number;
  } = {},
) {
  const initialBinding = Object.hasOwn(options, "initialBinding")
    ? options.initialBinding
    : binding;
  const state = { getByThread: vi.fn((_threadId: string) => initialBinding) };
  const descendants = async () => ({
    items: [child()],
    depthBoundaryReached: false,
    sessionLimitReached: false,
  });
  const inspector = {
    autocompleteDescendants: vi.fn(descendants),
    listDescendants: vi.fn(descendants),
    inspectDescendant: vi.fn(async () => detail()),
    ...options.inspector,
  };
  const logger =
    options.logger ??
    ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies LoggerLike);
  return {
    runtime: new SubagentRuntime({
      state,
      inspector: inspector as never,
      logger,
      ...(options.now ? { now: options.now } : {}),
    }),
    state,
    inspector,
    logger,
  };
}

function expectDeferredOrder(
  interaction: TestInteraction,
  request: ReturnType<typeof vi.fn>,
): void {
  expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
    request.mock.invocationCallOrder[0] ?? 0,
  );
  expect(request.mock.invocationCallOrder[0]).toBeLessThan(
    interaction.editReply.mock.invocationCallOrder[0] ?? 0,
  );
  expect(interaction.reply).not.toHaveBeenCalled();
}

describe("SubagentRuntime list command", () => {
  it("rejects an unbound channel ephemerally without inspection", async () => {
    const { runtime, inspector } = createRuntime({ initialBinding: undefined });
    const interaction = makeInteraction();

    await runtime.handleListCommand(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(inspector.listDescendants).not.toHaveBeenCalled();
  });

  it("rejects a mismatched persisted thread identity", async () => {
    const { runtime, inspector } = createRuntime({
      initialBinding: { ...binding, threadId: "different-thread" },
    });
    const interaction = makeInteraction();

    await runtime.handleListCommand(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(inspector.listDescendants).not.toHaveBeenCalled();
  });

  it("defers before inspection, derives the exact bound root, and renders descendants", async () => {
    const { runtime, inspector } = createRuntime();
    const interaction = makeInteraction();

    await runtime.handleListCommand(interaction as never);

    expect(inspector.listDescendants).toHaveBeenCalledWith({
      hostId: "host",
      directory: "/repo",
      sessionId: "root",
    });
    expectDeferredOrder(interaction, inspector.listDescendants);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Inspect tests"));
    expect(interaction.options.getString).not.toHaveBeenCalled();
  });

  it("renders an explicit empty state", async () => {
    const { runtime } = createRuntime({
      inspector: {
        listDescendants: vi.fn(async () => ({
          items: [],
          depthBoundaryReached: false,
          sessionLimitReached: false,
        })),
      },
    });
    const interaction = makeInteraction();

    await runtime.handleListCommand(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("No current SubAgents"),
    );
  });

  it("does not publish stale output when the binding is removed", async () => {
    const { runtime, state } = createRuntime();
    state.getByThread.mockReturnValueOnce(binding).mockReturnValueOnce(undefined);
    const interaction = makeInteraction();

    await runtime.handleListCommand(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("changed"));
    expect(interaction.editReply).not.toHaveBeenCalledWith(
      expect.stringContaining("Inspect tests"),
    );
  });

  it("does not publish stale output when host, session, and directory are rebound", async () => {
    const rebound = { ...binding, hostId: "other", sessionId: "other-root", directory: "/other" };
    const { runtime, state } = createRuntime();
    state.getByThread.mockReturnValueOnce(binding).mockReturnValueOnce(rebound);
    const interaction = makeInteraction();

    await runtime.handleListCommand(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("changed"));
  });
});

describe("SubagentRuntime detail command", () => {
  it("rejects an unbound channel ephemerally", async () => {
    const { runtime, inspector } = createRuntime({ initialBinding: undefined });
    const interaction = makeInteraction();

    await runtime.handleDetailCommand(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(inspector.inspectDescendant).not.toHaveBeenCalled();
  });

  it("defers before re-authorizing the selector and renders reachable detail", async () => {
    const { runtime, inspector } = createRuntime();
    const interaction = makeInteraction({ childId: "child" });

    await runtime.handleDetailCommand(interaction as never);

    expect(inspector.inspectDescendant).toHaveBeenCalledWith(
      { hostId: "host", directory: "/repo", sessionId: "root" },
      "child",
    );
    expectDeferredOrder(interaction, inspector.inspectDescendant);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Subagent detail"));
  });

  it("rejects an arbitrary or unreachable child selector without fallback", async () => {
    const inspectDescendant = vi.fn(async () => undefined);
    const { runtime } = createRuntime({ inspector: { inspectDescendant } });
    const interaction = makeInteraction({ childId: "manually-supplied-session" });

    await runtime.handleDetailCommand(interaction as never);

    expect(inspectDescendant).toHaveBeenCalledWith(
      { hostId: "host", directory: "/repo", sessionId: "root" },
      "manually-supplied-session",
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("no longer reachable"),
    );
  });

  it("rejects inspector output outside the exact root authority", async () => {
    const { runtime } = createRuntime({
      inspector: { inspectDescendant: vi.fn(async () => detail({ hostId: "foreign" })) },
    });
    const interaction = makeInteraction();

    await runtime.handleDetailCommand(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("no longer reachable"),
    );
  });

  it("keeps optional TODO failure non-fatal", async () => {
    const { runtime } = createRuntime({
      inspector: {
        inspectDescendant: vi.fn(async () => detail({ todoUnavailable: true })),
      },
    });
    const interaction = makeInteraction();

    await runtime.handleDetailCommand(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("TODO unavailable"));
  });

  it("does not publish detail after the root binding is rebound", async () => {
    const { runtime, state } = createRuntime();
    state.getByThread.mockReturnValueOnce(binding).mockReturnValueOnce({
      ...binding,
      hostId: "other",
      sessionId: "other-root",
      directory: "/other",
    });
    const interaction = makeInteraction();

    await runtime.handleDetailCommand(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("changed"));
    expect(interaction.editReply).not.toHaveBeenCalledWith(
      expect.stringContaining("Subagent detail"),
    );
  });
});

describe("SubagentRuntime autocomplete", () => {
  it("returns no choices for an unbound channel", async () => {
    const { runtime, inspector } = createRuntime({ initialBinding: undefined });
    const interaction = makeInteraction();

    await runtime.handleAutocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([]);
    expect(inspector.autocompleteDescendants).not.toHaveBeenCalled();
  });

  it("returns only descendants matching the exact bound host, directory, and root", async () => {
    const items = [
      child(),
      child({ id: "foreign-host", hostId: "other" }),
      child({ id: "foreign-directory", directory: "/other" }),
      child({ id: "foreign-root", rootSessionId: "other-root" }),
    ];
    const { runtime, inspector } = createRuntime({
      inspector: {
        autocompleteDescendants: vi.fn(async () => ({
          items,
          depthBoundaryReached: false,
          sessionLimitReached: false,
        })),
      },
    });
    const interaction = makeInteraction();

    await runtime.handleAutocomplete(interaction as never);

    expect(inspector.autocompleteDescendants).toHaveBeenCalledWith({
      hostId: "host",
      directory: "/repo",
      sessionId: "root",
    });
    expect(interaction.respond).toHaveBeenCalledWith([expect.objectContaining({ value: "child" })]);
  });

  it("bounds choice count and neutralizes labels", async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      child({ id: `child-${index}`, title: `@everyone **child-${index}** ${"x".repeat(100)}` }),
    );
    const { runtime } = createRuntime({
      inspector: {
        autocompleteDescendants: vi.fn(async () => ({
          items,
          depthBoundaryReached: false,
          sessionLimitReached: false,
        })),
      },
    });
    const interaction = makeInteraction();

    await runtime.handleAutocomplete(interaction as never);

    const choices = interaction.respond.mock.calls[0]?.[0] as Array<{
      name: string;
      value: string;
    }>;
    expect(choices).toHaveLength(20);
    for (const choice of choices) {
      expect(choice.name.length).toBeLessThanOrEqual(100);
      expect(choice.name).not.toContain("@everyone");
      expect(choice.name).not.toContain("*");
    }
  });

  it("returns no stale choices after a binding change", async () => {
    const { runtime, state } = createRuntime();
    state.getByThread.mockReturnValueOnce(binding).mockReturnValueOnce({
      ...binding,
      sessionId: "other-root",
    });
    const interaction = makeInteraction();

    await runtime.handleAutocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it("filters current descendant choices by the focused query", async () => {
    const { runtime } = createRuntime({
      inspector: {
        autocompleteDescendants: vi.fn(async () => ({
          items: [child(), child({ id: "review", title: "Review auth", agent: "review" })],
          depthBoundaryReached: false,
          sessionLimitReached: false,
        })),
      },
    });
    const interaction = makeInteraction({ focused: "review" });

    await runtime.handleAutocomplete(interaction as never);

    expect(interaction.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: "review" }),
    ]);
  });

  it("re-authorizes after stale autocomplete before command execution", async () => {
    const inspectDescendant = vi.fn(async () => undefined);
    const { runtime } = createRuntime({ inspector: { inspectDescendant } });
    const autocomplete = makeInteraction();
    await runtime.handleAutocomplete(autocomplete as never);
    expect(autocomplete.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: "child" }),
    ]);

    const command = makeInteraction({ childId: "child" });
    await runtime.handleDetailCommand(command as never);

    expect(inspectDescendant).toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining("no longer reachable"));
  });

  it("coalesces concurrent autocomplete discovery for the same exact root", async () => {
    let release: ((value: ReturnType<typeof child>[]) => void) | undefined;
    const autocompleteDescendants = vi.fn(
      async () =>
        new Promise<{
          items: ReturnType<typeof child>[];
          depthBoundaryReached: boolean;
          sessionLimitReached: boolean;
        }>((resolve) => {
          release = (items) =>
            resolve({ items, depthBoundaryReached: false, sessionLimitReached: false });
        }),
    );
    const { runtime } = createRuntime({ inspector: { autocompleteDescendants } });
    const first = makeInteraction();
    const second = makeInteraction();

    const firstRequest = runtime.handleAutocomplete(first as never);
    const secondRequest = runtime.handleAutocomplete(second as never);
    await vi.waitFor(() => expect(autocompleteDescendants).toHaveBeenCalledTimes(1));
    if (!release) throw new Error("autocomplete test resolver was not installed");
    release([child()]);
    await Promise.all([firstRequest, secondRequest]);

    expect(first.respond).toHaveBeenCalledWith([expect.objectContaining({ value: "child" })]);
    expect(second.respond).toHaveBeenCalledWith([expect.objectContaining({ value: "child" })]);
  });

  it("uses a short cache and refreshes choices after expiry", async () => {
    let now = 1_000;
    const autocompleteDescendants = vi.fn(async () => ({
      items: [child()],
      depthBoundaryReached: false,
      sessionLimitReached: false,
    }));
    const { runtime } = createRuntime({
      inspector: { autocompleteDescendants },
      now: () => now,
    });

    await runtime.handleAutocomplete(makeInteraction() as never);
    await runtime.handleAutocomplete(makeInteraction() as never);
    expect(autocompleteDescendants).toHaveBeenCalledTimes(1);

    now += 1_501;
    await runtime.handleAutocomplete(makeInteraction() as never);
    expect(autocompleteDescendants).toHaveBeenCalledTimes(2);
  });

  it("isolates autocomplete cache entries by exact thread root authority", async () => {
    const secondBinding = {
      ...binding,
      threadId: "thread-2",
      hostId: "host-2",
      sessionId: "root-2",
      directory: "/repo-2",
    };
    const autocompleteDescendants = vi.fn(async (root: SubagentRoot) => ({
      items: [
        child({
          id: `child-${root.sessionId}`,
          hostId: root.hostId,
          directory: root.directory,
          rootSessionId: root.sessionId,
        }),
      ],
      depthBoundaryReached: false,
      sessionLimitReached: false,
    }));
    const { runtime, state } = createRuntime({ inspector: { autocompleteDescendants } });
    state.getByThread.mockImplementation((threadId: string) =>
      threadId === "thread-2" ? secondBinding : binding,
    );

    await runtime.handleAutocomplete(makeInteraction() as never);
    await runtime.handleAutocomplete(makeInteraction({ channelId: "thread-2" }) as never);

    expect(autocompleteDescendants).toHaveBeenCalledTimes(2);
    expect(autocompleteDescendants).toHaveBeenNthCalledWith(1, {
      hostId: "host",
      directory: "/repo",
      sessionId: "root",
    });
    expect(autocompleteDescendants).toHaveBeenNthCalledWith(2, {
      hostId: "host-2",
      directory: "/repo-2",
      sessionId: "root-2",
    });
  });

  it("fails closed instead of evicting pending work when autocomplete capacity is full", async () => {
    const releases: Array<() => void> = [];
    const autocompleteDescendants = vi.fn(
      async () =>
        new Promise<{
          items: ReturnType<typeof child>[];
          depthBoundaryReached: boolean;
          sessionLimitReached: boolean;
        }>((resolve) => {
          releases.push(() =>
            resolve({ items: [], depthBoundaryReached: false, sessionLimitReached: false }),
          );
        }),
    );
    const { runtime, state } = createRuntime({ inspector: { autocompleteDescendants } });
    state.getByThread.mockImplementation((threadId: string) => ({
      ...binding,
      threadId,
      sessionId: `root-${threadId}`,
    }));
    const pending = Array.from({ length: 50 }, (_, index) =>
      runtime.handleAutocomplete(makeInteraction({ channelId: `thread-${index}` }) as never),
    );
    await vi.waitFor(() => expect(autocompleteDescendants).toHaveBeenCalledTimes(50));

    const overflow = makeInteraction({ channelId: "thread-overflow" });
    await runtime.handleAutocomplete(overflow as never);

    expect(autocompleteDescendants).toHaveBeenCalledTimes(50);
    expect(overflow.respond).toHaveBeenCalledWith([]);
    for (const release of releases) release();
    await Promise.all(pending);
  });
});

describe("SubagentRuntime privacy", () => {
  it("keeps transcript, TODO, tool payload, directory, and raw error message out of logs", async () => {
    const secret = "PRIVATE_TRANSCRIPT_TODO_TOOL_PAYLOAD";
    const lines: string[] = [];
    const logger = new Logger({
      level: "debug",
      format: "json",
      write: (line) => lines.push(line),
    });
    const { runtime } = createRuntime({
      logger,
      inspector: {
        listDescendants: vi.fn(async () => {
          throw new Error(`${secret} /repo raw upstream response`);
        }),
      },
    });
    const interaction = makeInteraction();

    await runtime.handleListCommand(interaction as never);

    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain("/repo");
    expect(lines.join("\n")).not.toContain("raw upstream response");
    expect(interaction.editReply).toHaveBeenCalledWith("Unable to inspect subagents right now.");
  });
});
