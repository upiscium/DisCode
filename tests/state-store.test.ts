import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state/state-store.js";

const binding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  sessionId: "session-1",
  directory: "/repo",
  title: "repo",
  createdBy: "user-1",
  createdAt: "2026-08-22T00:00:00.000Z",
};

describe("StateStore", () => {
  it("persists and reloads bindings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const path = join(dir, "state.json");
    const store = new StateStore(path);
    await store.load();
    await store.put(binding);

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.getByThread("thread-1")?.sessionId).toBe("session-1");
    expect(reloaded.getBySession("session-1")?.threadId).toBe("thread-1");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  it("tracks the last published assistant message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const store = new StateStore(join(dir, "state.json"));
    await store.load();
    await store.put(binding);
    await store.updateLastPublished("thread-1", "msg-2");
    expect(store.getByThread("thread-1")?.lastPublishedAssistantMessageId).toBe("msg-2");
  });
});
