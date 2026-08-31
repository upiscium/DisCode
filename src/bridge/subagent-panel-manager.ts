import type { Client, ThreadChannel } from "discord.js";
import { renderSubagentList } from "../discord/subagent.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { SubagentInspectionList, SubagentInspector } from "../opencode/subagent-inspector.js";
import type { StateStore } from "../state/state-store.js";

type Inspector = Pick<SubagentInspector, "listDescendants">;
type State = Pick<StateStore, "getByThread" | "updateSubagentPanelMessageId">;

export class SubagentPanelManager {
  readonly #discord: Client;
  readonly #state: State;
  readonly #inspector: Inspector;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: { discord: Client; state: State; inspector: Inspector }) {
    this.#discord = options.discord;
    this.#state = options.state;
    this.#inspector = options.inspector;
  }

  async refreshBinding(binding: SessionBinding): Promise<SubagentInspectionList | undefined> {
    return this.runExclusive(binding.threadId, async () => {
      if (!this.#isCurrentBinding(binding)) return undefined;

      // Keep the inspector rooted in the captured authority, not a later state value.
      const list = await this.#inspector.listDescendants({
        hostId: binding.hostId,
        directory: binding.directory,
        sessionId: binding.sessionId,
      });
      if (!this.#isCurrentBinding(binding)) return undefined;

      const content = renderSubagentList(list);
      const thread = await this.#fetchThread(binding.threadId);
      const currentAfterThread = this.#currentBinding(binding);
      if (!thread || !currentAfterThread) return undefined;

      const existing = await this.#fetchManagedMessage(currentAfterThread, thread);
      if (!this.#isCurrentBinding(binding)) return undefined;

      if (!existing) {
        if (!this.#isCurrentBinding(binding)) return undefined;
        const created = await thread.send({ content, allowedMentions: { parse: [] } });
        if (!this.#isCurrentBinding(binding)) return undefined;
        await this.#state.updateSubagentPanelMessageId(binding.threadId, created.id);
        return this.#isCurrentBinding(binding) ? list : undefined;
      }

      if (existing.content === content) return this.#isCurrentBinding(binding) ? list : undefined;
      if (!this.#isCurrentBinding(binding)) return undefined;
      await existing.edit({ content, allowedMentions: { parse: [] } });
      return this.#isCurrentBinding(binding) ? list : undefined;
    });
  }

  runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(threadId);
    const queued = (previous ?? Promise.resolve()).then(operation, operation);
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(threadId, settled);
    void settled.then(() => {
      if (this.#queues.get(threadId) === settled) this.#queues.delete(threadId);
    });
    return queued;
  }

  #isCurrentBinding(binding: SessionBinding): boolean {
    return this.#currentBinding(binding) !== undefined;
  }

  #currentBinding(binding: SessionBinding): SessionBinding | undefined {
    const current = this.#state.getByThread(binding.threadId);
    return current &&
      current.threadId === binding.threadId &&
      current.hostId === binding.hostId &&
      current.sessionId === binding.sessionId &&
      current.directory === binding.directory
      ? current
      : undefined;
  }

  async #fetchManagedMessage(binding: SessionBinding, thread: ThreadChannel) {
    if (!binding.subagentPanelMessageId) return undefined;
    try {
      return await thread.messages.fetch(binding.subagentPanelMessageId);
    } catch (error) {
      if (isUnknownMessage(error)) return undefined;
      throw error;
    }
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}

function isUnknownMessage(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 10008;
}
