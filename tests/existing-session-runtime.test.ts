import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  ExistingSessionAutocompleteCache,
  ExistingSessionRuntime,
} from "../src/bridge/existing-session-runtime.js";
import type { DiscoveredExistingSession } from "../src/opencode/existing-session-discovery.js";

const scope = { hostId: "adam", canonicalDirectory: "/canonical/repo" };

function session(overrides: Partial<DiscoveredExistingSession> = {}): DiscoveredExistingSession {
  return {
    hostId: "adam",
    id: "ses_fab083_abc",
    directory: "/canonical/repo",
    title: "Implement discovery",
    updatedAt: 10,
    status: "idle",
    binding: "unbound",
    ...overrides,
  };
}

function host(id: string, canonicalDirectory = `/${id}/canonical`) {
  return {
    id,
    authorizeDirectory: vi.fn(async (_directory: string) => canonicalDirectory),
  };
}

function registry(entries: Record<string, ReturnType<typeof host>>, defaultHostId = "adam") {
  return {
    has: vi.fn((id: string) => id in entries),
    get: vi.fn((id: string) => {
      const value = entries[id];
      if (!value) throw new Error("missing test host");
      return value;
    }),
    defaultHost: vi.fn(() => {
      const value = entries[defaultHostId];
      if (!value) throw new Error("missing default test host");
      return value;
    }),
  };
}

function interaction(
  options: {
    hostId?: string | null;
    directory?: string | null;
    focusedName?: string;
    query?: string;
  } = {},
) {
  const values: Record<string, string | null> = {
    host: options.hostId ?? null,
    directory: options.directory ?? "/requested/repo",
  };
  return {
    options: {
      getString: vi.fn((name: string) => values[name] ?? null),
      getFocused: vi.fn(() => ({
        name: options.focusedName ?? "session",
        value: options.query ?? "",
      })),
    },
    deferReply: vi.fn(async (_value: unknown) => undefined),
    editReply: vi.fn(async (_value: unknown) => undefined),
    respond: vi.fn(async (_value: unknown) => undefined),
    reply: vi.fn(async (_value: unknown) => undefined),
  };
}

function runtimeFixture(
  options: {
    entries?: Record<string, ReturnType<typeof host>>;
    defaultHostId?: string;
    discover?: (actual: typeof scope) => Promise<DiscoveredExistingSession[]>;
    cache?: ExistingSessionAutocompleteCache;
  } = {},
) {
  const adam = host("adam", "/canonical/repo");
  const entries = options.entries ?? { adam };
  const hosts = registry(entries, options.defaultHostId);
  const discover = vi.fn(options.discover ?? (async () => [session()]));
  return {
    runtime: new ExistingSessionRuntime({
      hosts,
      discovery: { discover },
      ...(options.cache ? { cache: options.cache } : {}),
    }),
    hosts,
    discover,
    entries,
  };
}

