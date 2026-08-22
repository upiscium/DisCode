import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistantTextStreamBuffer,
  CoalescedSessionFlusher,
} from "../src/bridge/assistant-stream.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AssistantTextStreamBuffer", () => {
  it("streams only known assistant text parts and accepts final snapshots", () => {
    const buffer = new AssistantTextStreamBuffer();
    buffer.observeMessage({ sessionId: "ses_1", messageId: "msg_1", role: "assistant" });

    expect(
      buffer.observePart({
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "prt_text",
        type: "text",
        text: "",
      }),
    ).toBe(false);
    expect(
      buffer.appendDelta({
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "prt_text",
        field: "text",
        delta: "Hello ",
      }),
    ).toBe(true);
    expect(
      buffer.appendDelta({
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "prt_text",
        field: "text",
        delta: "world",
      }),
    ).toBe(true);
    expect(buffer.snapshot("ses_1")?.text).toBe("Hello world");

    expect(
      buffer.observePart({
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "prt_reasoning",
        type: "reasoning",
        text: "secret reasoning",
      }),
    ).toBe(false);
    expect(
      buffer.appendDelta({
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "prt_reasoning",
        field: "text",
        delta: "should not leak",
      }),
    ).toBe(false);
    expect(buffer.snapshot("ses_1")?.text).toBe("Hello world");

    expect(
      buffer.observePart({
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "prt_text",
        type: "text",
        text: "Hello world!",
      }),
    ).toBe(true);
    expect(buffer.snapshot("ses_1")?.text).toBe("Hello world!");
  });

  it("fails closed for user messages and deltas whose part type was never observed", () => {
    const buffer = new AssistantTextStreamBuffer();
    buffer.observeMessage({ sessionId: "ses_1", messageId: "msg_user", role: "user" });

    expect(
      buffer.observePart({
        sessionId: "ses_1",
        messageId: "msg_user",
        partId: "prt_user",
        type: "text",
        text: "user prompt",
      }),
    ).toBe(false);
    expect(
      buffer.appendDelta({
        sessionId: "ses_1",
        messageId: "msg_unknown",
        partId: "prt_unknown",
        field: "text",
        delta: "unknown",
      }),
    ).toBe(false);
    expect(buffer.snapshot("ses_1")).toBeUndefined();
  });

  it("tracks only the latest assistant message in a session", () => {
    const buffer = new AssistantTextStreamBuffer();
    buffer.observeMessage({ sessionId: "ses_1", messageId: "msg_1", role: "assistant" });
    buffer.observePart({
      sessionId: "ses_1",
      messageId: "msg_1",
      partId: "prt_1",
      type: "text",
      text: "old",
    });

    buffer.observeMessage({ sessionId: "ses_1", messageId: "msg_2", role: "assistant" });
    buffer.observePart({
      sessionId: "ses_1",
      messageId: "msg_2",
      partId: "prt_2",
      type: "text",
      text: "new",
    });

    expect(buffer.snapshot("ses_1")).toEqual({
      sessionId: "ses_1",
      messageId: "msg_2",
      text: "new",
    });
    expect(
      buffer.appendDelta({
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "prt_1",
        field: "text",
        delta: " stale",
      }),
    ).toBe(false);
  });
});

describe("CoalescedSessionFlusher", () => {
  it("coalesces high-frequency requests into one flush per interval", async () => {
    vi.useFakeTimers();
    const flush = vi.fn(async () => undefined);
    const flusher = new CoalescedSessionFlusher(1000);

    flusher.request("ses_1", flush);
    flusher.request("ses_1", flush);
    flusher.request("ses_1", flush);

    await vi.advanceTimersByTimeAsync(999);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending flush during finalization", async () => {
    vi.useFakeTimers();
    const flush = vi.fn(async () => undefined);
    const flusher = new CoalescedSessionFlusher(1000);

    flusher.request("ses_1", flush);
    flusher.cancel("ses_1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(flush).not.toHaveBeenCalled();
  });

  it("waits for an in-flight flush before finalization continues", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = vi.fn(async () => gate);
    const flusher = new CoalescedSessionFlusher(1000);

    flusher.request("ses_1", flush);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);

    let drained = false;
    const draining = flusher.cancelAndDrain("ses_1").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release?.();
    await draining;
    expect(drained).toBe(true);
  });
});
