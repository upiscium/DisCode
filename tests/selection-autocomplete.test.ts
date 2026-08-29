import { describe, expect, it, vi } from "vitest";
import {
  SelectionAutocompleteCatalogCache,
  selectionAutocomplete,
} from "../src/discord/selection-autocomplete.js";
import { validateOpenCodeSelection } from "../src/opencode/selection-validation.js";

function runtime(options: {
  canonical?: string | ((directory: string) => string);
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
    id: "test-host",
    authorizeDirectory: vi.fn(async (directory: string) => {
      if (options.authorizeError) throw options.authorizeError;
      if (typeof options.canonical === "function") return options.canonical(directory);
      return options.canonical ?? "/canonical/repo";
    }),
    gateway: {
      listModels: vi.fn(async (_directory: string) => options.models ?? []),
      listAgents: vi.fn(async (_directory: string) => options.agents ?? []),
    },
  };
}

function registry(hosts: Record<string, ReturnType<typeof runtime>>, defaultHostId = "adam") {
  for (const [hostId, host] of Object.entries(hosts)) host.id = hostId;
  const requireHost = (hostId: string) => {
    const host = hosts[hostId];
    if (!host) throw new Error(`Missing test host: ${hostId}`);
    return host;
  };
  return {
    has: (hostId: string) => hostId in hosts,
    get: requireHost,
    defaultHost: () => requireHost(defaultHostId),
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
    const hosts = registry({ adam, eve });

    await expect(
      selectionAutocomplete(hosts, {
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

    await expect(selectionAutocomplete(hosts, { kind: "model", directory: "" })).resolves.toEqual(
      [],
    );
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
    ).resolves.toEqual([{ name: "GPT 5.6 · openrouter", value: "openrouter/openai/gpt-5.6" }]);
  });

  it("reuses the normalized catalog within the short TTL", async () => {
    const adam = runtime({
      models: [
        { providerID: "local", modelID: "alpha" },
        { providerID: "local", modelID: "beta" },
      ],
    });
    const hosts = registry({ adam });

    await selectionAutocomplete(hosts, { kind: "model", directory: "/repo", query: "alpha" });
    await selectionAutocomplete(hosts, { kind: "model", directory: "/repo", query: "beta" });

    expect(adam.authorizeDirectory).toHaveBeenCalledTimes(2);
    expect(adam.gateway.listModels).toHaveBeenCalledTimes(1);
  });

  it("refetches after TTL expiry", async () => {
    let now = 0;
    const cache = new SelectionAutocompleteCatalogCache({ ttlMs: 10, now: () => now });
    const adam = runtime({ models: [{ providerID: "local", modelID: "model" }] });
    const hosts = registry({ adam });

    await selectionAutocomplete(hosts, { kind: "model", directory: "/repo" }, cache);
    await selectionAutocomplete(hosts, { kind: "model", directory: "/repo" }, cache);
    expect(adam.gateway.listModels).toHaveBeenCalledTimes(1);

    now = 10;
    await selectionAutocomplete(hosts, { kind: "model", directory: "/repo" }, cache);
    expect(adam.gateway.listModels).toHaveBeenCalledTimes(2);
  });

  it("separates cache entries by host, canonical directory, and catalog kind", async () => {
    const adam = runtime({
      canonical: (directory) => directory,
      models: [{ providerID: "local", modelID: "model" }],
      agents: [{ name: "build" }],
    });
    const eve = runtime({
      canonical: (directory) => directory,
      models: [{ providerID: "local", modelID: "model" }],
    });
    const hosts = registry({ adam, eve });

    await selectionAutocomplete(hosts, { kind: "model", hostId: "adam", directory: "/one" });
    await selectionAutocomplete(hosts, { kind: "model", hostId: "adam", directory: "/two" });
    await selectionAutocomplete(hosts, { kind: "agent", hostId: "adam", directory: "/one" });
    await selectionAutocomplete(hosts, { kind: "model", hostId: "eve", directory: "/one" });

    expect(adam.gateway.listModels).toHaveBeenCalledTimes(2);
    expect(adam.gateway.listAgents).toHaveBeenCalledTimes(1);
    expect(eve.gateway.listModels).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent identical catalog requests", async () => {
    let resolveModels: ((models: Array<{ providerID: string; modelID: string }>) => void) | undefined;
    const pending = new Promise<Array<{ providerID: string; modelID: string }>>((resolve) => {
      resolveModels = resolve;
    });
    const adam = runtime({});
    adam.gateway.listModels.mockImplementation(async () => pending);
    const hosts = registry({ adam });

    const first = selectionAutocomplete(hosts, { kind: "model", directory: "/repo" });
    const second = selectionAutocomplete(hosts, { kind: "model", directory: "/repo" });

    await vi.waitFor(() => expect(adam.gateway.listModels).toHaveBeenCalledTimes(1));
    resolveModels?.([{ providerID: "local", modelID: "model" }]);

    await expect(first).resolves.toEqual([{ name: "local/model", value: "local/model" }]);
    await expect(second).resolves.toEqual([{ name: "local/model", value: "local/model" }]);
    expect(adam.gateway.listModels).toHaveBeenCalledTimes(1);
  });

  it("bounds cached entries and refetches evicted keys", async () => {
    const cache = new SelectionAutocompleteCatalogCache({ maxEntries: 1 });
    const adam = runtime({
      canonical: (directory) => directory,
      models: [{ providerID: "local", modelID: "model" }],
    });
    const hosts = registry({ adam });

    await selectionAutocomplete(hosts, { kind: "model", directory: "/one" }, cache);
    await selectionAutocomplete(hosts, { kind: "model", directory: "/two" }, cache);
    await selectionAutocomplete(hosts, { kind: "model", directory: "/one" }, cache);

    expect(adam.gateway.listModels).toHaveBeenCalledTimes(3);
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

  it("never lets an autocomplete cache hit replace fresh execution-time validation", async () => {
    const cache = new SelectionAutocompleteCatalogCache();
    const adam = runtime({
      models: [{ providerID: "openrouter", modelID: "openai/gpt-5.6" }],
    });
    const hosts = registry({ adam });

    await expect(
      selectionAutocomplete(hosts, { kind: "model", directory: "/repo" }, cache),
    ).resolves.toEqual([
      { name: "openrouter/openai/gpt-5.6", value: "openrouter/openai/gpt-5.6" },
    ]);

    adam.gateway.listModels.mockResolvedValueOnce([]);
    await expect(
      validateOpenCodeSelection(adam.gateway, "/canonical/repo", {
        model: { providerID: "openrouter", modelID: "openai/gpt-5.6" },
      }),
    ).rejects.toThrow(/model is no longer available/);

    expect(adam.gateway.listModels).toHaveBeenCalledTimes(2);
  });
});
