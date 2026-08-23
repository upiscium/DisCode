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
    await expect(policy.authorize(link)).rejects.toThrow(/outside configured allowed roots/);
  });

  it("uses an injected resolver for remote canonical paths", async () => {
    const resolved = new Map([
      ["/srv/projects", "/srv/projects"],
      ["/srv/projects/link", "/etc"],
      ["/srv/projects/repo", "/srv/projects/repo"],
    ]);
    const policy = await DirectoryPolicy.createWithResolver(["/srv/projects"], async (value) => {
      const result = resolved.get(value);
      if (!result) throw new Error("missing");
      return result;
    });

    await expect(policy.authorize("/srv/projects/repo")).resolves.toBe("/srv/projects/repo");
    await expect(policy.authorize("/srv/projects/link")).rejects.toThrow(
      /outside configured allowed roots/,
    );
  });
});
