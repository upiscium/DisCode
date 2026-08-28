import type {
  OpenCodeGateway,
  OpenCodeModelSelection,
  OpenCodePromptContext,
} from "./gateway.js";

export type OpenCodeSelectionPreference = {
  model?: OpenCodeModelSelection;
  agent?: string;
};

type SelectionGateway = Pick<OpenCodeGateway, "listModels" | "listAgents">;

export async function validateOpenCodeSelection(
  gateway: SelectionGateway,
  directory: string,
  preference: OpenCodeSelectionPreference,
): Promise<OpenCodePromptContext> {
  const context: OpenCodePromptContext = {};

  if (preference.model) {
    const models = await gateway.listModels(directory);
    const available = models.some(
      (candidate) =>
        candidate.providerID === preference.model?.providerID &&
        candidate.modelID === preference.model?.modelID,
    );
    if (!available) {
      throw new Error(
        `Selected OpenCode model is no longer available: ${preference.model.providerID}/${preference.model.modelID}`,
      );
    }
    context.model = { ...preference.model };
  }

  if (preference.agent) {
    const agents = await gateway.listAgents(directory);
    const available = agents.some((candidate) => candidate.name === preference.agent);
    if (!available) {
      throw new Error(`Selected OpenCode agent is no longer available: ${preference.agent}`);
    }
    context.agent = preference.agent;
  }

  return context;
}
