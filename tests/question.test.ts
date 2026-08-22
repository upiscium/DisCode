import { describe, expect, it } from "vitest";
import { parseQuestionAnswers, renderQuestionAsk } from "../src/discord/question.js";

const choice = {
  question: "Which path?",
  header: "Path",
  options: [
    { label: "A", description: "First" },
    { label: "B", description: "Second" },
  ],
  custom: false,
};

describe("OpenCode Ask formatting", () => {
  it("renders an Ask for a Discord thread", () => {
    const text = renderQuestionAsk({ id: "que_1", sessionID: "ses_1", questions: [choice] });
    expect(text).toContain("Ask");
    expect(text).toContain("Which path?");
    expect(text).toContain("`A`");
  });

  it("parses a single choice", () => {
    expect(parseQuestionAnswers("B", [choice])).toEqual([["B"]]);
  });

  it("parses multiple questions line-by-line", () => {
    const multiple = { ...choice, multiple: true };
    expect(
      parseQuestionAnswers("1: A, B\n2: custom text", [
        multiple,
        { ...choice, options: [], custom: true },
      ]),
    ).toEqual([["A", "B"], ["custom text"]]);
  });

  it("rejects an invalid fixed option", () => {
    expect(() => parseQuestionAnswers("C", [choice])).toThrow(/must use one of/);
  });
});
