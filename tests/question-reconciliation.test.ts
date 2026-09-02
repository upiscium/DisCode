import { describe, expect, it, vi } from "vitest";
import { QuestionPublicationTracker } from "../src/bridge/question-publication.js";
import { reconcilePendingQuestions } from "../src/bridge/question-reconciliation.js";
import { noopLogger } from "../src/logging/logger.js";
import type { OpenCodeQuestionRequest } from "../src/opencode/gateway.js";

function question(id: string, sessionID: string): OpenCodeQuestionRequest {
  return { id, sessionID, questions: [] };
}

describe("reconcilePendingQuestions", () => {
  it("publishes only exact host, session, and queried-directory matches", async () => {
    const publish = vi.fn(async () => undefined);
    const adamList = vi.fn(async (directory: string) =>
      directory === "/repo/a"
        ? [question("q-a", "same"), question("q-unbound", "unbound")]
        : [question("q-wrong-dir", "same")],
    );
    const eveList = vi.fn(async () => [question("q-eve", "same")]);

    await reconcilePendingQuestions({
      bindings: [
        { hostId: "adam", sessionId: "same", directory: "/repo/a" },
        { hostId: "adam", sessionId: "other", directory: "/repo/other" },
        { hostId: "eve", sessionId: "same", directory: "/repo/eve" },
      ],
      hosts: [
        { id: "adam", listQuestions: adamList },
        { id: "eve", listQuestions: eveList },
      ],
      publish,
      logger: noopLogger,
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith("adam", "/repo/a", question("q-a", "same"));
    expect(publish).toHaveBeenCalledWith("eve", "/repo/eve", question("q-eve", "same"));
  });

  it("supports targeted singleton binding and host reconciliation", async () => {
    const listQuestions = vi.fn(async () => [question("q-1", "session-1")]);
    const publish = vi.fn(async () => undefined);

    await reconcilePendingQuestions({
      bindings: [{ hostId: "adam", sessionId: "session-1", directory: "/repo" }],
      hosts: [{ id: "adam", listQuestions }],
      publish,
      logger: noopLogger,
    });

    expect(listQuestions).toHaveBeenCalledExactlyOnceWith("/repo");
    expect(publish).toHaveBeenCalledExactlyOnceWith("adam", "/repo", question("q-1", "session-1"));
  });

  it("isolates list and publish failures with bounded logging", async () => {
    const warn = vi.fn<typeof noopLogger.warn>();
    const publish = vi.fn(async (hostId: string) => {
      if (hostId === "eve") throw new Error("raw question content /private/eve");
    });

    await reconcilePendingQuestions({
      bindings: [
        { hostId: "adam", sessionId: "a", directory: "/private/adam" },
        { hostId: "eve", sessionId: "e", directory: "/private/eve" },
        { hostId: "lab", sessionId: "l", directory: "/private/lab" },
      ],
      hosts: [
        {
          id: "adam",
          listQuestions: async () => {
            throw new Error("raw question /private/adam");
          },
        },
        { id: "eve", listQuestions: async () => [question("q-e", "e")] },
        { id: "lab", listQuestions: async () => [question("q-l", "l")] },
      ],
      publish,
      logger: { ...noopLogger, warn },
    });

    expect(publish).toHaveBeenCalledWith("lab", "/private/lab", question("q-l", "l"));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => call[2])).toEqual([
      { host_id: "adam" },
      { host_id: "eve" },
    ]);
  });

  it("coalesces a targeted reconcile racing a live event through one tracker", async () => {
    const tracker = new QuestionPublicationTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => gate);
    const request = question("q-1", "session-1");
    const publish = (_hostId: string, _directory: string, value: OpenCodeQuestionRequest) =>
      tracker.publish("adam", value, send).then(() => undefined);

    const reconcile = reconcilePendingQuestions({
      bindings: [{ hostId: "adam", sessionId: "session-1", directory: "/repo" }],
      hosts: [{ id: "adam", listQuestions: async () => [request] }],
      publish,
      logger: noopLogger,
    });
    const live = tracker.publish("adam", request, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();

    await Promise.all([reconcile, live]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
