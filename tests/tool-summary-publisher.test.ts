import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolSummaryPublisher,
  type ToolSummaryTransport,
} from "../src/bridge/tool-summary-publisher.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import type { OpenCodeEvent, OpenCodeGateway } from "../src/opencode/gateway.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolSummaryPublisher", () => {
  it("coalesces status transitions into one redacted summary message", async () => {
    vi.useFakeTimers();
    const binding = testBinding();
    const transport = fakeTransport();
    const publisher = new ToolSummaryPublisher({
      enabled: true,
      discordToken: "unused-test-token",
      state: { getBySession: () => ({ ...binding }) },
      transport,
      flushIntervalMs: 1000,
    });

    await publisher.handleEvent(assistantMessageEvent(), gatewayStub());
    await publisher.handleEvent(
      toolEvent({
        tool: "bash",
        status: "pending",
        input: { command: "echo TOP_SECRET_COMMAND" },
      }),
      gatewayStub(),
    );
    await publisher.handleEvent(
      toolEvent({
        tool: "bash",
        status: "running",
        input: { command: "echo TOP_SECRET_COMMAND" },
        time: { start: 1000 },
      }),
      gatewayStub(),
    );

    expect(transport.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.post).toHaveBeenCalledTimes(1);
    const first = transport.post.mock.calls[0]?.[1].body.content ?? "";
    expect(first).toContain("🔄 — bash");
    expect(first).not.toContain("TOP_SECRET_COMMAND");

    await publisher.handleEvent(
      toolEvent({
        tool: "bash",
        status: "completed",
        input: { command: "echo TOP_SECRET_COMMAND" },
        output: "TOP_SECRET_OUTPUT",
        title: "TOP_SECRET_TITLE",
        metadata: { secret: "TOP_SECRET_METADATA" },
        time: { start: 1000, end: 3500 },
      }),
      gatewayStub(),
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(transport.patch).toHaveBeenCalledTimes(1);
    const final = transport.patch.mock.calls[0]?.[1].body.content ?? "";
    expect(final).toContain("✅ — bash — 2.5s");
    expect(final).not.toContain("TOP_SECRET_COMMAND");
    expect(final).not.toContain("TOP_SECRET_OUTPUT");
    expect(final).not.toContain("TOP_SECRET_TITLE");
    expect(final).not.toContain("TOP_SECRET_METADATA");
  });

  it("shows only whitelisted safe annotations", async () => {
    vi.useFakeTimers();
    const binding = testBinding();
    const transport = fakeTransport();
    const publisher = new ToolSummaryPublisher({
      enabled: true,
      discordToken: "unused-test-token",
      state: { getBySession: () => ({ ...binding }) },
      transport,
      flushIntervalMs: 1000,
    });

    await publisher.handleEvent(assistantMessageEvent(), gatewayStub());
    await publisher.handleEvent(
      toolEvent({
        partId: "prt_read",
        tool: "read",
        status: "completed",
        input: { filePath: "/repo/src/main.ts" },
        output: "file contents must not appear",
        title: "main.ts",
        metadata: {},
        time: { start: 1000, end: 1100 },
      }),
      gatewayStub(),
    );
    await publisher.handleEvent(
      toolEvent({
        partId: "prt_fetch",
        tool: "webfetch",
        status: "completed",
        input: { url: "https://user:pass@example.com/docs?token=secret#fragment" },
        output: "web contents must not appear",
        title: "docs",
        metadata: {},
        time: { start: 1000, end: 1200 },
      }),
      gatewayStub(),
    );
    await vi.advanceTimersByTimeAsync(1000);

    const content = transport.post.mock.calls[0]?.[1].body.content ?? "";
    expect(content).toContain("src/main.ts");
    expect(content).toContain("https://example.com/docs");
    expect(content).not.toContain("token=secret");
    expect(content).not.toContain("user:pass");
    expect(content).not.toContain("file contents must not appear");
    expect(content).not.toContain("web contents must not appear");
  });

  it("flushes the latest tool status at session idle even before the cadence timer", async () => {
    vi.useFakeTimers();
    const binding = testBinding();
    const transport = fakeTransport();
    const publisher = new ToolSummaryPublisher({
      enabled: true,
      discordToken: "unused-test-token",
      state: { getBySession: () => ({ ...binding }) },
      transport,
      flushIntervalMs: 1000,
    });

    await publisher.handleEvent(assistantMessageEvent(), gatewayStub());
    await publisher.handleEvent(
      toolEvent({
        tool: "read",
        status: "completed",
        input: { filePath: "/repo/README.md" },
        output: "hidden",
        title: "README.md",
        metadata: {},
        time: { start: 0, end: 50 },
      }),
      gatewayStub(),
    );
    expect(transport.post).not.toHaveBeenCalled();

    await publisher.handleEvent(idleEvent(), gatewayStub());
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]?.[1].body.content).toContain("README.md");
  });

  it("flushes short tool activity before advancing to the next assistant message", async () => {
    vi.useFakeTimers();
    const binding = testBinding();
    const transport = fakeTransport();
    const publisher = new ToolSummaryPublisher({
      enabled: true,
      discordToken: "unused-test-token",
      state: { getBySession: () => ({ ...binding }) },
      transport,
      flushIntervalMs: 1000,
    });

    await publisher.handleEvent(assistantMessageEvent("msg_1"), gatewayStub());
    await publisher.handleEvent(
      toolEvent({
        tool: "read",
        status: "error",
        input: { filePath: "/repo/README.md" },
        error: "hidden read failure",
        time: { start: 0, end: 50 },
      }),
      gatewayStub(),
    );
    expect(transport.post).not.toHaveBeenCalled();

    await publisher.handleEvent(assistantMessageEvent("msg_2"), gatewayStub());

    expect(transport.post).toHaveBeenCalledTimes(1);
    const content = transport.post.mock.calls[0]?.[1].body.content ?? "";
    expect(content).toContain("❌ — read — README.md");
    expect(content).not.toContain("hidden read failure");

    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });

  it("does nothing when summaries are disabled", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const publisher = new ToolSummaryPublisher({
      enabled: false,
      discordToken: "unused-test-token",
      state: { getBySession: () => testBinding() },
      transport,
      flushIntervalMs: 10,
    });

    await publisher.handleEvent(assistantMessageEvent(), gatewayStub());
    await publisher.handleEvent(
      toolEvent({ tool: "read", status: "pending", input: { filePath: "/repo/a" } }),
      gatewayStub(),
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.patch).not.toHaveBeenCalled();
  });
});

