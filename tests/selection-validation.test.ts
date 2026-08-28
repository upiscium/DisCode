import { describe, expect, it, vi } from "vitest";
import { validateOpenCodeSelection } from "../src/opencode/selection-validation.js";

function gateway(options: {
  models?: Array<{ providerID: string; modelID: string }>;
  agents?: Array<{ name: string }>;
}) {
  return {
    listModels: vi.fn(async (_directory: string) => options.models ?? []),
    listAgents: vi.fn(async (_directory: string) => options.agents ?? []),
  };
}

describe("validateOpenCodeSelection", () => {
  it("does not query catalogs when no explicit selection exists", async () => {
    const api = gateway({});

    await expect(validateOpenCodeSelection(api, "/repo", {})).resolves.toEqual({});
    expect(api.listModels).not.toHaveBeenCalled();
    expect(api.listAgents).not.toHaveBeenCalled();
  });

  it("returns the exact current model and agent selection", async () => {
    const api = gateway({
      models: [{ providerID: "openrouter", modelID: "openai/gpt-5.6" }],
      agents: [{ name: "build" }],
    });

    await expect(
      validateOpenCodeSelection(api, "/canonical/repo", {
        model: { providerID: "openrouter", modelID: "openai/gpt-5.6" },
        agent: "build",
      }),
    ).resolves.toEqual({
      model: { providerID: "openrouter", modelID: "openai/gpt-5.6" },
      agent: "build",
    });
    expect(api.listModels).toHaveBeenCalledWith("/canonical/repo");
    expect(api.listAgents).toHaveBeenCalledWith("/canonical/repo");
  });

  it("fails closed instead of silently falling back when a model becomes stale", async () => {
    const api = gateway({
      models: [{ providerID: "local", modelID: "qwen3.5:9b" }],
    });

    await expect(
      validateOpenCodeSelection(api, "/repo", {
        model: { providerID: "openrouter", modelID: "openai/gpt-5.6" },
      }),
    ).rejects.toThrow(/model is no longer available/);
  });

  it("fails closed instead of silently falling back when an agent becomes stale", async () => {
    const api = gateway({ agents: [{ name: "build" }] });

    await expect(validateOpenCodeSelection(api, "/repo", { agent: "review" })).rejects.toThrow(
      /agent is no longer available/,
    );
  });
});
