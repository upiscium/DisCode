import { describe, expect, it } from "vitest";
import { chunkDiscordText, renderAssistantResult, sanitizeThreadName } from "../src/discord/format.js";

describe("Discord formatting", () => {
  it("keeps chunks below the configured limit", () => {
    const chunks = chunkDiscordText("word ".repeat(1000), 300);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
  });

  it("renders text and tool errors without dumping successful tool output", () => {
    const rendered = renderAssistantResult([
      { type: "text", text: "Done." },
      { type: "tool", tool: "bash", state: { status: "completed", title: "build" } },
      { type: "tool", tool: "test", state: { status: "error", error: "failed" } },
    ]);
    expect(rendered).toContain("Done.");
    expect(rendered).toContain("test: failed");
    expect(rendered).not.toContain("build");
  });

  it("caps thread names at Discord's limit", () => {
    expect(sanitizeThreadName("x".repeat(120))).toHaveLength(100);
  });
});
