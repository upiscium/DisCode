import { describe, expect, it, vi } from "vitest";
import type { NormalizedSessionStatuses } from "../src/opencode/child-session-gateway.js";
import {
  ExistingSessionDiscovery,
  isEligibleExistingSession,
} from "../src/opencode/existing-session-discovery.js";
import type { ExistingSession } from "../src/opencode/existing-session-gateway.js";
import type { StateStore } from "../src/state/state-store.js";

const scope = { hostId: "host-a", canonicalDirectory: "/work/project" };

function session(overrides: Partial<ExistingSession> = {}): ExistingSession {
  return {
    hostId: "host-a",
    id: "session",
    directory: "/work/project",
    ...overrides,
  };
}

function binding(
  sessionId: string,
  hostId: string,
): NonNullable<ReturnType<StateStore["getBySession"]>> {
  return {
    threadId: "thread",
    parentChannelId: "channel",
    hostId,
    sessionId,
    directory: "/work/project",
    title: "Session",
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("isEligibleExistingSession", () => {
  it.each([
    ["different host", { hostId: "host-b" }],
    ["different directory", { directory: "/work/other" }],
    ["child session", { parentId: "parent" }],
    ["archived session", { archivedAt: 123 }],
  ])("rejects %s", (_, overrides) => {
    expect(isEligibleExistingSession(session(overrides), scope)).toBe(false);
  });

  it("accepts only an exact, unarchived root session", () => {
    expect(isEligibleExistingSession(session(), scope)).toBe(true);
  });
});

describe("ExistingSessionDiscovery", () => {
  it("discovers eligible sessions with statuses, exact bindings, and deterministic order", async () => {
    const gateway = {
      listSessions: vi
        .fn()
        .mockResolvedValue([
          session({ id: "no-time" }),
          session({ id: "old", updatedAt: 10 }),
          session({ id: "new", updatedAt: 20 }),
          session({ id: "same-b", updatedAt: 20 }),
          session({ id: "same-a", updatedAt: 20 }),
          session({ id: "child", parentId: "root" }),
        ]),
      listStatuses: vi.fn().mockResolvedValue({
        new: "busy",
        "same-a": "retry",
        "same-b": "unknown",
      } satisfies NormalizedSessionStatuses),
    };
    const state = {
      getBySession: vi.fn<StateStore["getBySession"]>((hostId, id) =>
        hostId === "host-a" && id === "new" ? binding(id, hostId) : undefined,
      ),
    };
    const discovery = new ExistingSessionDiscovery(() => gateway, state);

    await expect(discovery.discover(scope)).resolves.toEqual([
      { ...session({ id: "new", updatedAt: 20 }), status: "busy", binding: "bound" },
      { ...session({ id: "same-a", updatedAt: 20 }), status: "retry", binding: "unbound" },
      { ...session({ id: "same-b", updatedAt: 20 }), status: "unknown", binding: "unbound" },
      { ...session({ id: "old", updatedAt: 10 }), status: "idle", binding: "unbound" },
      { ...session({ id: "no-time" }), status: "idle", binding: "unbound" },
    ]);
    expect(gateway.listSessions).toHaveBeenCalledWith("/work/project");
    expect(gateway.listStatuses).toHaveBeenCalledWith("/work/project");
  });

  it("preserves host isolation and uses exact binding identity", async () => {
    const gateway = {
      listSessions: vi.fn().mockResolvedValue([session({ hostId: "host-b", id: "same-id" })]),
      listStatuses: vi.fn().mockResolvedValue({}),
    };
    const state = {
      getBySession: vi.fn<StateStore["getBySession"]>((hostId, id) =>
        hostId === "host-a" && id === "same-id" ? binding(id, hostId) : undefined,
      ),
    };
    const gatewayFor = vi.fn(() => gateway);
    const discovery = new ExistingSessionDiscovery(gatewayFor, state);

    await expect(discovery.discover({ ...scope, hostId: "host-b" })).resolves.toEqual([
      { ...session({ hostId: "host-b", id: "same-id" }), status: "idle", binding: "unbound" },
    ]);
    expect(gatewayFor).toHaveBeenCalledWith("host-b");
    expect(state.getBySession).toHaveBeenCalledWith("host-b", "same-id");
  });
});
