import { describe, expect, it } from "vitest";
import { renderSubagentDetail, renderSubagentList } from "../src/discord/subagent.js";

const base = {
  id: "child-1",
  parentSessionId: "root-1",
  depth: 2,
  hostId: "host-a",
  directory: "/repo",
};

describe("subagent Discord renderers", () => {
  it("renders list metadata and explicit unknown optionals", () => {
    const output = renderSubagentList([base]);
    expect(output).toContain("child-1");
    expect(output).toContain("Parent: root-1");
    expect(output).toContain("Status: (unknown)");
    expect(output).toContain("Agent: (unknown)");
    expect(output).toContain("Depth: 2");
    expect(output).not.toContain("host-a");
    expect(output).not.toContain("/repo");
  });

  it("bounds long lists and reports omitted descendants", () => {
    const output = renderSubagentList(
      Array.from({ length: 12 }, (_, index) => ({
        ...base,
        id: `child-${index}`,
        title: `Title ${index} ${"x".repeat(100)}`,
      })),
      { maxLength: 1_200, maxItems: 3 },
    );

    expect(output.length).toBeLessThanOrEqual(1_200);
    expect(output).toContain("subagent(s) omitted");
  });

  it("renders graph truncation and rejects invalid renderer limits", () => {
    expect(
      renderSubagentList({
        items: [base],
        depthBoundaryReached: true,
        sessionLimitReached: true,
      }),
    ).toContain(
      "deeper descendants not checked (depth boundary); discovery truncated (session limit)",
    );
    expect(() => renderSubagentList([base], { maxLength: -1 })).toThrow("maxLength");
    expect(() => renderSubagentList([base], { maxItems: -1 })).toThrow("maxItems");
  });

  it("preserves roles, bounds transcript and reports omissions", () => {
    const output = renderSubagentDetail(
      {
        ...base,
        messages: Array.from({ length: 8 }, (_, i) => ({
          role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
          text: `message-${i}`,
          ...(i === 7 ? { textTruncated: true, partsOmitted: 2, toolActivityOmitted: 3 } : {}),
        })),
        toolActivity: Array.from({ length: 8 }, (_, i) => ({
          tool: `tool-${i}`,
          status: "completed",
          payload: "secret",
        })),
      },
      { maxLength: 700, maxMessages: 3, maxTools: 2 },
    );
    expect(output.length).toBeLessThanOrEqual(700);
    expect(output).toContain("User:");
    expect(output).toContain("Assistant:");
    expect(output).toContain("message(s) omitted");
    expect(output).toContain("tool entr");
    expect(output).toContain("text truncated");
    expect(output).toContain("part(s) omitted");
    expect(output).not.toContain("secret");
  });

  it("neutralizes mentions, markdown, and backticks", () => {
    const output = renderSubagentDetail({
      ...base,
      title: "@everyone **x** `code`",
      messages: [{ role: "user", text: "@here *unsafe* `x`" }],
    });
    expect(output).not.toContain("@everyone");
    expect(output).not.toContain("@here");
    expect(output).toContain("＠everyone");
    expect(output).not.toContain("`");
  });

  it("renders TODOs and unavailable TODO state", () => {
    expect(
      renderSubagentDetail({
        ...base,
        todos: [{ content: "Ship feature", status: "in_progress", priority: "high" }],
      }),
    ).toContain("[~] Ship feature");
    expect(renderSubagentDetail({ ...base, todoUnavailable: true })).toContain("TODO unavailable");
  });
});