describe("ExistingSessionRuntime sessions command", () => {
  it("defers ephemerally before explicit-host authorization and fresh discovery", async () => {
    const order: string[] = [];
    const adam = host("adam", "/canonical/repo");
    adam.authorizeDirectory.mockImplementation(async (directory) => {
      order.push(`authorize:${directory}`);
      return "/canonical/repo";
    });
    const { runtime, discover } = runtimeFixture({
      entries: { adam },
      discover: async (actual) => {
        order.push(`discover:${JSON.stringify(actual)}`);
        return [session()];
      },
    });
    const command = interaction({ hostId: "adam", directory: "/requested/repo" });
    command.deferReply.mockImplementation(async () => void order.push("defer"));

    await runtime.handleSessionsCommand(command as never);

    expect(order).toEqual([
      "defer",
      "authorize:/requested/repo",
      'discover:{"hostId":"adam","canonicalDirectory":"/canonical/repo"}',
    ]);
    expect(command.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(discover).toHaveBeenCalledWith(scope);
    expect(command.editReply).toHaveBeenCalledWith(expect.stringContaining("ses_fab083_abc"));
    expect(command.editReply).not.toHaveBeenCalledWith(expect.stringContaining("/canonical/repo"));
  });

  it("uses the configured default host when host is omitted", async () => {
    const adam = host("adam", "/canonical/repo");
    const { runtime, hosts } = runtimeFixture({ entries: { adam } });

    await runtime.handleSessionsCommand(interaction({ hostId: null }) as never);

    expect(hosts.defaultHost).toHaveBeenCalledTimes(1);
    expect(hosts.get).not.toHaveBeenCalled();
    expect(adam.authorizeDirectory).toHaveBeenCalledWith("/requested/repo");
  });

  it("rejects an unknown explicit host without authorization or discovery", async () => {
    const adam = host("adam");
    const { runtime, discover } = runtimeFixture({ entries: { adam } });
    const command = interaction({ hostId: "missing", directory: "/private/path" });

    await runtime.handleSessionsCommand(command as never);

    expect(adam.authorizeDirectory).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith("Unknown configured OpenCode host.");
    expect(JSON.stringify(command.editReply.mock.calls)).not.toContain("/private/path");
  });

  it("fails closed without echoing an unauthorized directory", async () => {
    const adam = host("adam");
    adam.authorizeDirectory.mockRejectedValueOnce(new Error("denied /private/path"));
    const { runtime, discover } = runtimeFixture({ entries: { adam } });
    const command = interaction({ directory: "/private/path" });

    await runtime.handleSessionsCommand(command as never);

    expect(discover).not.toHaveBeenCalled();
    expect(command.editReply).toHaveBeenCalledWith(
      "Unable to inspect existing sessions right now.",
    );
    expect(JSON.stringify(command.editReply.mock.calls)).not.toContain("/private/path");
  });

  it("uses exact host-scoped discovery and never caches explicit lists", async () => {
    const adam = host("adam", "/adam/repo");
    const eve = host("eve", "/eve/repo");
    const cache = new ExistingSessionAutocompleteCache();
    const cacheGet = vi.spyOn(cache, "getOrDiscover");
    const { runtime, discover } = runtimeFixture({
      entries: { adam, eve },
      cache,
      discover: async (actual) => [
        session({
          hostId: actual.hostId,
          directory: actual.canonicalDirectory,
          id: `ses_${actual.hostId}`,
        }),
      ],
    });
    const first = interaction({ hostId: "eve" });
    const second = interaction({ hostId: "eve" });

    await runtime.handleSessionsCommand(first as never);
    await runtime.handleSessionsCommand(second as never);

    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledWith({ hostId: "eve", canonicalDirectory: "/eve/repo" });
    expect(first.editReply).toHaveBeenCalledWith(expect.stringContaining("ses_eve"));
    expect(first.editReply).not.toHaveBeenCalledWith(expect.stringContaining("ses_adam"));
    expect(cacheGet).not.toHaveBeenCalled();
  });
});

describe("ExistingSessionRuntime bind autocomplete", () => {
  it("routes only a focused session field", async () => {
    const { runtime, discover } = runtimeFixture();
    const other = interaction({ focusedName: "host" });

    await runtime.handleBindAutocomplete(other as never);

    expect(other.respond).toHaveBeenCalledWith([]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("uses default host, canonical scope, query filtering, and exact values", async () => {
    const { runtime, discover, hosts } = runtimeFixture({
      discover: async () => [
        session({ id: "ses_fab083_abc", title: "Alpha" }),
        session({ id: "ses_other", title: "Other" }),
      ],
    });
    const autocomplete = interaction({ query: "fab083" });

    await runtime.handleBindAutocomplete(autocomplete as never);

    expect(hosts.defaultHost).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith(scope);
    expect(autocomplete.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: "ses_fab083_abc" }),
    ]);
  });

  it("uses an explicit configured host and filters ineligible discovery results", async () => {
    const adam = host("adam", "/canonical/repo");
    const eve = host("eve", "/eve/canonical");
    const { runtime, discover } = runtimeFixture({
      entries: { adam, eve },
      discover: async () => [
        session({ hostId: "eve", directory: "/eve/canonical", id: "eligible" }),
        session({ hostId: "eve", directory: "/eve/canonical", id: "bound", binding: "bound" }),
        session({ hostId: "eve", directory: "/eve/canonical", id: "child", parentId: "root" }),
        session({ hostId: "eve", directory: "/eve/canonical", id: "archived", archivedAt: 1 }),
        session({ hostId: "adam", directory: "/eve/canonical", id: "other-host" }),
        session({ hostId: "eve", directory: "/other", id: "other-directory" }),
      ],
    });
    const autocomplete = interaction({ hostId: "eve" });

    await runtime.handleBindAutocomplete(autocomplete as never);

    expect(eve.authorizeDirectory).toHaveBeenCalledWith("/requested/repo");
    expect(adam.authorizeDirectory).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledWith({ hostId: "eve", canonicalDirectory: "/eve/canonical" });
    expect(autocomplete.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: "eligible" }),
    ]);
  });

  it.each([
    ["unknown host", { hostId: "missing" }],
    ["missing directory", { directory: "" }],
  ])("returns no choices for %s", async (_name, options) => {
    const { runtime, discover } = runtimeFixture();
    const autocomplete = interaction(options);

    await runtime.handleBindAutocomplete(autocomplete as never);

    expect(autocomplete.respond).toHaveBeenCalledWith([]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("returns no choices for an unauthorized directory", async () => {
    const adam = host("adam");
    adam.authorizeDirectory.mockRejectedValueOnce(new Error("outside root"));
    const { runtime, discover } = runtimeFixture({ entries: { adam } });
    const autocomplete = interaction({ directory: "/outside" });

    await runtime.handleBindAutocomplete(autocomplete as never);

    expect(autocomplete.respond).toHaveBeenCalledWith([]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("caps responses at 25 choices", async () => {
    const { runtime } = runtimeFixture({
      discover: async () =>
        Array.from({ length: 30 }, (_, index) =>
          session({ id: `ses_${String(index).padStart(2, "0")}` }),
        ),
    });
    const autocomplete = interaction();

    await runtime.handleBindAutocomplete(autocomplete as never);

    expect(autocomplete.respond.mock.calls[0]?.[0]).toHaveLength(25);
  });

  it("returns no choices on failure and retries the next request", async () => {
    const discover = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog failed"))
      .mockResolvedValueOnce([session()]);
    const { runtime } = runtimeFixture({ discover });
    const first = interaction();
    const second = interaction();

    await runtime.handleBindAutocomplete(first as never);
    await runtime.handleBindAutocomplete(second as never);

    expect(first.respond).toHaveBeenCalledWith([]);
    expect(second.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: "ses_fab083_abc" }),
    ]);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});

describe("ExistingSessionAutocompleteCache", () => {
  it("reuses an exact scope within TTL and refreshes at expiry", async () => {
    let now = 0;
    const cache = new ExistingSessionAutocompleteCache({ ttlMs: 10, now: () => now });
    const discover = vi.fn(async () => [session()]);

    await cache.getOrDiscover(scope, discover);
    await cache.getOrDiscover(scope, discover);
    expect(discover).toHaveBeenCalledTimes(1);

    now = 10;
    await cache.getOrDiscover(scope, discover);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent identical discovery", async () => {
    let release: ((items: DiscoveredExistingSession[]) => void) | undefined;
    const pending = new Promise<DiscoveredExistingSession[]>((resolve) => {
      release = resolve;
    });
    const cache = new ExistingSessionAutocompleteCache();
    const discover = vi.fn(async () => pending);

    const first = cache.getOrDiscover(scope, discover);
    const second = cache.getOrDiscover(scope, discover);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    release?.([session()]);

    await expect(first).resolves.toEqual([session()]);
    await expect(second).resolves.toEqual([session()]);
  });

  it("isolates host and canonical-directory keys", async () => {
    const cache = new ExistingSessionAutocompleteCache();
    const discover = vi.fn(async () => [session()]);

    await cache.getOrDiscover(scope, discover);
    await cache.getOrDiscover({ ...scope, hostId: "eve" }, discover);
    await cache.getOrDiscover({ ...scope, canonicalDirectory: "/other" }, discover);

    expect(discover).toHaveBeenCalledTimes(3);
  });

  it("invalidates only the exact host and canonical-directory scope", async () => {
    const cache = new ExistingSessionAutocompleteCache();
    const discover = vi.fn(async () => [session()]);
    const other = { hostId: "eve", canonicalDirectory: "/canonical/repo" };

    await cache.getOrDiscover(scope, discover);
    await cache.getOrDiscover(other, discover);
    cache.invalidate(scope);
    await cache.getOrDiscover(scope, discover);
    await cache.getOrDiscover(other, discover);

    expect(discover).toHaveBeenCalledTimes(3);
  });

  it("does not retain failures and allows retry", async () => {
    const cache = new ExistingSessionAutocompleteCache();
    const discover = vi
      .fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce([session()]);

    await expect(cache.getOrDiscover(scope, discover)).rejects.toThrow("failed");
    await expect(cache.getOrDiscover(scope, discover)).resolves.toEqual([session()]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("bounds successful entries with deterministic FIFO eviction", async () => {
    const cache = new ExistingSessionAutocompleteCache({ maxEntries: 2 });
    const discover = vi.fn(async () => [session()]);
    const one = { hostId: "adam", canonicalDirectory: "/one" };
    const two = { hostId: "adam", canonicalDirectory: "/two" };
    const three = { hostId: "adam", canonicalDirectory: "/three" };

    await cache.getOrDiscover(one, discover);
    await cache.getOrDiscover(two, discover);
    await cache.getOrDiscover(three, discover);
    await cache.getOrDiscover(one, discover);

    expect(discover).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid cache limits", () => {
    expect(() => new ExistingSessionAutocompleteCache({ ttlMs: 0 })).toThrow("ttlMs");
    expect(() => new ExistingSessionAutocompleteCache({ maxEntries: 0 })).toThrow("maxEntries");
  });
});
