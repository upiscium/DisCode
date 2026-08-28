import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  promptAsync: vi.fn(async () => ({ data: undefined })),
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(() => ({
    session: {
      promptAsync: mocks.promptAsync,
    },
  })),
}));

import { OpenCodeGateway } from "../src/opencode/gateway.js";

beforeEach(() => {
  mocks.promptAsync.mockClear();
});

describe("OpenCodeGateway prompt file parts", () => {
  it("preserves the existing text-only prompt path", async () => {
    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    await gateway.promptAsync("/repo", "ses_1", "hello");

    expect(mocks.promptAsync).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      query: { directory: "/repo" },
      body: { parts: [{ type: "text", text: "hello" }] },
      throwOnError: true,
    });
  });

  it("propagates explicit model and agent context for text prompts", async () => {
    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    await gateway.promptAsync("/repo", "ses_1", "hello", {
      model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.6" },
      agent: "plan",
    });

    expect(mocks.promptAsync).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      query: { directory: "/repo" },
      body: {
        model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.6" },
        agent: "plan",
        parts: [{ type: "text", text: "hello" }],
      },
      throwOnError: true,
    });
  });

  it("sends text and FilePart inputs in one prompt", async () => {
    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    await gateway.promptAsyncWithFiles("/repo", "ses_1", "inspect this", [
      {
        mime: "image/png",
        filename: "screen.png",
        url: "data:image/png;base64,iVBORw0KGgo=",
      },
      {
        mime: "text/plain",
        filename: "notes.md",
        url: "data:text/plain;base64,aGVsbG8=",
      },
    ]);

    expect(mocks.promptAsync).toHaveBeenCalledWith({
      path: { id: "ses_1" },
      query: { directory: "/repo" },
      body: {
        parts: [
          { type: "text", text: "inspect this" },
          {
            type: "file",
            mime: "image/png",
            filename: "screen.png",
            url: "data:image/png;base64,iVBORw0KGgo=",
          },
          {
            type: "file",
            mime: "text/plain",
            filename: "notes.md",
            url: "data:text/plain;base64,aGVsbG8=",
          },
        ],
      },
      throwOnError: true,
    });
  });

  it("propagates selection context for attachment prompts", async () => {
    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    await gateway.promptAsyncWithFiles(
      "/repo",
      "ses_1",
      "inspect this",
      [
        {
          mime: "image/png",
          filename: "screen.png",
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      {
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        agent: "build",
      },
    );

    expect(mocks.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
          agent: "build",
          parts: [
            { type: "text", text: "inspect this" },
            {
              type: "file",
              mime: "image/png",
              filename: "screen.png",
              url: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
      }),
    );
  });

  it("supports attachment-only prompts and rejects an empty prompt", async () => {
    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    await gateway.promptAsyncWithFiles("/repo", "ses_1", "", [
      {
        mime: "application/pdf",
        filename: "spec.pdf",
        url: "data:application/pdf;base64,JVBERi0=",
      },
    ]);
    expect(mocks.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          parts: [
            {
              type: "file",
              mime: "application/pdf",
              filename: "spec.pdf",
              url: "data:application/pdf;base64,JVBERi0=",
            },
          ],
        },
      }),
    );

    await expect(gateway.promptAsyncWithFiles("/repo", "ses_1", "   ", [])).rejects.toThrow(
      /must contain text or at least one file/,
    );
  });
});
