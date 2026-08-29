import type {
  OpenCodeAgentCandidate,
  OpenCodeGateway,
  OpenCodeModelCandidate,
} from "../opencode/gateway.js";

export type SelectionAutocompleteKind = "model" | "agent";

export type SelectionAutocompleteChoice = {
  name: string;
  value: string;
};

type SelectionRuntime = {
  id: string;
  authorizeDirectory: (directory: string) => Promise<string>;
  gateway: Pick<OpenCodeGateway, "listModels" | "listAgents">;
};

type SelectionHostRegistry = {
  has: (hostId: string) => boolean;
  get: (hostId: string) => SelectionRuntime;
  defaultHost: () => SelectionRuntime;
};

type CachedSelectionCatalog =
  | {
      kind: "model";
      candidates: readonly OpenCodeModelCandidate[];
    }
  | {
      kind: "agent";
      candidates: readonly OpenCodeAgentCandidate[];
    };

type CacheEntry = {
  expiresAt: number;
  catalog: CachedSelectionCatalog;
};

const DEFAULT_CACHE_TTL_MS = 3_000;
const DEFAULT_CACHE_MAX_ENTRIES = 128;
const defaultCaches = new WeakMap<SelectionHostRegistry, SelectionAutocompleteCatalogCache>();

export class SelectionAutocompleteCatalogCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<CachedSelectionCatalog>>();

  constructor(
    options: {
      ttlMs?: number;
      maxEntries?: number;
      now?: () => number;
    } = {},
  ) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;

    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error("Selection autocomplete cache TTL must be positive");
    }
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new Error("Selection autocomplete cache max entries must be a positive integer");
    }
  }

  async get(
    runtime: SelectionRuntime,
    directory: string,
    kind: SelectionAutocompleteKind,
  ): Promise<CachedSelectionCatalog> {
    const key = JSON.stringify([runtime.id, directory, kind]);
    const now = this.#now();
    this.#pruneExpired(now);

    const cached = this.#entries.get(key);
    if (cached && cached.expiresAt > now) return cached.catalog;

    const existing = this.#inFlight.get(key);
    if (existing) return existing;

    const request = this.#fetch(runtime, directory, kind)
      .then((catalog) => {
        this.#entries.set(key, {
          expiresAt: this.#now() + this.#ttlMs,
          catalog,
        });
        this.#trimEntries();
        return catalog;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, request);
    return request;
  }

  async #fetch(
    runtime: SelectionRuntime,
    directory: string,
    kind: SelectionAutocompleteKind,
  ): Promise<CachedSelectionCatalog> {
    if (kind === "model") {
      return {
        kind,
        candidates: [...(await runtime.gateway.listModels(directory))],
      };
    }

    return {
      kind,
      candidates: [...(await runtime.gateway.listAgents(directory))],
    };
  }

  #pruneExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  #trimEntries(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.#entries.delete(oldestKey);
    }
  }
}

export async function selectionAutocomplete(
  hosts: SelectionHostRegistry,
  request: {
    kind: SelectionAutocompleteKind;
    directory: string;
    hostId?: string;
    query?: string;
  },
  cache: SelectionAutocompleteCatalogCache = cacheFor(hosts),
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
    const catalog = await cache.get(runtime, directory, request.kind);
    if (catalog.kind === "model") {
      return catalog.candidates
        .filter((candidate) => matchesModel(candidate, query))
        .map(modelChoice)
        .filter((choice): choice is SelectionAutocompleteChoice => choice !== undefined)
        .slice(0, 25);
    }

    return catalog.candidates
      .filter((candidate) => !query || candidate.name.toLocaleLowerCase().includes(query))
      .filter((candidate) => candidate.name.length <= 100)
      .map((candidate) => ({ name: candidate.name.slice(0, 100), value: candidate.name }))
      .slice(0, 25);
  } catch {
    return [];
  }
}

function cacheFor(hosts: SelectionHostRegistry): SelectionAutocompleteCatalogCache {
  const existing = defaultCaches.get(hosts);
  if (existing) return existing;
  const cache = new SelectionAutocompleteCatalogCache();
  defaultCaches.set(hosts, cache);
  return cache;
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
