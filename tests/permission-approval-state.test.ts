import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state/state-store.js";

const binding = {
  threadId: "thread-1",
  parentChannelId: "parent-1",
  hostId: "host-1",
  sessionId: "ses-1",
  directory: "/repo",
  title: "repo",
  createdBy: "user-1",
  createdAt: "2026-09-13T00:00:00.000Z",
};

const approval = {
  hostId: "host-1",
  canonicalDirectory: "/repo",
  sessionId: "ses-1",
  permissionType: "bash",
  pattern: ["ssh *"],
};

describe("StateStore permission approvals", () => {
  it("migrates old state to an empty approval set without changing version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discode-approval-"));
    const path = join(dir, "state.json");
    await writeFile(path, `${JSON.stringify({ version: 1, bindings: {} })}\n`);

    const store = new StateStore(path, "host-1");
    await store.load();

    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.approvedPermissionPatterns).toEqual([]);
  });

  it("persists exact approvals across restart and isolates every authority field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discode-approval-"));
    const path = join(dir, "state.json");
    const store = new StateStore(path, "host-1");
    await store.load();
    expect(await store.approvePermissionPattern(approval)).toBe(true);

    const reloaded = new StateStore(path, "host-1");
    await reloaded.load();
    expect(reloaded.isPermissionPatternApproved(approval)).toBe(true);
    expect(reloaded.isPermissionPatternApproved({ ...approval, hostId: "host-2" })).toBe(false);
    expect(reloaded.isPermissionPatternApproved({ ...approval, canonicalDirectory: "/other" })).toBe(
      false,
    );
    expect(reloaded.isPermissionPatternApproved({ ...approval, sessionId: "ses-2" })).toBe(false);
    expect(reloaded.isPermissionPatternApproved({ ...approval, permissionType: "read" })).toBe(false);
    expect(reloaded.isPermissionPatternApproved({ ...approval, pattern: ["ssh -p *"] })).toBe(false);
    expect(reloaded.isPermissionPatternApproved({ ...approval, pattern: ["ssh  *"] })).toBe(false);
  });

  it("retains approvals across pure unbind and rebind of the same session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discode-approval-"));
    const store = new StateStore(join(dir, "state.json"), "host-1");
    await store.load();
    await store.put(binding);
    await store.approvePermissionPattern(approval);

    await store.remove(binding.threadId);
    expect(store.isPermissionPatternApproved(approval)).toBe(true);

    await store.put({ ...binding, threadId: "thread-2" });
    expect(store.isPermissionPatternApproved(approval)).toBe(true);
  });

  it("removes approvals atomically with close state removal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discode-approval-"));
    const store = new StateStore(join(dir, "state.json"), "host-1");
    await store.load();
    await store.put(binding);
    await store.approvePermissionPattern(approval);

    expect(await store.removeSessionState("thread-1", "host-1", "ses-1")).toBe(true);
    expect(store.getByThread("thread-1")).toBeUndefined();
    expect(store.isPermissionPatternApproved(approval)).toBe(false);
  });

  it("removes approvals when the OpenCode session is confirmed deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discode-approval-"));
    const store = new StateStore(join(dir, "state.json"), "host-1");
    await store.load();
    await store.approvePermissionPattern(approval);
    await store.approvePermissionPattern({ ...approval, sessionId: "ses-2" });

    expect(await store.removeApprovedPermissionPatterns("host-1", "ses-1")).toBe(1);
    expect(store.isPermissionPatternApproved(approval)).toBe(false);
    expect(store.isPermissionPatternApproved({ ...approval, sessionId: "ses-2" })).toBe(true);
  });

  it("fails closed for malformed approval input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "discode-approval-"));
    const store = new StateStore(join(dir, "state.json"), "host-1");
    await store.load();

    expect(await store.approvePermissionPattern({ ...approval, pattern: [] })).toBe(false);
    expect(store.isPermissionPatternApproved({ ...approval, pattern: [] })).toBe(false);
  });
});
