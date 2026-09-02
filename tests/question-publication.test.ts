import { describe, expect, it, vi } from "vitest";
import { QuestionPublicationTracker } from "../src/bridge/question-publication.js";
import type { OpenCodeQuestionRequest } from "../src/opencode/gateway.js";

function question(
  id = "question-1",
  sessionID = "session-1",
  content = "Sensitive question content",
): OpenCodeQuestionRequest {
  return {
    id,
    sessionID,
    questions: [{ header: "Header", question: content, options: [] }],
  };
}

describe("QuestionPublicationTracker", () => {
  it("publishes once and suppresses an already-published request", async () => {
    const tracker = new QuestionPublicationTracker();
    const send = vi.fn(async () => undefined);

    await expect(tracker.publish("adam", question(), send)).resolves.toBe(true);
    await expect(tracker.publish("adam", question(), send)).resolves.toBe(false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(tracker.current("adam", "question-1")?.sessionID).toBe("session-1");
  });

  it("coalesces concurrent publication", async () => {
    const tracker = new QuestionPublicationTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => gate);

    const first = tracker.publish("adam", question(), send);
    const second = tracker.publish("adam", question(), send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it("removes a failed reservation and permits retry", async () => {
    const tracker = new QuestionPublicationTracker();
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("send failed"))
      .mockResolvedValueOnce(undefined);

    await expect(tracker.publish("adam", question(), send)).rejects.toThrow("send failed");
    expect(tracker.current("adam", "question-1")).toBeUndefined();
    await expect(tracker.publish("adam", question(), send)).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps request IDs and hosts independent", async () => {
    const tracker = new QuestionPublicationTracker();
    const send = vi.fn(async () => undefined);

    await tracker.publish("adam", question("question-1"), send);
    await tracker.publish("adam", question("question-2"), send);
    await tracker.publish("eve", question("question-1"), send);

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("clear permits later publication", async () => {
    const tracker = new QuestionPublicationTracker();
    const send = vi.fn(async () => undefined);
    await tracker.publish("adam", question(), send);

    tracker.clear("adam", "question-1");
    await tracker.publish("adam", question(), send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("clearSession removes only the exact host and session", async () => {
    const tracker = new QuestionPublicationTracker();
    const send = vi.fn(async () => undefined);
    await tracker.publish("adam", question("q-a", "session-1"), send);
    await tracker.publish("adam", question("q-b", "session-2"), send);
    await tracker.publish("eve", question("q-c", "session-1"), send);

    tracker.clearSession("adam", "session-1");

    expect(tracker.current("adam", "q-a")).toBeUndefined();
    expect(tracker.current("adam", "q-b")).toBeDefined();
    expect(tracker.current("eve", "q-c")).toBeDefined();
  });

  it("allows the same pending Ask to publish after unbind-style session cleanup", async () => {
    const tracker = new QuestionPublicationTracker();
    const send = vi.fn(async () => undefined);
    const request = question();
    await tracker.publish("adam", request, send);

    tracker.clearSession("adam", "session-1");
    await tracker.publish("adam", request, send);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not use raw Question content as publication identity", async () => {
    const tracker = new QuestionPublicationTracker();
    const send = vi.fn(async () => undefined);

    await tracker.publish("adam", question("same-id", "session-1", "first secret"), send);
    await tracker.publish("adam", question("same-id", "session-1", "different secret"), send);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("clear during publication prevents a published marker", async () => {
    const tracker = new QuestionPublicationTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publishing = tracker.publish("adam", question(), async () => gate);
    tracker.clearSession("adam", "session-1");
    release();

    await expect(publishing).resolves.toBe(false);
    expect(tracker.current("adam", "question-1")).toBeUndefined();
  });
});
