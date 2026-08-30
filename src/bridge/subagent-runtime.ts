import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import {
  renderSubagentChoiceLabel,
  renderSubagentDetail,
  renderSubagentList,
} from "../discord/subagent.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { SubagentRoot } from "../domain/subagent-graph.js";
import type { LoggerLike } from "../logging/logger.js";
import type {
  SubagentInspectionMetadata,
  SubagentInspector,
} from "../opencode/subagent-inspector.js";
import type { StateStore } from "../state/state-store.js";

const UNBOUND = "This is not a bound OpenCode thread.";
const CHANGED = "This thread's OpenCode binding changed; no data was displayed.";
const FAILED = "Unable to inspect subagents right now.";
const UNREACHABLE = "That subagent is no longer reachable.";
const MAX_CHOICES = 20;
const AUTOCOMPLETE_CACHE_TTL_MS = 1_500;
const MAX_AUTOCOMPLETE_CACHE_ENTRIES = 50;

type State = Pick<StateStore, "getByThread">;
type Inspector = Pick<
  SubagentInspector,
  "autocompleteDescendants" | "listDescendants" | "inspectDescendant"
>;

export type SubagentCommandRuntime = Pick<
  SubagentRuntime,
  "handleAutocomplete" | "handleDetailCommand" | "handleListCommand"
>;

export class SubagentRuntime {
  readonly #state: State;
  readonly #inspector: Inspector;
  readonly #logger: LoggerLike;
  readonly #now: () => number;
  readonly #autocompleteCache = new Map<
    string,
    {
      promise: ReturnType<Inspector["autocompleteDescendants"]>;
      expiresAt: number;
      pending: boolean;
    }
  >();

  constructor(options: {
    state: State;
    inspector: Inspector;
    logger: LoggerLike;
    now?: () => number;
  }) {
    this.#state = options.state;
    this.#inspector = options.inspector;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  async handleListCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const binding = bindingForInteraction(this.#state, interaction.channelId);
    if (!binding) {
      await interaction.reply({ content: UNBOUND, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await this.#inspector.listDescendants(rootFor(binding));
      if (!sameBinding(binding, this.#state.getByThread(interaction.channelId))) {
        await interaction.editReply(CHANGED);
        return;
      }
      await interaction.editReply(renderSubagentList(result));
    } catch (error) {
      this.logFailure(binding, "list", error);
      await interaction.editReply(FAILED);
    }
  }

  async handleDetailCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const binding = bindingForInteraction(this.#state, interaction.channelId);
    if (!binding) {
      await interaction.reply({ content: UNBOUND, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const childSessionId = interaction.options.getString("child", true).trim();
      const detail = await this.#inspector.inspectDescendant(rootFor(binding), childSessionId);
      if (!sameBinding(binding, this.#state.getByThread(interaction.channelId))) {
        await interaction.editReply(CHANGED);
        return;
      }
      if (!detail || !authorizedItem(detail, binding) || detail.id !== childSessionId) {
        await interaction.editReply(UNREACHABLE);
        return;
      }
      await interaction.editReply(renderSubagentDetail(detail));
    } catch (error) {
      this.logFailure(binding, "detail", error);
      await interaction.editReply(FAILED);
    }
  }

  async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const binding = bindingForInteraction(this.#state, interaction.channelId);
    if (!binding) {
      await interaction.respond([]);
      return;
    }

    try {
      const result = await this.#autocomplete(rootFor(binding));
      if (!sameBinding(binding, this.#state.getByThread(interaction.channelId))) {
        await interaction.respond([]);
        return;
      }
      const focused = interaction.options.getFocused(true);
      const query = String(
        typeof focused === "object" && focused !== null && "value" in focused
          ? focused.value
          : focused,
      )
        .trim()
        .toLocaleLowerCase();
      const choices = result.items
        .filter((item) => authorizedItem(item, binding))
        .map((item) => ({ item, label: renderSubagentChoiceLabel(item) }))
        .filter(
          ({ item, label }) =>
            (!query || `${label} ${item.id}`.toLocaleLowerCase().includes(query)) &&
            item.id.length <= 100,
        )
        .slice(0, MAX_CHOICES)
        .map(({ item, label }) => ({ name: label.slice(0, 100), value: item.id }));
      await interaction.respond(choices);
    } catch (error) {
      this.logFailure(binding, "autocomplete", error);
      await interaction.respond([]);
    }
  }

  #autocomplete(root: SubagentRoot): ReturnType<Inspector["autocompleteDescendants"]> {
    const key = JSON.stringify([root.hostId, root.directory, root.sessionId]);
    const cached = this.#autocompleteCache.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.promise;
    if (cached) this.#autocompleteCache.delete(key);
    while (this.#autocompleteCache.size >= MAX_AUTOCOMPLETE_CACHE_ENTRIES) {
      const evictable = [...this.#autocompleteCache].find(([, entry]) => !entry.pending)?.[0];
      if (!evictable) {
        return Promise.reject(new Error("Subagent autocomplete capacity exceeded"));
      }
      this.#autocompleteCache.delete(evictable);
    }

    const entry = {
      promise: this.#inspector.autocompleteDescendants(root),
      expiresAt: Number.POSITIVE_INFINITY,
      pending: true,
    };
    this.#autocompleteCache.set(key, entry);
    void entry.promise.then(
      () => {
        entry.pending = false;
        entry.expiresAt = this.#now() + AUTOCOMPLETE_CACHE_TTL_MS;
      },
      () => {
        entry.pending = false;
        if (this.#autocompleteCache.get(key) === entry) this.#autocompleteCache.delete(key);
      },
    );
    return entry.promise;
  }

  private logFailure(binding: SessionBinding, trigger: string, error: unknown): void {
    this.#logger.warn(
      "discord.subagent_inspection_failed",
      "Subagent inspection failed",
      {
        host_id: boundedId(binding.hostId),
        session_id: boundedId(binding.sessionId),
        thread_id: boundedId(binding.threadId),
        trigger,
      },
      error,
    );
  }
}

function boundedId(value: string): string {
  return value.slice(0, 128);
}

function rootFor(binding: SessionBinding): SubagentRoot {
  return { hostId: binding.hostId, directory: binding.directory, sessionId: binding.sessionId };
}

function bindingForInteraction(state: State, channelId: string): SessionBinding | undefined {
  const binding = state.getByThread(channelId);
  return binding?.threadId === channelId ? binding : undefined;
}

function sameBinding(expected: SessionBinding, current: SessionBinding | undefined): boolean {
  return (
    current !== undefined &&
    current.threadId === expected.threadId &&
    current.hostId === expected.hostId &&
    current.sessionId === expected.sessionId &&
    current.directory === expected.directory
  );
}

function authorizedItem(item: SubagentInspectionMetadata, binding: SessionBinding): boolean {
  return (
    item.hostId === binding.hostId &&
    item.directory === binding.directory &&
    item.rootSessionId === binding.sessionId
  );
}