function fakeTransport() {
  return {
    post: vi.fn(async (_route: string, _options: { body: { content: string } }) => ({
      id: "tool_summary_1",
    })),
    patch: vi.fn(async (_route: string, _options: { body: { content: string } }) => ({
      id: "tool_summary_1",
    })),
  } satisfies ToolSummaryTransport;
}

function gatewayStub(): Pick<OpenCodeGateway, "latestAssistantResult"> {
  return { latestAssistantResult: vi.fn() } as unknown as Pick<
    OpenCodeGateway,
    "latestAssistantResult"
  >;
}

function testBinding(): SessionBinding {
  return {
    threadId: "thread_1",
    parentChannelId: "parent_1",
    sessionId: "ses_1",
    directory: "/repo",
    title: "test",
    createdBy: "user_1",
    createdAt: "2026-08-22T00:00:00.000Z",
  };
}

function assistantMessageEvent(messageId = "msg_1"): OpenCodeEvent {
  return {
    type: "message.updated",
    properties: {
      info: { id: messageId, sessionID: "ses_1", role: "assistant" },
    },
  } as unknown as OpenCodeEvent;
}

function toolEvent(input: {
  partId?: string;
  tool: string;
  status: "pending" | "running" | "completed" | "error";
  input: Record<string, unknown>;
  output?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  time?: { start: number; end?: number };
}): OpenCodeEvent {
  const state = {
    status: input.status,
    input: input.input,
    ...(input.status === "pending" ? { raw: "" } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.time !== undefined ? { time: input.time } : {}),
  };
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: input.partId ?? "prt_tool",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        callID: `call_${input.partId ?? "tool"}`,
        tool: input.tool,
        state,
      },
    },
  } as unknown as OpenCodeEvent;
}

function idleEvent(): OpenCodeEvent {
  return {
    type: "session.idle",
    properties: { sessionID: "ses_1" },
  } as unknown as OpenCodeEvent;
}
