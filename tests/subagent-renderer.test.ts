import { describe, expect, it } from "vitest";
import {
  renderSubagentChoiceLabel,
  renderSubagentDetail,
  renderSubagentList,
} from "../src/discord/subagent.js";

const base = {
  id: "ses_fab083_abc",
  parentSessionId: "ses_parent_123",
  depth: 2,
  hostId: "host-a",
  directory: "/repo",
};

describe("subagent Discord renderers", () => {
  it("renders list metadata and explicit unknown optionals", () => {
    const output = renderSubagentList([base]);
    expect(output).toContain("Session: `ses_fab083_abc`");
    expect(output).toContain("Parent: `ses_parent_123`");
    expect(output).toContain("Status: (unknown)");
    expect(output).toContain("Agent: (unknown)");
    expect(output).toContain("Depth: 2");
    expect(output).not.toContain("host-a");
    expect(output).not.toContain("/repo");
  });

  it("renders an explicit empty state and safe bounded autocomplete labels", () => {
    expect(renderSubagentList([])).toContain("No current SubAgents.");
    const label = renderSubagentChoiceLabel({
      ...base,
      title: "@everyone **inspect** `tests`",
      agent: "explore",
      status: "busy",
    });
    expect(label.length).toBeLessThanOrEqual(100);
    expect(label).not.toContain("@everyone");
    expect(label).not.toContain("*");
    expect(label).not.toContain("`");
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

  it("preserves exact Session and Parent identifiers in list and detail output", () => {
    const list = renderSubagentList([base]);
    const detail = renderSubagentDetail(base);

    for (const output of [list, detail]) {
      expect(output).toContain("`ses_fab083_abc`");
      expect(output).toContain("`ses_parent_123`");
    }
  });

  it("neutralizes mentions, markdown, and backticks", () => {
    const output = renderSubagentDetail({
      ...base,
      title: "@everyone **x** `code` [click](https://bad.example)",
      messages: [{ role: "user", text: "@here *unsafe* `x`" }],
    });
    expect(output).not.toContain("@everyone");
    expect(output).not.toContain("@here");
    expect(output).toContain("＠everyone");
    expect(output).not.toContain("`code`");
    expect(output).not.toContain("`x`");
    expect(output).not.toContain("[click](https://bad.example)");
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
