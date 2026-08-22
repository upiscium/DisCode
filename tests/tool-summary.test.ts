import { describe, expect, it } from "vitest";
import {
  renderToolActivitySummary,
  safeToolAnnotation,
  type ToolActivityItem,
} from "../src/discord/tool-summary.js";

describe("tool summary redaction", () => {
  it("shows repository-relative paths for whitelisted file tools", () => {
    expect(
      safeToolAnnotation({
        tool: "read",
        input: { filePath: "/repo/src/config.ts", secret: "must-not-leak" },
        directory: "/repo",
      }),
    ).toBe("src/config.ts");

    expect(
      safeToolAnnotation({
        tool: "grep",
        input: { path: "src", pattern: "SUPER_SECRET_PATTERN" },
        directory: "/repo",
      }),
    ).toBe("src");
  });

  it("hides external paths instead of exposing them", () => {
    expect(
      safeToolAnnotation({
        tool: "read",
        input: { filePath: "/etc/shadow" },
        directory: "/repo",
      }),
    ).toBe("[external path]");
  });

  it("strips URL credentials, query parameters, and fragments", () => {
    expect(
      safeToolAnnotation({
        tool: "webfetch",
        input: { url: "https://user:password@example.com/docs/page?token=secret#private" },
        directory: "/repo",
      }),
    ).toBe("https://example.com/docs/page");
  });

  it("does not expose commands, queries, patterns, prompts, or unknown inputs", () => {
    const sensitive = "TOP_SECRET_VALUE";
    expect(
      safeToolAnnotation({ tool: "bash", input: { command: sensitive }, directory: "/repo" }),
    ).toBeUndefined();
    expect(
      safeToolAnnotation({ tool: "websearch", input: { query: sensitive }, directory: "/repo" }),
    ).toBeUndefined();
    expect(
      safeToolAnnotation({ tool: "task", input: { prompt: sensitive }, directory: "/repo" }),
    ).toBeUndefined();
    expect(
      safeToolAnnotation({ tool: "custom-tool", input: { path: sensitive }, directory: "/repo" }),
    ).toBeUndefined();
  });
});

describe("renderToolActivitySummary", () => {
  it("renders status and duration without raw details", () => {
    const rendered = renderToolActivitySummary(
      [
        {
          partId: "1",
          tool: "read",
          status: "running",
          annotation: "src/config.ts",
          startedAt: 1_000,
        },
        {
          partId: "2",
          tool: "bash",
          status: "error",
          startedAt: 1_000,
          endedAt: 6_000,
        },
      ],
      { now: 2_200 },
    );

    expect(rendered).toContain("🔄 — read — src/config.ts — 1.2s");
    expect(rendered).toContain("❌ — bash — 5.0s");
  });

  it("bounds large tool histories and omits earlier entries", () => {
    const items: ToolActivityItem[] = Array.from({ length: 30 }, (_, index) => ({
      partId: String(index),
      tool: `tool-${index}`,
      status: "completed",
      startedAt: 0,
      endedAt: 100,
    }));

    const rendered = renderToolActivitySummary(items, { maxItems: 5, maxLength: 400 });
    expect(rendered.length).toBeLessThanOrEqual(400);
    expect(rendered).toContain("25 earlier calls omitted");
    expect(rendered).toContain("tool-29");
    expect(rendered).not.toContain("tool-0 —");
  });
});
