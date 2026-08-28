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

  it("renders status plus actual and preferred selections separately", () => {
    const rendered = renderSessionStatus({
      hostId: "lab",
      sessionId: "ses_test",
      status: "idle",
      directory: "/tmp/project with spaces",
      baseUrl: "http://user:secret@127.0.0.1:4096",
      actualModel: { providerID: "openai", modelID: "gpt-5.6" },
      actualAgent: "build",
      preferenceModel: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.6" },
      preferenceAgent: "review",
    });

    expect(rendered).toContain("Host: `lab`");
    expect(rendered).toContain("Session `ses_test`: **idle**");
    expect(rendered).toContain("Directory: `/tmp/project with spaces`");
    expect(rendered).toContain("Latest actual model: `openai/gpt-5.6`");
    expect(rendered).toContain("Latest actual agent: `build`");
    expect(rendered).toContain(
      "Discord model preference: `openrouter/anthropic/claude-sonnet-4.6`",
    );
    expect(rendered).toContain("Discord agent preference: `review`");
    expect(rendered).toContain(
      "opencode attach 'http://127.0.0.1:4096' --session 'ses_test' --dir '/tmp/project with spaces'",
    );
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("user@");
    expect(rendered).not.toContain("--password");
    expect(rendered).not.toContain("--username");
  });

  it("distinguishes unknown actual context from default preferences", () => {
    const rendered = renderSessionStatus({
      hostId: "local",
      sessionId: "ses_new",
      status: "idle",
      directory: "/repo",
      baseUrl: "http://127.0.0.1:4096",
    });

    expect(rendered).toContain("Latest actual model: `(not observed yet)`");
    expect(rendered).toContain("Latest actual agent: `(not observed yet)`");
    expect(rendered).toContain("Discord model preference: `(OpenCode default)`");
    expect(rendered).toContain("Discord agent preference: `(OpenCode default)`");
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
