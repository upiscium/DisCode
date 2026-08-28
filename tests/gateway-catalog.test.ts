import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeOpenCodeAgentCatalog,
  normalizeOpenCodeProviderCatalog,
  OpenCodeGateway,
  parseOpenCodeModelRef,
} from "../src/opencode/gateway.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenCode model and agent catalogs", () => {
  it("parses provider/model refs at the first slash and preserves slashes in model ids", () => {
    expect(parseOpenCodeModelRef("openrouter/anthropic/claude-sonnet-4.6")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4.6",
    });
    expect(parseOpenCodeModelRef("missing-separator")).toBeUndefined();
    expect(parseOpenCodeModelRef("/model")).toBeUndefined();
    expect(parseOpenCodeModelRef("provider/")).toBeUndefined();
  });

  it("normalizes only connected providers and preserves model ids containing slashes", () => {
    expect(
      normalizeOpenCodeProviderCatalog({
        all: [
          {
            id: "openrouter",
            name: "OpenRouter",
            models: {
              "anthropic/claude-sonnet-4.6": {
                id: "anthropic/claude-sonnet-4.6",
                name: "Claude Sonnet 4.6",
              },
            },
          },
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-opus-4-1": { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
            },
          },
        ],
        connected: ["openrouter"],
        default: { openrouter: "anthropic/claude-sonnet-4.6" },
      }),
    ).toEqual([
      {
        providerID: "openrouter",
        providerName: "OpenRouter",
        modelID: "anthropic/claude-sonnet-4.6",
        modelName: "Claude Sonnet 4.6",
      },
    ]);
  });

  it("supports provider model maps whose values omit the id", () => {
    expect(
      normalizeOpenCodeProviderCatalog({
        all: [{ id: "local", models: { "qwen3.5:9b": { name: "Qwen" } } }],
        connected: ["local"],
      }),
    ).toEqual([
      {
        providerID: "local",
        modelID: "qwen3.5:9b",
        modelName: "Qwen",
      },
    ]);
  });

  it("rejects malformed top-level provider catalog shapes", () => {
    expect(normalizeOpenCodeProviderCatalog([])).toBeUndefined();
    expect(normalizeOpenCodeProviderCatalog({ all: [], connected: [42] })).toBeUndefined();
  });

  it("normalizes visible primary-capable agents only", () => {
    expect(
      normalizeOpenCodeAgentCatalog([
        { name: "build", description: "Build mode", mode: "primary" },
        { name: "review", description: "Review mode", mode: "all" },
        { name: "explore", mode: "subagent" },
        { name: "internal", mode: "all", hidden: true },
      ]),
    ).toEqual([
      { name: "build", description: "Build mode", mode: "primary" },
      { name: "review", description: "Review mode", mode: "all" },
    ]);
  });

  it("requests model and agent catalogs with the canonical directory and Basic auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/provider?")) {
        return Response.json({
          all: [{ id: "openrouter", models: { "openai/gpt-5.6": { id: "openai/gpt-5.6" } } }],
          connected: ["openrouter"],
          default: { openrouter: "openai/gpt-5.6" },
        });
      }
      if (url.includes("/agent?")) {
        return Response.json([{ name: "build", mode: "primary" }]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "PASSWORD_SENTINEL",
    });

    await expect(gateway.listModels("/repo with space")).resolves.toEqual([
      { providerID: "openrouter", modelID: "openai/gpt-5.6" },
    ]);
    await expect(gateway.listAgents("/repo with space")).resolves.toEqual([
      { name: "build", mode: "primary" },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/directory=%2Frepo\+with\+space/);
      expect(call[1]).toMatchObject({
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from("opencode:PASSWORD_SENTINEL").toString("base64")}`,
        },
      });
    }
  });

  it("fails closed on malformed runtime catalog responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ all: [], connected: [42] })));
    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });
    await expect(gateway.listModels("/repo")).rejects.toThrow(/invalid response/);
  });
});
