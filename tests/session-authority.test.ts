import { describe, expect, it, vi } from "vitest";
import { SessionAuthorityResolver } from "../src/core/session-authority.js";

function runtime(sessionOverrides: Record<string, unknown> = {}) {
  const authorizeDirectory = vi.fn(async (directory: string) =>
    directory === "~/repo" ? "/home/upiscium/repo" : directory,
  );
  const getSession = vi.fn(async (directory: string, sessionId: string) => ({
    hostId: "host-1",
    id: sessionId,
    directory,
    title: "repo",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5.6" },
    ...sessionOverrides,
  }));
  return {
    value: {
      id: "host-1",
      authorizeDirectory,
      existingSessions: { getSession },
    },
    authorizeDirectory,
    getSession,
  };
}

describe("SessionAuthorityResolver", () => {
  it("resolves selected-host directory before fresh exact session validation", async () => {
    const host = runtime();
    const get = vi.fn((hostId: string) => {
      expect(hostId).toBe("host-1");
      return host.value;
    });
    const resolver = new SessionAuthorityResolver({ get });

    await expect(
      resolver.resolve({ hostId: "host-1", directory: "~/repo", sessionId: "ses-1" }),
    ).resolves.toEqual({
      hostId: "host-1",
      canonicalDirectory: "/home/upiscium/repo",
      sessionId: "ses-1",
      title: "repo",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6" },
    });

    expect(host.authorizeDirectory).toHaveBeenCalledWith("~/repo");
    expect(host.getSession).toHaveBeenCalledWith("/home/upiscium/repo", "ses-1");
  });

  it.each([
    ["host mismatch", { hostId: "host-2" }],
    ["session mismatch", { id: "other-session" }],
    ["directory mismatch", { directory: "/other" }],
  ])("fails closed on %s", async (_label, overrides) => {
    const host = runtime(overrides);
    const resolver = new SessionAuthorityResolver({ get: () => host.value });

    await expect(
      resolver.resolve({ hostId: "host-1", directory: "/repo", sessionId: "ses-1" }),
    ).rejects.toThrow(/identity changed/);
  });

  it("rejects child sessions as mutable root authority", async () => {
    const host = runtime({ parentId: "root-session" });
    const resolver = new SessionAuthorityResolver({ get: () => host.value });

    await expect(
      resolver.resolve({ hostId: "host-1", directory: "/repo", sessionId: "child-1" }),
    ).rejects.toThrow(/root sessions/);
  });

  it("rejects archived sessions", async () => {
    const host = runtime({ archivedAt: 1 });
    const resolver = new SessionAuthorityResolver({ get: () => host.value });

    await expect(
      resolver.resolve({ hostId: "host-1", directory: "/repo", sessionId: "ses-1" }),
    ).rejects.toThrow(/Archived/);
  });

  it("requires every authority component", async () => {
    const host = runtime();
    const resolver = new SessionAuthorityResolver({ get: () => host.value });

    await expect(
      resolver.resolve({ hostId: "", directory: "/repo", sessionId: "ses-1" }),
    ).rejects.toThrow(/requires host, directory, and session identity/);
    expect(host.authorizeDirectory).not.toHaveBeenCalled();
    expect(host.getSession).not.toHaveBeenCalled();
  });
});
