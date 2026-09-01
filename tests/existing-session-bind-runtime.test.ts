import { ChannelType, MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { ExistingSessionBindRuntime } from "../src/bridge/existing-session-bind-runtime.js";
import {
  executeCloseMutation,
  executeUnbindMutation,
  runCurrentManagedLifecycleMutation,
  SessionLifecycleSerializer,
} from "../src/bridge/session-lifecycle.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import type { ExistingSession } from "../src/opencode/existing-session-gateway.js";

const CREATED_AT = "2026-09-01T00:00:00.000Z";

function session(overrides: Partial<ExistingSession> = {}): ExistingSession {
  return {
    hostId: "adam",
    id: "ses_fab083_abc",
    directory: "/canonical/repo",
    title: "Existing title",
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function interaction(
  options: { hostId?: string | null; directory?: string; sessionId?: string; userId?: string } = {},
) {
  const values: Record<string, string | null> = {
    host: options.hostId ?? null,
    directory: options.directory ?? "/requested/repo",
    session: options.sessionId ?? "ses_fab083_abc",
  };
  return {
    user: { id: options.userId ?? "user-1" },
    options: { getString: vi.fn((name: string) => values[name] ?? null) },
    deferReply: vi.fn(async (_options: unknown) => undefined),
    editReply: vi.fn(async (_content: unknown) => undefined),
  };
}

function host(
  id = "adam",
  canonicalDirectory = "/canonical/repo",
  current: ExistingSession = session({ hostId: id, directory: canonicalDirectory }),
) {
  return {
    id,
    authorizeDirectory: vi.fn(async (_directory: string) => canonicalDirectory),
    existingSessions: {
      getSession: vi.fn(async (_directory: string, _sessionId: string) => ({ ...current })),
      deleteSession: vi.fn(async () => undefined),
    },
  };
}

function stateFixture() {
  const bindings: SessionBinding[] = [];
  return {
    bindings,
    getBySession: vi.fn((hostId: string, sessionId: string) =>
      bindings.find((item) => item.hostId === hostId && item.sessionId === sessionId),
    ),
    claimBindingIfSessionUnbound: vi.fn(async (binding: SessionBinding) => {
      if (
        bindings.some(
          (item) =>
            (item.hostId === binding.hostId && item.sessionId === binding.sessionId) ||
            item.threadId === binding.threadId,
        )
      ) {
        return false;
      }
      bindings.push({ ...binding });
      return true;
    }),
    removeBindingIfMatches: vi.fn(async (threadId: string, hostId: string, sessionId: string) => {
      const index = bindings.findIndex(
        (item) =>
          item.threadId === threadId && item.hostId === hostId && item.sessionId === sessionId,
      );
      if (index < 0) return false;
      bindings.splice(index, 1);
      return true;
    }),
  };
}

function existingBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    threadId: "existing-thread",
    parentChannelId: "parent-1",
    hostId: "adam",
    sessionId: "ses_fab083_abc",
    directory: "/canonical/repo",
    title: "Existing title",
    createdBy: "other-user",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function fixture(
  options: {
    hosts?: ReturnType<typeof host>[];
    state?: ReturnType<typeof stateFixture>;
    order?: string[];
  } = {},
) {
  const order = options.order ?? [];
  const configuredHosts = options.hosts ?? [host()];
  const hostsById = new Map(configuredHosts.map((item) => [item.id, item]));
  const state = options.state ?? stateFixture();
  const threads: Array<{ id: string; delete: ReturnType<typeof vi.fn> }> = [];
  const createThread = vi.fn(async (_createOptions: unknown) => {
    order.push("create-thread");
    const thread = {
      id: `thread-${threads.length + 1}`,
      delete: vi.fn(async () => {
        order.push("delete-thread");
      }),
    };
    threads.push(thread);
    return thread;
  });
  const fetchChannel = vi.fn(async (_id: string) => {
    order.push("fetch-parent");
    return {
      id: "parent-1",
      type: ChannelType.GuildText,
      threads: { create: createThread },
    };
  });
  const headers = {
    createInitialHeader: vi.fn(async (_binding: SessionBinding, _thread: unknown) => {
      order.push("initial-header");
    }),
    refreshSession: vi.fn(async (_hostId: string, _sessionId: string) => {
      order.push("actual-header");
    }),
  };
  const todos = {
    refreshInitial: vi.fn(async (_binding: SessionBinding) => {
      order.push("todo");
    }),
    runBindingMutation: async <T>(_threadId: string, operation: () => Promise<T>) => operation(),
  };
  const subagents = {
    refreshInitial: vi.fn(async (_binding: SessionBinding) => {
      order.push("subagent");
    }),
    runBindingMutation: async <T>(_threadId: string, operation: () => Promise<T>) => operation(),
    forgetBinding: vi.fn((_binding: SessionBinding) => undefined),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const invalidate = vi.fn((_scope: unknown) => undefined);
  const lifecycle = new SessionLifecycleSerializer();
  const runtime = new ExistingSessionBindRuntime({
    hosts: {
      has: (id) => hostsById.has(id),
      get: (id) => {
        const selected = hostsById.get(id);
        if (!selected) throw new Error("missing test host");
        return selected;
      },
      defaultHost: () => {
        const selected = configuredHosts[0];
        if (!selected) throw new Error("missing default test host");
        return selected;
      },
    },
    state,
    discord: { channels: { fetch: fetchChannel } },
    config: { discordParentChannelId: "parent-1" },
    headers,
    todos,
    subagents,
    logger,
    invalidate,
    lifecycle,
    now: () => new Date(CREATED_AT),
  });
  return {
    runtime,
    state,
    order,
    hosts: configuredHosts,
    threads,
    createThread,
    fetchChannel,
    headers,
    todos,
    subagents,
    logger,
    invalidate,
    lifecycle,
  };
}

describe("ExistingSessionBindRuntime authority", () => {
  it("defers ephemerally before directory, OpenCode, or Discord I/O", async () => {
    const order: string[] = [];
    const adam = host();
    adam.authorizeDirectory.mockImplementation(async () => {
      order.push("authorize");
      return "/canonical/repo";
    });
    adam.existingSessions.getSession.mockImplementation(async () => {
      order.push("get-session");
      return session();
    });
    const item = fixture({ hosts: [adam], order });
    const command = interaction();
    command.deferReply.mockImplementation(async () => void order.push("defer"));

    await item.runtime.handleCommand(command as never);

    expect(order.slice(0, 4)).toEqual(["defer", "authorize", "get-session", "fetch-parent"]);
    expect(command.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it("uses the configured default host when host is omitted", async () => {
    const adam = host();
    const item = fixture({ hosts: [adam] });

    await item.runtime.handleCommand(interaction({ hostId: null }) as never);

    expect(adam.authorizeDirectory).toHaveBeenCalledWith("/requested/repo");
    expect(adam.existingSessions.getSession).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown explicit host before authorization or OpenCode access", async () => {
    const adam = host();
    const item = fixture({ hosts: [adam] });
    const command = interaction({ hostId: "missing" });

    await item.runtime.handleCommand(command as never);

    expect(adam.authorizeDirectory).not.toHaveBeenCalled();
    expect(adam.existingSessions.getSession).not.toHaveBeenCalled();
    expect(item.fetchChannel).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith("Unknown configured OpenCode host.");
  });

  it("authorizes the requested directory before an exact fresh selector read", async () => {
    const adam = host();
    const item = fixture({ hosts: [adam] });

    await item.runtime.handleCommand(
      interaction({ directory: "/lexical/repo", sessionId: "ses_fab083_abc" }) as never,
    );

    expect(adam.authorizeDirectory).toHaveBeenCalledWith("/lexical/repo");
    expect(adam.existingSessions.getSession).toHaveBeenNthCalledWith(
      1,
      "/canonical/repo",
      "ses_fab083_abc",
    );
    expect(adam.existingSessions.getSession).toHaveBeenNthCalledWith(
      2,
      "/canonical/repo",
      "ses_fab083_abc",
    );
  });

  it.each([
    ["selector mismatch", session({ id: "different" })],
    ["host mismatch", session({ hostId: "eve" })],
    ["directory mismatch", session({ directory: "/other" })],
    ["child", session({ parentId: "parent" })],
    ["archived", session({ archivedAt: 1 })],
  ])("rejects an ineligible first read: %s", async (_name, current) => {
    const adam = host("adam", "/canonical/repo", current);
    const item = fixture({ hosts: [adam] });
    const command = interaction();

    await item.runtime.handleCommand(command as never);

    expect(item.createThread).not.toHaveBeenCalled();
    expect(item.state.claimBindingIfSessionUnbound).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith(
      "That OpenCode session is not eligible for binding.",
    );
  });

  it("does not expose unauthorized directory or OpenCode errors", async () => {
    const adam = host();
    adam.authorizeDirectory.mockRejectedValueOnce(new Error("denied /private/secret"));
    const item = fixture({ hosts: [adam] });
    const command = interaction({ directory: "/private/secret" });

    await item.runtime.handleCommand(command as never);

    expect(command.editReply).toHaveBeenCalledWith(
      "Unable to bind that OpenCode session right now.",
    );
    expect(JSON.stringify(command.editReply.mock.calls)).not.toContain("/private/secret");
  });

  it("rejects an already-bound session before Discord thread creation", async () => {
    const state = stateFixture();
    state.bindings.push(existingBinding());
    const item = fixture({ state });
    const command = interaction();

    await item.runtime.handleCommand(command as never);

    expect(item.fetchChannel).not.toHaveBeenCalled();
    expect(item.createThread).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith("That OpenCode session is already bound.");
  });
});

describe("ExistingSessionBindRuntime post-I/O revalidation", () => {
  it("performs the second fresh read only after thread creation", async () => {
    const order: string[] = [];
    const adam = host();
    adam.existingSessions.getSession.mockImplementation(async () => {
      order.push("get-session");
      return session();
    });
    const item = fixture({ hosts: [adam], order });

    await item.runtime.handleCommand(interaction() as never);

    expect(order).toEqual([
      "get-session",
      "fetch-parent",
      "create-thread",
      "get-session",
      "initial-header",
      "todo",
      "subagent",
      "actual-header",
    ]);
  });

  it("accepts observational title/model/agent changes between reads", async () => {
    const adam = host();
    adam.existingSessions.getSession
      .mockResolvedValueOnce(
        session({
          title: "Before",
          model: { providerID: "openai", modelID: "old" },
          agent: "old-agent",
        }),
      )
      .mockResolvedValueOnce(
        session({
          title: "After",
          model: { providerID: "openai", modelID: "new" },
          agent: "new-agent",
        }),
      );
    const item = fixture({ hosts: [adam] });

    await item.runtime.handleCommand(interaction() as never);

    expect(item.createThread).toHaveBeenCalledWith(expect.objectContaining({ name: "Before" }));
    expect(item.state.bindings[0]).toMatchObject({ title: "After" });
    expect(item.state.bindings[0]).not.toHaveProperty("model");
    expect(item.state.bindings[0]).not.toHaveProperty("agent");
  });

  it.each([
    ["deletion", new Error("deleted")],
    ["directory change", session({ directory: "/moved" })],
    ["reparent", session({ parentId: "parent" })],
    ["archive", session({ archivedAt: 1 })],
  ])("rolls back when the second read observes %s", async (_name, second) => {
    const adam = host();
    if (second instanceof Error) {
      adam.existingSessions.getSession
        .mockResolvedValueOnce(session())
        .mockRejectedValueOnce(second);
    } else {
      adam.existingSessions.getSession
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(second);
    }
    const item = fixture({ hosts: [adam] });

    await item.runtime.handleCommand(interaction() as never);

    expect(item.threads).toHaveLength(1);
    expect(item.threads[0]?.delete).toHaveBeenCalledTimes(1);
    expect(item.state.bindings).toHaveLength(0);
    expect(item.state.claimBindingIfSessionUnbound).not.toHaveBeenCalled();
  });

  it("rolls back when another binding appears during thread creation", async () => {
    const state = stateFixture();
    const adam = host();
    adam.existingSessions.getSession.mockImplementation(async () => {
      if (adam.existingSessions.getSession.mock.calls.length === 2) {
        state.bindings.push(existingBinding());
      }
      return session();
    });
    const item = fixture({ hosts: [adam], state });
    const command = interaction();

    await item.runtime.handleCommand(command as never);

    expect(item.threads[0]?.delete).toHaveBeenCalledTimes(1);
    expect(state.bindings).toEqual([existingBinding()]);
    expect(command.editReply).toHaveBeenCalledWith("That OpenCode session is already bound.");
  });

  it("rolls back a guarded-claim race loss", async () => {
    const state = stateFixture();
    state.claimBindingIfSessionUnbound.mockResolvedValueOnce(false);
    const item = fixture({ state });
    const command = interaction();

    await item.runtime.handleCommand(command as never);

    expect(item.threads[0]?.delete).toHaveBeenCalledTimes(1);
    expect(state.bindings).toHaveLength(0);
    expect(command.editReply).toHaveBeenCalledWith("That OpenCode session is already bound.");
  });

  it("deletes the thread when guarded claim persistence throws", async () => {
    const state = stateFixture();
    state.claimBindingIfSessionUnbound.mockRejectedValueOnce(new Error("persist failed"));
    const item = fixture({ state });

    await item.runtime.handleCommand(interaction() as never);

    expect(item.threads[0]?.delete).toHaveBeenCalledTimes(1);
    expect(item.state.bindings).toHaveLength(0);
    expect(item.headers.createInitialHeader).not.toHaveBeenCalled();
  });
});

describe("ExistingSessionBindRuntime commit and rollback", () => {
  it("persists the exact minimal binding and initializes managed surfaces", async () => {
    const item = fixture();
    const command = interaction({ userId: "creator" });

    await item.runtime.handleCommand(command as never);

    expect(item.state.bindings).toEqual([
      {
        threadId: "thread-1",
        parentChannelId: "parent-1",
        hostId: "adam",
        sessionId: "ses_fab083_abc",
        directory: "/canonical/repo",
        title: "Existing title",
        createdBy: "creator",
        createdAt: CREATED_AT,
      },
    ]);
    expect(item.state.bindings[0]).not.toHaveProperty("model");
    expect(item.state.bindings[0]).not.toHaveProperty("agent");
    expect(item.order.slice(-4)).toEqual(["initial-header", "todo", "subagent", "actual-header"]);
    expect(item.state.claimBindingIfSessionUnbound.mock.invocationCallOrder[0]).toBeLessThan(
      item.headers.createInitialHeader.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(item.headers.createInitialHeader).toHaveBeenCalledWith(
      item.state.bindings[0],
      item.threads[0],
    );
    expect(item.headers.refreshSession).toHaveBeenCalledWith("adam", "ses_fab083_abc");
    expect(item.todos.refreshInitial).toHaveBeenCalledTimes(1);
    expect(item.subagents.refreshInitial).toHaveBeenCalledTimes(1);
  });

  it("uses the existing title for the thread and binding, with a fallback", async () => {
    const titled = fixture();
    await titled.runtime.handleCommand(interaction() as never);
    expect(titled.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Existing title" }),
    );

    const adam = host("adam", "/canonical/repo", session({ title: "  " }));
    const fallback = fixture({ hosts: [adam] });
    await fallback.runtime.handleCommand(interaction() as never);
    expect(fallback.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ name: "OpenCode session" }),
    );
    expect(fallback.state.bindings[0]?.title).toBe("OpenCode session");
  });

  it("invalidates only the exact autocomplete scope after success", async () => {
    const item = fixture();

    await item.runtime.handleCommand(interaction() as never);

    expect(item.invalidate).toHaveBeenCalledWith({
      hostId: "adam",
      canonicalDirectory: "/canonical/repo",
    });
  });

  it("emits safe session.bound logging and a canonical success response", async () => {
    const adam = host(
      "host_one",
      "/private/credential-path",
      session({
        hostId: "host_one",
        id: "ses_under-score-1",
        directory: "/private/credential-path",
        title: "secret content",
      }),
    );
    const item = fixture({ hosts: [adam] });
    const command = interaction({ sessionId: "ses_under-score-1" });

    await item.runtime.handleCommand(command as never);

    expect(command.editReply).toHaveBeenCalledWith(
      "Bound <#thread-1> to OpenCode host `host_one`, session `ses_under-score-1`.",
    );
    expect(item.logger.info).toHaveBeenCalledWith(
      "session.bound",
      "Existing OpenCode session bound",
      { host_id: "host_one", session_id: "ses_under-score-1", thread_id: "thread-1" },
    );
    const logData = JSON.stringify(item.logger.info.mock.calls);
    expect(logData).not.toContain("/private/credential-path");
    expect(logData).not.toContain("secret content");
    expect(logData).not.toContain("user-1");
  });

  it("does not roll back a committed binding when the success response fails", async () => {
    const item = fixture();
    const command = interaction();
    command.editReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    await item.runtime.handleCommand(command as never);

    expect(item.state.bindings).toHaveLength(1);
    expect(item.threads[0]?.delete).not.toHaveBeenCalled();
    expect(item.logger.warn).toHaveBeenCalledWith(
      "discord.bind_reply_failed",
      expect.any(String),
      expect.objectContaining({ session_id: "ses_fab083_abc" }),
      expect.any(Error),
    );
  });

  it("removes the claim, forgets indexes, and deletes the thread after critical header failure", async () => {
    const item = fixture();
    item.headers.createInitialHeader.mockRejectedValueOnce(new Error("header failed"));

    await item.runtime.handleCommand(interaction() as never);

    expect(item.state.removeBindingIfMatches).toHaveBeenCalledWith(
      "thread-1",
      "adam",
      "ses_fab083_abc",
    );
    expect(item.state.bindings).toHaveLength(0);
    expect(item.subagents.forgetBinding).toHaveBeenCalledTimes(1);
    expect(item.threads[0]?.delete).toHaveBeenCalledTimes(1);
    expect(item.hosts[0]?.existingSessions.deleteSession).not.toHaveBeenCalled();
  });

  it("rolls back if actual header history refresh fails", async () => {
    const item = fixture();
    item.headers.refreshSession.mockRejectedValueOnce(new Error("history unavailable"));

    await item.runtime.handleCommand(interaction() as never);

    expect(item.state.bindings).toHaveLength(0);
    expect(item.threads[0]?.delete).toHaveBeenCalledTimes(1);
    expect(item.hosts[0]?.existingSessions.deleteSession).not.toHaveBeenCalled();
  });

  it("retains a claimed thread if guarded state rollback persistence fails", async () => {
    const item = fixture();
    item.headers.createInitialHeader.mockRejectedValueOnce(new Error("header failed"));
    item.state.removeBindingIfMatches.mockRejectedValueOnce(new Error("persist failed"));

    await item.runtime.handleCommand(interaction() as never);

    expect(item.state.bindings).toHaveLength(1);
    expect(item.subagents.forgetBinding).not.toHaveBeenCalled();
    expect(item.threads[0]?.delete).not.toHaveBeenCalled();
    expect(item.logger.error).toHaveBeenCalledWith(
      "session.rollback_failed",
      expect.any(String),
      expect.objectContaining({ rollback_stage: "state" }),
      expect.any(Error),
    );
  });

  it("logs bounded safe identifiers when thread rollback fails", async () => {
    const item = fixture();
    item.state.claimBindingIfSessionUnbound.mockResolvedValueOnce(false);
    item.createThread.mockImplementationOnce(async () => {
      const thread = {
        id: `${"t".repeat(300)}\n/private`,
        delete: vi.fn(async () => {
          throw new Error("delete failed /private");
        }),
      };
      item.threads.push(thread);
      return thread;
    });

    await item.runtime.handleCommand(interaction() as never);

    expect(item.logger.error).toHaveBeenCalledWith(
      "session.rollback_failed",
      "Failed to delete binding thread",
      expect.objectContaining({ rollback_stage: "discord_thread" }),
      expect.any(Error),
    );
    const fields = item.logger.error.mock.calls[0]?.[2] as Record<string, string>;
    expect(fields.thread_id).toBeDefined();
    expect(fields.thread_id?.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(fields)).not.toContain("/private");
  });
});

describe("ExistingSessionBindRuntime session-key serialization", () => {
  it("allows exactly one concurrent bind for the same host/session", async () => {
    const item = fixture();
    const first = interaction();
    const second = interaction();

    await Promise.all([
      item.runtime.handleCommand(first as never),
      item.runtime.handleCommand(second as never),
    ]);

    expect(item.hosts[0]?.existingSessions.getSession).toHaveBeenCalledTimes(3);
    expect(item.createThread).toHaveBeenCalledTimes(1);
    expect(item.state.claimBindingIfSessionUnbound).toHaveBeenCalledTimes(1);
    expect(item.state.bindings).toHaveLength(1);
    expect(first.editReply.mock.calls.flat().concat(second.editReply.mock.calls.flat())).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Bound <#thread-1>"),
        "That OpenCode session is already bound.",
      ]),
    );
  });

  it("does not share a lock for the same session ID on different hosts", async () => {
    const gate = deferred();
    const adam = host("adam", "/adam", session({ directory: "/adam" }));
    const eve = host("eve", "/eve", session({ hostId: "eve", directory: "/eve" }));
    const item = fixture({ hosts: [adam, eve] });
    item.createThread.mockImplementation(async () => {
      const thread = {
        id: `thread-${item.threads.length + 1}`,
        delete: vi.fn(async () => undefined),
      };
      item.threads.push(thread);
      await gate.promise;
      return thread;
    });
    const first = item.runtime.handleCommand(interaction({ hostId: "adam" }) as never);
    const second = item.runtime.handleCommand(interaction({ hostId: "eve" }) as never);

    await vi.waitFor(() => expect(item.createThread).toHaveBeenCalledTimes(2));
    gate.resolve();
    await Promise.all([first, second]);

    expect(item.state.bindings).toHaveLength(2);
    expect(item.state.bindings.map((binding) => binding.hostId).sort()).toEqual(["adam", "eve"]);
  });

  it("does not serialize different sessions on the same host", async () => {
    const gate = deferred();
    const adam = host();
    adam.existingSessions.getSession.mockImplementation(async (directory, id) =>
      session({ id, directory }),
    );
    const item = fixture({ hosts: [adam] });
    item.createThread.mockImplementation(async () => {
      const thread = {
        id: `thread-${item.threads.length + 1}`,
        delete: vi.fn(async () => undefined),
      };
      item.threads.push(thread);
      await gate.promise;
      return thread;
    });
    const first = item.runtime.handleCommand(interaction({ sessionId: "session-one" }) as never);
    const second = item.runtime.handleCommand(interaction({ sessionId: "session-two" }) as never);

    await vi.waitFor(() => expect(item.createThread).toHaveBeenCalledTimes(2));
    gate.resolve();
    await Promise.all([first, second]);

    expect(item.state.bindings.map((binding) => binding.sessionId).sort()).toEqual([
      "session-one",
      "session-two",
    ]);
  });

  it("cleans a failed session lock so a later bind can retry", async () => {
    const item = fixture();
    item.headers.createInitialHeader.mockRejectedValueOnce(new Error("first failed"));

    await item.runtime.handleCommand(interaction() as never);
    await item.runtime.handleCommand(interaction() as never);

    expect(item.createThread).toHaveBeenCalledTimes(2);
    expect(item.state.bindings).toHaveLength(1);
  });
});

describe("ExistingSessionBindRuntime shared lifecycle serialization", () => {
  it("holds unbind behind managed initialization after the claim", async () => {
    const gate = deferred();
    const item = fixture();
    item.headers.createInitialHeader.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const command = interaction();
    const bind = item.runtime.handleCommand(command as never);
    await vi.waitFor(() => expect(item.state.bindings).toHaveLength(1));
    await vi.waitFor(() => expect(item.headers.createInitialHeader).toHaveBeenCalledTimes(1));
    const binding = item.state.bindings[0] as SessionBinding;
    const unbindMutation = vi.fn(async () => {
      await executeUnbindMutation({
        removeBinding: async () => {
          await item.state.removeBindingIfMatches("thread-1", "adam", "ses_fab083_abc");
        },
      });
    });
    const unbind = runCurrentManagedLifecycleMutation({
      binding,
      currentBinding: (threadId) =>
        item.state.bindings.find((candidate) => candidate.threadId === threadId),
      lifecycle: item.lifecycle,
      todos: item.todos,
      subagents: item.subagents,
      operation: unbindMutation,
    });

    await Promise.resolve();
    expect(unbindMutation).not.toHaveBeenCalled();
    expect(item.state.bindings).toHaveLength(1);

    gate.resolve();
    await bind;
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining("Bound <#thread-1>"));
    await unbind;
    expect(unbindMutation).toHaveBeenCalledTimes(1);
    expect(item.state.bindings).toHaveLength(0);
  });

  it("holds close behind managed initialization after the claim", async () => {
    const gate = deferred();
    const item = fixture();
    item.headers.createInitialHeader.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const bind = item.runtime.handleCommand(interaction() as never);
    await vi.waitFor(() => expect(item.state.bindings).toHaveLength(1));
    await vi.waitFor(() => expect(item.headers.createInitialHeader).toHaveBeenCalledTimes(1));
    const binding = item.state.bindings[0] as SessionBinding;
    const deleteSession = vi.fn(async () => undefined);
    const closeMutation = vi.fn(async () => {
      await executeCloseMutation({
        deleteSession,
        removeBinding: async () => {
          await item.state.removeBindingIfMatches("thread-1", "adam", "ses_fab083_abc");
        },
      });
    });
    const close = runCurrentManagedLifecycleMutation({
      binding,
      currentBinding: (threadId) =>
        item.state.bindings.find((candidate) => candidate.threadId === threadId),
      lifecycle: item.lifecycle,
      todos: item.todos,
      subagents: item.subagents,
      operation: closeMutation,
    });

    await Promise.resolve();
    expect(closeMutation).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();

    gate.resolve();
    await bind;
    await close;
    expect(closeMutation).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(item.state.bindings).toHaveLength(0);
  });

  it("releases the lifecycle lock after failed bind rollback", async () => {
    const gate = deferred();
    const item = fixture();
    item.headers.createInitialHeader.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error("initialization failed");
    });
    const bind = item.runtime.handleCommand(interaction() as never);
    await vi.waitFor(() => expect(item.state.bindings).toHaveLength(1));
    await vi.waitFor(() => expect(item.headers.createInitialHeader).toHaveBeenCalledTimes(1));
    const binding = item.state.bindings[0] as SessionBinding;
    const laterMutation = vi.fn(async () => undefined);
    const later = runCurrentManagedLifecycleMutation({
      binding,
      currentBinding: (threadId) =>
        item.state.bindings.find((candidate) => candidate.threadId === threadId),
      lifecycle: item.lifecycle,
      todos: item.todos,
      subagents: item.subagents,
      operation: laterMutation,
    });

    await Promise.resolve();
    expect(laterMutation).not.toHaveBeenCalled();

    gate.resolve();
    await bind;
    await expect(later).resolves.toEqual({ current: false });
    expect(item.state.bindings).toHaveLength(0);
    expect(item.threads[0]?.delete).toHaveBeenCalledTimes(1);
    expect(laterMutation).not.toHaveBeenCalled();
  });
});
