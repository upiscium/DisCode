import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DirectoryPolicy } from "../src/domain/directory-policy.js";

describe("DirectoryPolicy", () => {
  it("accepts directories inside an allowed real path", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocdb-root-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    const policy = await DirectoryPolicy.create([root]);
    await expect(policy.authorize(repo)).resolves.toBe(repo);
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocdb-root-"));
    const outside = await mkdtemp(join(tmpdir(), "ocdb-outside-"));
    const link = join(root, "escape");
    await symlink(outside, link, "dir");
    const policy = await DirectoryPolicy.create([root]);
    await expect(policy.authorize(link)).rejects.toThrow(/outside OPENCODE_ALLOWED_ROOTS/);
  });
});
