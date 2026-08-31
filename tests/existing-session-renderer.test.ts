import { describe, expect, it } from "vitest";
import {
  projectExistingSessionChoices,
  renderExistingSessions,
} from "../src/discord/existing-session.js";

const scope = { hostId: "host-a", canonicalDirectory: "/repo" };
const base = {
  hostId: "host-a",
  directory: "/repo",
  binding: "unbound" as const,
  title: "Session",
  status: "idle" as const,
  updatedAt: Date.parse("2026-01-01T00:00:00.000Z"),
};

describe("existing session renderers", () => {
  it("renders an explicit empty state", () => {
    expect(renderExistingSessions([])).toContain("No existing sessions.");
  });

  it("bounds output and reports item truncation", () => {
    const output = renderExistingSessions(
      Array.from({ length: 25 }, (_, i) => ({ ...base, id: `session-${i}`, title: "Title" })),
      { maxItems: 3 },
    );
    expect(output.length).toBeLessThanOrEqual(1900);
    expect(output).toContain("session(s) omitted");
    expect(output).toContain("Binding: unbound");

    const characterBounded = renderExistingSessions(
      [{ ...base, id: "session", title: "x".repeat(500) }],
      { maxLength: 160 },
    );
    expect(characterBounded).toHaveLength(160);
    expect(characterBounded).toContain("output truncated");
  });

  it("neutralizes mentions, markdown, and newlines without exposing directories", () => {
    const output = renderExistingSessions([
      { ...base, id: "s-1", title: "@everyone **bold** `code`\nnext" },
    ]);
    expect(output).toContain("＠everyone");
    expect(output).not.toMatch(/@everyone|`|\/repo/);
    expect(output).not.toContain("**bold**");
  });

  it("projects only eligible, unbound sessions in the exact scope", () => {
    const items = [
      { ...base, id: "good" },
      { ...base, id: "bound", binding: "bound" as const },
      { ...base, id: "child", parentId: "root" },
      { ...base, id: "archived", archivedAt: 1 },
      { ...base, id: "other-host", hostId: "host-b" },
      { ...base, id: "other-dir", directory: "/other" },
    ];
    expect(projectExistingSessionChoices(items, scope).map((choice) => choice.value)).toEqual([
      "good",
    ]);
  });

  it("filters queries, orders updated descending then ID, and enforces Discord limits", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      ...base,
      id: i === 29 ? "x".repeat(101) : `id-${String(29 - i).padStart(2, "0")}`,
      title: i === 28 ? `Find ${i} @everyone **${"x".repeat(200)}**` : `Find ${i}`,
      updatedAt: Date.parse("2026-02-01T00:00:00.000Z"),
    }));
    const choices = projectExistingSessionChoices(items, { ...scope, query: "find" });
    expect(choices).toHaveLength(25);
    expect(choices[0]?.value).toBe("id-01");
    expect(choices[0]?.name).not.toMatch(/@everyone|\*|`|\/repo/);
    expect(choices.some((choice) => choice.value.length > 100)).toBe(false);
    expect(choices.every((choice) => choice.name.length <= 100 && choice.value.length <= 100)).toBe(
      true,
    );
    expect(
      projectExistingSessionChoices(items, { ...scope, query: "Find 7" }).map(
        (choice) => choice.value,
      ),
    ).toEqual(["id-22"]);
    expect(
      projectExistingSessionChoices(items, { ...scope, query: "id-17" }).map(
        (choice) => choice.value,
      ),
    ).toEqual(["id-17"]);
  });
});
