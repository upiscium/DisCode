import { describe, expect, it } from "vitest";
import { renderSessionHeader } from "../src/discord/session-header.js";

describe("session header rendering", () => {
  it("renders host, model, agent, and branch metadata", () => {
    const rendered = renderSessionHeader({
      hostId: "lab",
      sessionId: "ses_test",
      directory: "/repo",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      agent: "build",
      branch: "feat/header",
    });

    expect(rendered).toContain("Host: `lab`");
    expect(rendered).toContain("Session: `ses_test`");
    expect(rendered).toContain("Directory: `/repo`");
    expect(rendered).toContain("Model: `openai/gpt-5.6`");
    expect(rendered).toContain("Agent: `build`");
    expect(rendered).toContain("Branch: `feat/header`");
    expect(rendered).toContain("Messages posted in this thread are sent to OpenCode.");
  });

  it("renders explicit placeholders before a model, agent, or branch is known", () => {
    const rendered = renderSessionHeader({
      hostId: "local",
      sessionId: "ses_new",
      directory: "/repo",
    });

    expect(rendered).toContain("Model: `(not selected)`");
    expect(rendered).toContain("Agent: `(not selected)`");
    expect(rendered).toContain("Branch: `(none)`");
  });

  it("neutralizes inline-code delimiters and newlines", () => {
    const rendered = renderSessionHeader({
      hostId: "lab",
      sessionId: "ses_`test",
      directory: "/repo\nnext",
      agent: "build`agent",
      branch: "feat/test\nnext",
    });

    expect(rendered).not.toContain("ses_`test");
    expect(rendered).not.toContain("/repo\nnext");
    expect(rendered).toContain("ses_ˋtest");
    expect(rendered).toContain("/repo next");
    expect(rendered).toContain("buildˋagent");
    expect(rendered).toContain("feat/test next");
  });
});
