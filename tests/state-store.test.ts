import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state/state-store.js";

const binding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  hostId: "local",
  sessionId: "session-1",
  directory: "/repo",
  title: "repo",
  createdBy: "user-1",
  createdAt: "2026-08-22T00:00:00.000Z",
};

describe("StateStore", () => {
  it("persists and reloads host-aware bindings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const path = join(dir, "state.json");
    const store = new StateStore(path, "local");
    await store.load();
    await store.put(binding);

    const reloaded = new StateStore(path, "local");
    await reloaded.load();
    expect(reloaded.getByThread("thread-1")?.sessionId).toBe("session-1");
    expect(reloaded.getBySession("local", "session-1")?.threadId).toBe("thread-1");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  it("migrates legacy bindings to the configured default host without changing state version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const path = join(dir, "state.json");
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        bindings: {
          "thread-legacy": {
            threadId: "thread-legacy",
            parentChannelId: "parent-1",
            sessionId: "session-legacy",
            directory: "/repo",
            title: "repo",
            createdBy: "user-1",
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        },
      })}\n`,
    );

    const store = new StateStore(path, "lab");
    await store.load();

    expect(store.getByThread("thread-legacy")?.hostId).toBe("lab");
    expect(store.getByThread("thread-legacy")?.model).toBeUndefined();
    expect(store.getByThread("thread-legacy")?.agent).toBeUndefined();
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.bindings["thread-legacy"].hostId).toBe("lab");
  });

  it("disambiguates identical session ids on different hosts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const store = new StateStore(join(dir, "state.json"), "local");
    await store.load();
    await store.put(binding);
    await store.put({
      ...binding,
      threadId: "thread-2",
      hostId: "lab",
    });

    expect(store.getBySession("local", "session-1")?.threadId).toBe("thread-1");
    expect(store.getBySession("lab", "session-1")?.threadId).toBe("thread-2");
  });

  it("persists model and agent preferences without changing state version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const path = join(dir, "state.json");
    const store = new StateStore(path, "local");
    await store.load();
    await store.put(binding);
    await store.updateSelectionPreference("thread-1", {
      model: { providerID: "openai", modelID: "gpt-5.6" },
      agent: "build",
    });

    const reloaded = new StateStore(path, "local");
    await reloaded.load();
    expect(reloaded.getByThread("thread-1")?.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
    });
    expect(reloaded.getByThread("thread-1")?.agent).toBe("build");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  it("tracks the last published assistant message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const store = new StateStore(join(dir, "state.json"), "local");
    await store.load();
    await store.put(binding);
    await store.updateLastPublished("thread-1", "msg-2");
    expect(store.getByThread("thread-1")?.lastPublishedAssistantMessageId).toBe("msg-2");
  });

  it("adds an optional managed header id without changing state version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocdb-state-"));
    const path = join(dir, "state.json");
    const store = new StateStore(path, "local");
    await store.load();
    await store.put(binding);
    await store.updateHeaderMessageId("thread-1", "header-1");

    const reloaded = new StateStore(path, "local");
    await reloaded.load();
    expect(reloaded.getByThread("thread-1")?.headerMessageId).toBe("header-1");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });
});
