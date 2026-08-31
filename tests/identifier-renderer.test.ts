import { describe, expect, it } from "vitest";
import { renderCanonicalIdentifier } from "../src/discord/identifier.js";

describe("canonical identifier renderer", () => {
  it("preserves canonical punctuation in inline code", () => {
    expect(renderCanonicalIdentifier("ses_fab083_abc-123")).toBe("`ses_fab083_abc-123`");
  });

  it("uses a safe fence for embedded backticks and replaces controls", () => {
    expect(renderCanonicalIdentifier("ses_`edge`_id")).toBe("``ses_`edge`_id``");
    expect(renderCanonicalIdentifier("ses_line\nbreak")).toBe("`ses_line�break`");
  });

  it("bounds the complete rendered identifier", () => {
    const output = renderCanonicalIdentifier(`ses_${"x".repeat(200)}`, 40);
    expect(output).toHaveLength(40);
    expect(output).toMatch(/^`ses_/);
    expect(output).toMatch(/…`$/);
  });
});
