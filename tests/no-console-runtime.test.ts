import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

describe("runtime logging boundary", () => {
  it("does not use direct console logging in src", () => {
    for (const path of sourceFiles("src")) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/\bconsole\.(?:log|error|warn|debug)\b/);
    }
  });
});
