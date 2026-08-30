import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  children: vi.fn(),
  get: vi.fn(),
  status: vi.fn(),
  messages: vi.fn(),
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(() => ({ session: mocks })),
}));

import {
  MAX_RECENT_MESSAGES,
  normalizeSession,
  normalizeSessionStatus,
  normalizeSessionStatuses,
  normalizeTranscript,
  OpenCodeChildSessionGateway,
} from "../src/opencode/child-session-gateway.js";

const session = {
  id: "child",
  parentID: "parent",
  directory: "/work",
  title: "Child",
  time: { created: 1, updated: 2 },
};

describe("OpenCodeChildSessionGateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the read-only child/session/status/messages SDK methods exactly", async () => {
    mocks.children.mockResolvedValue({ data: [session] });
    mocks.get.mockResolvedValue({ data: session });
    mocks.status.mockResolvedValue({ data: { child: { type: "busy" } } });
    mocks.messages.mockResolvedValue({ data: [] });
    const gateway = new OpenCodeChildSessionGateway({
      hostId: "host-a",
      baseUrl: "http://oc/",
      username: "u",
    });

    await expect(gateway.listChildren("/work", "parent")).resolves.toEqual([
      {
        hostId: "host-a",
        id: "child",
        parentId: "parent",
        directory: "/work",
        title: "Child",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    await gateway.getSession("/work", "child");
    await gateway.getStatus("/work", "child");
    await gateway.getRecentMessages("/work", "child", 3);

    expect(mocks.children).toHaveBeenCalledWith({
      path: { id: "parent" },
      query: { directory: "/work" },
      throwOnError: true,
    });
    expect(mocks.get).toHaveBeenCalledWith({
      path: { id: "child" },
      query: { directory: "/work" },
      throwOnError: true,
    });
    expect(mocks.status).toHaveBeenCalledWith({
      query: { directory: "/work" },
      throwOnError: true,
    });
    expect(mocks.messages).toHaveBeenCalledWith({
      path: { id: "child" },
      query: { directory: "/work", limit: 3 },
      throwOnError: true,
    });
  });

  it("normalizes sessions and explicit unknown statuses", () => {
    expect(normalizeSession({ ...session, parentID: "parent" }, "host-a")).toEqual({
      hostId: "host-a",
      id: "child",
      parentId: "parent",
      directory: "/work",
      title: "Child",
      createdAt: 1,
      updatedAt: 2,
    });
    expect(normalizeSessionStatus({ type: "idle" })).toBe("idle");
    expect(normalizeSessionStatus({ type: "future" })).toBe("unknown");
    expect(
      normalizeSessionStatuses({ child: { type: "busy" }, future: { type: "future" } }),
    ).toEqual({ child: "busy", future: "unknown" });
    const prototypeKeyed = normalizeSessionStatuses(
      JSON.parse('{"__proto__":{"type":"busy"}}') as unknown,
    );
    expect(Object.getOwnPropertyDescriptor(prototypeKeyed, "__proto__")?.value).toBe("busy");
  });

  it("extracts role, agent, model, bounded text and safe tool activity only", () => {
    const result = normalizeTranscript(
      {
        info: {
          id: "m1",
          sessionID: "child",
          role: "assistant",
          time: { created: 4 },
          providerID: "p",
          modelID: "m",
        },
        parts: [
          { type: "text", text: "hello" },
          { type: "agent", name: "builder" },
          {
            type: "tool",
            tool: "shell",
            state: {
              status: "completed",
              input: { secret: "x" },
              output: "raw-output",
              error: "raw-error",
            },
            metadata: { secret: "raw-metadata" },
          },
        ],
      },
      "child",
    );
    expect(result).toEqual({
      id: "m1",
      sessionId: "child",
      role: "assistant",
      createdAt: 4,
      agent: "builder",
      model: { providerID: "p", modelID: "m" },
      textParts: ["hello"],
      toolActivity: [{ tool: "shell", status: "completed" }],
      textTruncated: false,
      partsOmitted: 0,
      toolActivityOmitted: 0,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("raw-output");
    expect(JSON.stringify(result)).not.toContain("raw-error");
    expect(JSON.stringify(result)).not.toContain("raw-metadata");
  });

  it("rejects malformed responses and bounds recent requests", async () => {
    expect(normalizeSession({ id: 1, directory: "/work" }, "host-a")).toBeUndefined();
    expect(
      normalizeTranscript(
        { info: { id: "m", sessionID: "other", role: "user" }, parts: [] },
        "child",
      ),
    ).toBeUndefined();
    mocks.messages.mockResolvedValue({ data: [] });
    const gateway = new OpenCodeChildSessionGateway({
      hostId: "host-a",
      baseUrl: "http://oc",
      username: "u",
    });
    await gateway.getRecentMessages("/work", "child", 999);
    expect(mocks.messages).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { directory: "/work", limit: MAX_RECENT_MESSAGES },
      }),
    );
    mocks.get.mockResolvedValue({ data: { invalid: true } });
    await expect(gateway.getSession("/work", "child")).rejects.toThrow("invalid response");
  });

  it("truncates a valid oversized text part into a bounded projection", () => {
    const result = normalizeTranscript(
      {
        info: { id: "m", sessionID: "child", role: "user" },
        parts: [{ type: "text", text: "x".repeat(2_001) }],
      },
      "child",
    );
    expect(result?.textParts).toEqual(["x".repeat(2_000)]);
    expect(result).toMatchObject({ textTruncated: true, partsOmitted: 0 });
  });

  it("omits valid aggregate text beyond the deterministic character budget", () => {
    const result = normalizeTranscript(
      {
        info: { id: "m", sessionID: "child", role: "assistant" },
        parts: Array.from({ length: 5 }, (_, index) => ({
          type: "text",
          text: String(index).repeat(2_000),
        })),
      },
      "child",
    );
    expect(result?.textParts.join("").length).toBe(8_000);
    expect(result?.textParts).toHaveLength(4);
    expect(result).toMatchObject({ textTruncated: true, partsOmitted: 0 });
  });

  it("omits valid parts and tool payloads beyond the projection budget", () => {
    const result = normalizeTranscript(
      {
        info: { id: "m", sessionID: "child", role: "assistant" },
        parts: Array.from({ length: 45 }, (_, index) => ({
          type: "tool",
          tool: `tool-${index}`,
          state: {
            status: "completed",
            input: { secret: `input-${index}` },
            output: `output-${index}`,
            error: `error-${index}`,
          },
          metadata: { secret: `metadata-${index}` },
        })),
      },
      "child",
    );
    expect(result?.toolActivity).toHaveLength(40);
    expect(result).toMatchObject({ partsOmitted: 5, toolActivityOmitted: 5 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("input-");
    expect(serialized).not.toContain("output-");
    expect(serialized).not.toContain("error-");
    expect(serialized).not.toContain("metadata-");
  });

  it("still rejects malformed projected transcript parts", () => {
    expect(
      normalizeTranscript(
        {
          info: { id: "m", sessionID: "child", role: "user" },
          parts: [{ type: "text", text: 1 }],
        },
        "child",
      ),
    ).toBeUndefined();
  });
});
