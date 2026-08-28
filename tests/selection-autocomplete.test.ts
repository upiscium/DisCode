import { describe, expect, it, vi } from "vitest";
import { selectionAutocomplete } from "../src/discord/selection-autocomplete.js";

function runtime(options: {
  canonical?: string;
  authorizeError?: Error;
  models?: Array<{
    providerID: string;
    modelID: string;
    providerName?: string;
    modelName?: string;
  }>;
  agents?: Array<{ name: string; description?: string; mode?: string }>;
}) {
  return {
    authorizeDirectory: vi.fn(async (_directory: string) => {
      if (options.authorizeError) throw options.authorizeError;
      return options.canonical ?? "/canonical/repo";
    }),
    gateway: {
      listModels: vi.fn(async (_directory: string) => options.models ?? []),
      listAgents: vi.fn(async (_directory: string) => options.agents ?? []),
    },
  };
}

function registry(hosts: Record<string, ReturnType<typeof runtime>>, defaultHostId = "adam") {
  return {
    has: (hostId: string) => hostId in hosts,
    get: (hostId: string) => hosts[hostId]!,
    defaultHost: () => hosts[defaultHostId]!,
  };
}

describe("selectionAutocomplete", () => {
  it("uses the default host and canonical directory for /oc start selection", async () => {
    const adam = runtime({
      canonical: "/srv/repo",
      models: [
        {
          providerID: "openrouter",
          modelID: "anthropic/claude-sonnet-4.6",
          modelName: "Claude Sonnet 4.6",
        },
      ],
    });

    await expect(
      selectionAutocomplete(registry({ adam }), {
        kind: "model",
        directory: "/requested/repo",
        query: "claude",
      }),
    ).resolves.toEqual([
      {
        name: "Claude Sonnet 4.6 · openrouter",
        value: "openrouter/anthropic/claude-sonnet-4.6",
      },
    ]);

    expect(adam.authorizeDirectory).toHaveBeenCalledWith("/requested/repo");
    expect(adam.gateway.listModels).toHaveBeenCalledWith("/srv/repo");
  });

  it("keeps host catalogs isolated", async () => {
    const adam = runtime({
      models: [{ providerID: "adam-provider", modelID: "adam-model" }],
    });
    const eve = runtime({
      canonical: "/eve/repo",
      models: [{ providerID: "eve-provider", modelID: "eve-model" }],
    });

    await expect(
      selectionAutocomplete(registry({ adam, eve }), {
        kind: "model",
        hostId: "eve",
        directory: "/repo",
      }),
    ).resolves.toEqual([{ name: "eve-provider/eve-model", value: "eve-provider/eve-model" }]);

    expect(adam.gateway.listModels).not.toHaveBeenCalled();
    expect(eve.gateway.listModels).toHaveBeenCalledWith("/eve/repo");
  });

  it("returns no candidates for missing, unknown-host, or unauthorized directories", async () => {
    const adam = runtime({
      authorizeError: new Error("outside allowed root"),
      models: [{ providerID: "provider", modelID: "model" }],
    });
    const hosts = registry({ adam });

    await expect(
      selectionAutocomplete(hosts, { kind: "model", directory: "" }),
    ).resolves.toEqual([]);
    await expect(
      selectionAutocomplete(hosts, { kind: "model", directory: "/repo", hostId: "missing" }),
    ).resolves.toEqual([]);
    await expect(
      selectionAutocomplete(hosts, { kind: "model", directory: "/outside" }),
    ).resolves.toEqual([]);

    expect(adam.gateway.listModels).not.toHaveBeenCalled();
  });

  it("filters agents and caps Discord responses at 25 choices", async () => {
    const adam = runtime({
      agents: Array.from({ length: 30 }, (_, index) => ({
        name: `review-${String(index).padStart(2, "0")}`,
        mode: "primary",
      })),
    });

    const result = await selectionAutocomplete(registry({ adam }), {
      kind: "agent",
      directory: "/repo",
      query: "review",
    });

    expect(result).toHaveLength(25);
    expect(result[0]).toEqual({ name: "review-00", value: "review-00" });
  });

  it("filters models by canonical ref and display metadata", async () => {
    const adam = runtime({
      models: [
        {
          providerID: "openrouter",
          providerName: "OpenRouter",
          modelID: "openai/gpt-5.6",
          modelName: "GPT 5.6",
        },
        { providerID: "local", modelID: "qwen3.5:9b" },
      ],
    });

    await expect(
      selectionAutocomplete(registry({ adam }), {
        kind: "model",
        directory: "/repo",
        query: "gpt",
      }),
    ).resolves.toEqual([
      { name: "GPT 5.6 · openrouter", value: "openrouter/openai/gpt-5.6" },
    ]);
  });

  it("fails closed when catalog retrieval fails and excludes overlong Discord values", async () => {
    const longModel = "x".repeat(101);
    const adam = runtime({
      models: [
        { providerID: "local", modelID: longModel },
        { providerID: "local", modelID: "usable" },
      ],
    });

    await expect(
      selectionAutocomplete(registry({ adam }), {
        kind: "model",
        directory: "/repo",
      }),
    ).resolves.toEqual([{ name: "local/usable", value: "local/usable" }]);

    adam.gateway.listModels.mockRejectedValueOnce(new Error("catalog unavailable"));
    await expect(
      selectionAutocomplete(registry({ adam }), {
        kind: "model",
        directory: "/repo",
      }),
    ).resolves.toEqual([]);
  });
});
