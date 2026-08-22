import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("open-tui-window helper", () => {
  it("keeps OpenCode credentials out of attach argv", async () => {
    const script = await readFile("scripts/open-tui-window.sh", "utf8");

    expect(script).toContain("opencode attach");
    expect(script).not.toContain("--password");
    expect(script).not.toContain("--username");
  });
});
