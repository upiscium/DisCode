import { describe, expect, it } from "vitest";
import {
  credentialFreeBaseUrl,
  renderCodeBlock,
  renderSessionStatus,
  shellQuote,
} from "../src/discord/status.js";

describe("status attach command rendering", () => {
  it("quotes dynamic shell arguments safely", () => {
    expect(shellQuote("/tmp/project with spaces")).toBe("'/tmp/project with spaces'");
    expect(shellQuote("/tmp/it's-safe")).toBe("'/tmp/it'\"'\"'s-safe'");
  });

  it("removes URL credentials before rendering", () => {
    expect(credentialFreeBaseUrl("http://user:secret@127.0.0.1:4096/")).toBe(
      "http://127.0.0.1:4096",
    );
  });

  it("renders status metadata and a credential-free attach command", () => {
    const rendered = renderSessionStatus({
      sessionId: "ses_test",
      status: "idle",
      directory: "/tmp/project with spaces",
      baseUrl: "http://user:secret@127.0.0.1:4096",
    });

    expect(rendered).toContain("Session `ses_test`: **idle**");
    expect(rendered).toContain("Directory: `/tmp/project with spaces`");
    expect(rendered).toContain(
      "opencode attach 'http://127.0.0.1:4096' --session 'ses_test' --dir '/tmp/project with spaces'",
    );
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("user@");
    expect(rendered).not.toContain("--password");
    expect(rendered).not.toContain("--username");
  });

  it("uses a longer code fence when content contains backticks", () => {
    const rendered = renderCodeBlock("echo ```inside```", "sh");
    expect(rendered.startsWith("````sh\n")).toBe(true);
    expect(rendered.endsWith("\n````")).toBe(true);
  });

  it("rejects NUL in shell arguments", () => {
    expect(() => shellQuote("bad\0value")).toThrow(/NUL/);
  });
});
