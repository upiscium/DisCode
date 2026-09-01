import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import {
  projectExistingSessionChoices,
  renderExistingSessions,
} from "../discord/existing-session.js";
import type {
  DiscoveredExistingSession,
  ExistingSessionDiscovery,
  ExistingSessionScope,
} from "../opencode/existing-session-discovery.js";

const MAX_REPLY_LENGTH = 1_900;
const FAILED = "Unable to inspect existing sessions right now.";
const UNKNOWN_HOST = "Unknown configured OpenCode host.";

export type ExistingSessionHostRuntime = Readonly<{
  id: string;
  authorizeDirectory: (directory: string) => Promise<string>;
}>;

export type ExistingSessionHosts = Readonly<{
  has: (id: string) => boolean;
  get: (id: string) => ExistingSessionHostRuntime;
  defaultHost: () => ExistingSessionHostRuntime;
}>;

export type ExistingSessionCommandRuntime = Pick<
  ExistingSessionRuntime,
  "handleSessionsCommand" | "handleBindAutocomplete" | "invalidateAutocomplete"
>;

type Discovery = Pick<ExistingSessionDiscovery, "discover">;

/** A small, scope-keyed cache used only by bind autocomplete. */
export class ExistingSessionAutocompleteCache {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<
    string,
    {
      promise: Promise<readonly DiscoveredExistingSession[]>;
      expiresAt: number;
      pending: boolean;
    }
  >();

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.#ttlMs = positiveInteger(options.ttlMs ?? 2_000, "ttlMs");
    this.#maxEntries = positiveInteger(options.maxEntries ?? 64, "maxEntries");
    this.#now = options.now ?? Date.now;
  }

  invalidate(scope: ExistingSessionScope): void {
    this.#entries.delete(JSON.stringify([scope.hostId, scope.canonicalDirectory]));
  }

  getOrDiscover(
    scope: ExistingSessionScope,
    discover: () => Promise<DiscoveredExistingSession[]>,
  ): Promise<readonly DiscoveredExistingSession[]> {
    const key = JSON.stringify([scope.hostId, scope.canonicalDirectory]);
    const current = this.#entries.get(key);
    if (current?.pending || (current && current.expiresAt > this.#now())) return current.promise;
    if (current) this.#entries.delete(key);
    while (this.#entries.size >= this.#maxEntries) {
      const evictable = [...this.#entries].find(([, entry]) => !entry.pending)?.[0];
      if (evictable === undefined) {
        return Promise.reject(new Error("Existing-session autocomplete capacity exceeded"));
      }
      this.#entries.delete(evictable);
    }

    const promise = Promise.resolve()
      .then(discover)
      .then((items) => normalize(items));
    const entry = { promise, expiresAt: Number.POSITIVE_INFINITY, pending: true };
    this.#entries.set(key, entry);
    void promise.then(
      () => {
        entry.pending = false;
        if (this.#entries.get(key) === entry) entry.expiresAt = this.#now() + this.#ttlMs;
      },
      () => {
        entry.pending = false;
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      },
    );
    return promise;
  }
}

export class ExistingSessionRuntime {
  readonly #hosts: ExistingSessionHosts;
  readonly #discovery: Discovery;
  readonly #cache: ExistingSessionAutocompleteCache;

  constructor(options: {
    hosts: ExistingSessionHosts;
    discovery: Discovery;
    cache?: ExistingSessionAutocompleteCache;
  }) {
    this.#hosts = options.hosts;
    this.#discovery = options.discovery;
    this.#cache = options.cache ?? new ExistingSessionAutocompleteCache();
  }

  async handleSessionsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const host = this.#host(interaction.options.getString("host"));
      if (!host) {
        await interaction.editReply(UNKNOWN_HOST);
        return;
      }
      const directory = interaction.options.getString("directory", true);
      const canonicalDirectory = await host.authorizeDirectory(directory);
      const scope = { hostId: host.id, canonicalDirectory };
      const sessions = await this.#discovery.discover(scope);
      await interaction.editReply(bound(renderExistingSessions(sessions)));
    } catch {
      await interaction.editReply(FAILED);
    }
  }

  async handleBindAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (!focused || typeof focused !== "object" || focused.name !== "session") {
      await interaction.respond([]);
      return;
    }
    try {
      const host = this.#host(interaction.options.getString("host"));
      if (!host) {
        await interaction.respond([]);
        return;
      }
      const directory = interaction.options.getString("directory") ?? "";
      if (!directory.trim()) {
        await interaction.respond([]);
        return;
      }
      const canonicalDirectory = await host.authorizeDirectory(directory);
      const scope = { hostId: host.id, canonicalDirectory };
      const sessions = await this.#cache.getOrDiscover(scope, () =>
        this.#discovery.discover(scope),
      );
      await interaction.respond(
        projectExistingSessionChoices(sessions, { ...scope, query: String(focused.value ?? "") }),
      );
    } catch {
      await interaction.respond([]);
    }
  }

  invalidateAutocomplete(scope: ExistingSessionScope): void {
    this.#cache.invalidate(scope);
  }

  #host(id: string | null): ExistingSessionHostRuntime | undefined {
    const selected = id?.trim();
    if (selected) {
      if (!this.#hosts.has(selected)) return undefined;
      return this.#hosts.get(selected);
    }
    return this.#hosts.defaultHost();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function normalize(items: DiscoveredExistingSession[]): readonly DiscoveredExistingSession[] {
  if (!Array.isArray(items)) throw new Error("invalid discovery result");
  return Object.freeze(
    items.map((item) =>
      Object.freeze({
        ...item,
        ...(item.model ? { model: Object.freeze({ ...item.model }) } : {}),
      }),
    ),
  );
}

function bound(value: string): string {
  if (value.length <= MAX_REPLY_LENGTH) return value;
  return `${value.slice(0, MAX_REPLY_LENGTH - 1)}…`;
}
