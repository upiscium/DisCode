import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistantStreamingPublisher,
  type DiscordMessageTransport,
} from "../src/bridge/assistant-streaming-publisher.js";
import {
  deliverCanonicalAssistantResult,
  renderAssistantStreamingPreview,
} from "../src/discord/streaming.js";
import type { SessionBinding } from "../src/domain/session-binding.js";
import type { OpenCodeEvent, OpenCodeGateway } from "../src/opencode/gateway.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Discord streaming helpers", () => {
  it("keeps the newest part of a long preview within the configured bound", () => {
    const rendered = renderAssistantStreamingPreview(`old-${"x".repeat(200)}-TAIL`, 80);
    expect(rendered.length).toBeLessThanOrEqual(80);
    expect(rendered).toContain("Streaming");
    expect(rendered).toEndWith("-TAIL");
    expect(rendered).not.toContain("old-");
  });

  it("promotes an existing preview instead of posting a duplicate first final chunk", async () => {
    const send = vi.fn(async () => undefined);
    const editPreview = vi.fn(async () => undefined);

    await deliverCanonicalAssistantResult({
      rendered: "canonical result",
      send,
      editPreview,
    });

    expect(editPreview).toHaveBeenCalledWith("✅ **Result**\ncanonical result");
    expect(send).not.toHaveBeenCalled();
  });

  it("falls back to a canonical new message if preview editing fails", async () => {
    const send = vi.fn(async () => undefined);
    const onPreviewEditError = vi.fn();

    await deliverCanonicalAssistantResult({
      rendered: "canonical result",
      send,
      editPreview: async () => {
        throw new Error("edit failed");
      },
      onPreviewEditError,
    });

    expect(onPreviewEditError).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("✅ **Result**\ncanonical result");
  });
});

describe("AssistantStreamingPublisher", () => {
  it("coalesces deltas, edits one preview, and promotes it to the canonical final result", async () => {
    vi.useFakeTimers();
    let binding = testBinding();
    const updateLastPublished = vi.fn(async (_threadId: string, messageId: string) => {
      binding = { ...binding, lastPublishedAssistantMessageId: messageId };
    });
    const state = {
      getBySession: (sessionId: string) => (sessionId === binding.sessionId ? { ...binding } : undefined),
      updateLastPublished,
    };
    const transport = fakeTransport();
    const publisher = new AssistantStreamingPublisher({
      enabled: true,
      discordToken: "unused-test-token",
      state,
      transport,
      flushIntervalMs: 1000,
    });
    const gateway = finalResultGateway();

    await publisher.handleEvent(assistantMessageEvent(), gateway);
    await publisher.handleEvent(textPartEvent(""), gateway);
    await publisher.handleEvent(textDeltaEvent("Hello "), gateway);
    await publisher.handleEvent(textDeltaEvent("world"), gateway);

    expect(transport.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.post.mock.calls[0]?.[1].body.content).toContain("Hello world");

    await publisher.handleEvent(textDeltaEvent("!"), gateway);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.patch).toHaveBeenCalledTimes(1);
    expect(transport.patch.mock.calls[0]?.[1].body.content).toContain("Hello world!");

    await publisher.handleEvent(idleEvent(), gateway);

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.patch).toHaveBeenCalledTimes(2);
    expect(transport.patch.mock.calls[1]?.[1].body.content).toBe(
      "✅ **Result**\nHello world!",
    );
    expect(updateLastPublished).toHaveBeenCalledWith("thread_1", "msg_1");
    expect(binding.lastPublishedAssistantMessageId).toBe("msg_1");
  });

  it("leaves idle finalization to the existing Bridge when no preview survived a restart", async () => {
    const binding = testBinding();
    const state = {
      getBySession: () => ({ ...binding }),
      updateLastPublished: vi.fn(async () => undefined),
    };
    const gateway = finalResultGateway();
    const publisher = new AssistantStreamingPublisher({
      enabled: true,
      discordToken: "unused-test-token",
      state,
      transport: fakeTransport(),
    });

    await publisher.handleEvent(idleEvent(), gateway);

    expect(gateway.latestAssistantResult).not.toHaveBeenCalled();
    expect(state.updateLastPublished).not.toHaveBeenCalled();
  });

  it("preserves Phase 1 final-only behavior when streaming is disabled", async () => {
    vi.useFakeTimers();
    const binding = testBinding();
    const state = {
      getBySession: () => ({ ...binding }),
      updateLastPublished: vi.fn(async () => undefined),
    };
    const transport = fakeTransport();
    const gateway = finalResultGateway();
    const publisher = new AssistantStreamingPublisher({
      enabled: false,
      discordToken: "unused-test-token",
      state,
      transport,
      flushIntervalMs: 10,
    });

    await publisher.handleEvent(assistantMessageEvent(), gateway);
    await publisher.handleEvent(textPartEvent(""), gateway);
    await publisher.handleEvent(textDeltaEvent("hidden until idle"), gateway);
    await vi.advanceTimersByTimeAsync(100);
    await publisher.handleEvent(idleEvent(), gateway);

    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.patch).not.toHaveBeenCalled();
    expect(gateway.latestAssistantResult).not.toHaveBeenCalled();
    expect(state.updateLastPublished).not.toHaveBeenCalled();
  });
});

function fakeTransport() {
  return {
    post: vi.fn(async () => ({ id: "discord_preview_1" })),
    patch: vi.fn(async () => ({ id: "discord_preview_1" })),
  } satisfies DiscordMessageTransport;
}

function finalResultGateway() {
  return {
    latestAssistantResult: vi.fn(async () => ({
      messageId: "msg_1",
      parts: [
        {
          id: "prt_final",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: "Hello world!",
        },
      ],
    })),
  } as unknown as Pick<OpenCodeGateway, "latestAssistantResult">;
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

function assistantMessageEvent(): OpenCodeEvent {
  return {
    type: "message.updated",
    properties: {
      sessionID: "ses_1",
      info: {
        id: "msg_1",
        sessionID: "ses_1",
        role: "assistant",
      },
    },
  } as unknown as OpenCodeEvent;
}

function textPartEvent(text: string): OpenCodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text,
      },
      time: 1,
    },
  } as unknown as OpenCodeEvent;
}

function textDeltaEvent(delta: string): OpenCodeEvent {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta,
    },
  } as unknown as OpenCodeEvent;
}

function idleEvent(): OpenCodeEvent {
  return {
    type: "session.idle",
    properties: { sessionID: "ses_1" },
  } as unknown as OpenCodeEvent;
}
