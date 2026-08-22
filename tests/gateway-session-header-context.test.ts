import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  messages: vi.fn(),
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(() => ({
    session: {
      messages: mocks.messages,
    },
  })),
}));

import { OpenCodeGateway } from "../src/opencode/gateway.js";

beforeEach(() => {
  mocks.messages.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenCodeGateway session header context", () => {
  it("uses the latest user message for model/agent and OpenCode VCS for branch", async () => {
    mocks.messages.mockResolvedValue({
      data: [
        {
          info: {
            id: "msg_user_old",
            sessionID: "ses_1",
            role: "user",
            time: { created: 1 },
            agent: "plan",
            model: { providerID: "openai", modelID: "old-model" },
          },
          parts: [],
        },
        {
          info: {
            id: "msg_user_new",
            sessionID: "ses_1",
            role: "user",
            time: { created: 2 },
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5.6" },
          },
          parts: [],
        },
      ],
    });

    const fetchMock = vi.fn(
      async (_input: unknown) =>
        new Response(JSON.stringify({ branch: "feat/header", default_branch: "main" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
    });

    await expect(gateway.sessionHeaderContext("/repo", "ses_1")).resolves.toEqual({
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      branch: "feat/header",
    });

    expect(mocks.messages).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      query: { directory: "/repo", limit: 50 },
      throwOnError: true,
    });
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/vcs");
    expect(requestUrl.searchParams.get("directory")).toBe("/repo");
  });

  it("returns empty optional metadata before the first user message or outside git", async () => {
    mocks.messages.mockResolvedValue({ data: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: unknown) =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    await expect(gateway.sessionHeaderContext("/repo", "ses_new")).resolves.toEqual({});
  });
});
