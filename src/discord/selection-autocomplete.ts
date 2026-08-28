import type { OpenCodeGateway, OpenCodeModelCandidate } from "../opencode/gateway.js";

export type SelectionAutocompleteKind = "model" | "agent";

export type SelectionAutocompleteChoice = {
  name: string;
  value: string;
};

type SelectionRuntime = {
  authorizeDirectory: (directory: string) => Promise<string>;
  gateway: Pick<OpenCodeGateway, "listModels" | "listAgents">;
};

type SelectionHostRegistry = {
  has: (hostId: string) => boolean;
  get: (hostId: string) => SelectionRuntime;
  defaultHost: () => SelectionRuntime;
};

export async function selectionAutocomplete(
  hosts: SelectionHostRegistry,
  request: {
    kind: SelectionAutocompleteKind;
    directory: string;
    hostId?: string;
    query?: string;
  },
): Promise<SelectionAutocompleteChoice[]> {
  const requestedDirectory = request.directory.trim();
  if (!requestedDirectory) return [];

  const requestedHostId = request.hostId?.trim();
  if (requestedHostId && !hosts.has(requestedHostId)) return [];
  const runtime = requestedHostId ? hosts.get(requestedHostId) : hosts.defaultHost();

  let directory: string;
  try {
    directory = await runtime.authorizeDirectory(requestedDirectory);
  } catch {
    return [];
  }

  const query = request.query?.trim().toLocaleLowerCase() ?? "";
  try {
    if (request.kind === "model") {
      return (await runtime.gateway.listModels(directory))
        .filter((candidate) => matchesModel(candidate, query))
        .map(modelChoice)
        .filter((choice): choice is SelectionAutocompleteChoice => choice !== undefined)
        .slice(0, 25);
    }

    return (await runtime.gateway.listAgents(directory))
      .filter((candidate) => !query || candidate.name.toLocaleLowerCase().includes(query))
      .filter((candidate) => candidate.name.length <= 100)
      .map((candidate) => ({ name: candidate.name.slice(0, 100), value: candidate.name }))
      .slice(0, 25);
  } catch {
    return [];
  }
}

function matchesModel(candidate: OpenCodeModelCandidate, query: string): boolean {
  if (!query) return true;
  return [
    `${candidate.providerID}/${candidate.modelID}`,
    candidate.providerName,
    candidate.modelName,
  ].some((value) => value?.toLocaleLowerCase().includes(query));
}

function modelChoice(candidate: OpenCodeModelCandidate): SelectionAutocompleteChoice | undefined {
  const value = `${candidate.providerID}/${candidate.modelID}`;
  if (value.length > 100) return undefined;
  const label = candidate.modelName ? `${candidate.modelName} · ${candidate.providerID}` : value;
  return { name: label.slice(0, 100), value };
}
