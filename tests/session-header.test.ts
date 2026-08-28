import { describe, expect, it } from "vitest";
import { renderSessionHeader } from "../src/discord/session-header.js";

describe("session header rendering", () => {
  it("renders actual and preferred model/agent metadata separately", () => {
    const rendered = renderSessionHeader({
      hostId: "lab",
      sessionId: "ses_test",
      directory: "/repo",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      agent: "build",
      preferenceModel: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.6" },
      preferenceAgent: "review",
      branch: "feat/header",
    });

    expect(rendered).toContain("Host: `lab`");
    expect(rendered).toContain("Session: `ses_test`");
    expect(rendered).toContain("Directory: `/repo`");
    expect(rendered).toContain("Latest actual model: `openai/gpt-5.6`");
    expect(rendered).toContain("Latest actual agent: `build`");
    expect(rendered).toContain(
      "Discord model preference: `openrouter/anthropic/claude-sonnet-4.6`",
    );
    expect(rendered).toContain("Discord agent preference: `review`");
    expect(rendered).toContain("Branch: `feat/header`");
    expect(rendered).toContain("Messages posted in this thread are sent to OpenCode.");
  });

  it("distinguishes unknown actual context from OpenCode-default preferences", () => {
    const rendered = renderSessionHeader({
      hostId: "local",
      sessionId: "ses_new",
      directory: "/repo",
    });

    expect(rendered).toContain("Latest actual model: `(not observed yet)`");
    expect(rendered).toContain("Latest actual agent: `(not observed yet)`");
    expect(rendered).toContain("Discord model preference: `(OpenCode default)`");
    expect(rendered).toContain("Discord agent preference: `(OpenCode default)`");
    expect(rendered).toContain("Branch: `(none)`");
  });

  it("neutralizes inline-code delimiters and newlines", () => {
    const rendered = renderSessionHeader({
      hostId: "lab",
      sessionId: "ses_`test",
      directory: "/repo\nnext",
      agent: "build`agent",
      preferenceAgent: "review`agent",
      branch: "feat/test\nnext",
    });

    expect(rendered).not.toContain("ses_`test");
    expect(rendered).not.toContain("/repo\nnext");
    expect(rendered).toContain("ses_ˋtest");
    expect(rendered).toContain("/repo next");
    expect(rendered).toContain("buildˋagent");
    expect(rendered).toContain("reviewˋagent");
    expect(rendered).toContain("feat/test next");
  });
});
