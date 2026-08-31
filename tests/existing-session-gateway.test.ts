import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient: mocks.createClient }));

import {
  MAX_EXISTING_SESSION_ITEMS,
  normalizeExistingSession,
  normalizeExistingSessions,
  OpenCodeExistingSessionGateway,
} from "../src/opencode/existing-session-gateway.js";

const raw = {
  id: "s1",
  directory: "/work",
  parentID: "p1",
  title: "title",
  agent: "agent",
  model: { providerID: "provider", id: "model" },
  time: { created: 1, updated: 2, archived: 3 },
};

describe("OpenCodeExistingSessionGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockReturnValue({ session: mocks });
  });

  it("uses exact SDK calls and credentials", async () => {
    mocks.list.mockResolvedValue({ data: [raw] });
    mocks.get.mockResolvedValue({ data: raw });
    mocks.status.mockResolvedValue({ data: { s1: { type: "busy" } } });
    const gateway = new OpenCodeExistingSessionGateway({
      hostId: "h",
      baseUrl: "https://oc/",
      username: "u",
      password: "p",
    });
    await gateway.listSessions("/work", { limit: 2 });
    await gateway.getSession("/work", "s1");
    await gateway.listStatuses("/work");
    expect(mocks.createClient).toHaveBeenCalledWith({
      baseUrl: "https://oc",
      headers: { Authorization: `Basic ${Buffer.from("u:p").toString("base64")}` },
    });
    expect(mocks.list).toHaveBeenCalledWith(
      { directory: "/work", roots: true, limit: 2 },
      { throwOnError: true },
    );
    expect(mocks.get).toHaveBeenCalledWith(
      { sessionID: "s1", directory: "/work" },
      { throwOnError: true },
    );
    expect(mocks.status).toHaveBeenCalledWith({ directory: "/work" }, { throwOnError: true });
  });

  it("projects metadata, timestamps, and truncates optional strings", () => {
    const session = normalizeExistingSession(
      {
        ...raw,
        title: "x".repeat(300),
        agent: "a".repeat(300),
        model: { providerID: "p".repeat(300), id: "m".repeat(300) },
      },
      "h",
    );
    expect(session).toMatchObject({
      hostId: "h",
      id: "s1",
      parentId: "p1",
      createdAt: 1,
      updatedAt: 2,
      archivedAt: 3,
    });
    expect(session?.title).toHaveLength(256);
    expect(session?.agent).toHaveLength(256);
    expect(session?.model).toEqual({ providerID: "p".repeat(256), modelID: "m".repeat(256) });
  });

  it("strictly rejects type-invalid session fields", () => {
    for (const invalid of [
      { ...raw, id: 1 },
      { ...raw, directory: null },
      { ...raw, parentID: "" },
      { ...raw, title: 1 },
      { ...raw, agent: [] },
      { ...raw, model: { providerID: "provider", id: 1 } },
      { ...raw, time: { created: "now" } },
    ]) {
      expect(normalizeExistingSession(invalid, "h")).toBeUndefined();
    }
  });

  it("bounds valid lists, rejects invalid sessions, and rejects malformed statuses", async () => {
    mocks.list.mockResolvedValue({ data: Array.from({ length: 100 }, () => raw) });
    mocks.status.mockResolvedValue({ data: { s1: { type: 1 } } });
    const gateway = new OpenCodeExistingSessionGateway({
      hostId: "h",
      baseUrl: "http://oc",
      username: "u",
    });
    await expect(gateway.listSessions("/work")).resolves.toHaveLength(MAX_EXISTING_SESSION_ITEMS);
    expect(mocks.list).toHaveBeenNthCalledWith(
      1,
      { directory: "/work", roots: true, limit: MAX_EXISTING_SESSION_ITEMS },
      { throwOnError: true },
    );
    await expect(gateway.listSessions("/work", { limit: 2 })).resolves.toHaveLength(2);
    await expect(gateway.listSessions("/work", { limit: 0 })).rejects.toThrow("limit");
    expect(
      normalizeExistingSessions(
        Array.from({ length: 100 }, () => raw),
        "h",
      ),
    ).toHaveLength(MAX_EXISTING_SESSION_ITEMS);
    mocks.get.mockResolvedValue({ data: { id: 1, directory: "/work" } });
    await expect(gateway.getSession("/work", "s1")).rejects.toThrow("invalid response");
    await expect(gateway.listStatuses("/work")).rejects.toThrow("invalid response");
  });

  it("normalizes explicit future statuses as unknown without inventing idle entries", async () => {
    mocks.status.mockResolvedValue({
      data: { busy: { type: "busy" }, future: { type: "future" } },
    });
    const gateway = new OpenCodeExistingSessionGateway({
      hostId: "h",
      baseUrl: "http://oc",
      username: "u",
    });

    await expect(gateway.listStatuses("/work")).resolves.toEqual({
      busy: "busy",
      future: "unknown",
    });
  });
});
