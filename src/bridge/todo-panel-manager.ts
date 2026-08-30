import type { Client, ThreadChannel } from "discord.js";
import { renderTodoPanel } from "../discord/todo.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { OpenCodeGateway, OpenCodeTodoItem } from "../opencode/gateway.js";
import type { StateStore } from "../state/state-store.js";

type TodoGateway = Pick<OpenCodeGateway, "listTodos">;

export class TodoPanelManager {
  readonly #discord: Client;
  readonly #state: StateStore;
  readonly #gatewayFor: (hostId: string) => TodoGateway;

  constructor(options: {
    discord: Client;
    state: StateStore;
    gatewayFor: (hostId: string) => TodoGateway;
  }) {
    this.#discord = options.discord;
    this.#state = options.state;
    this.#gatewayFor = options.gatewayFor;
  }

  async refreshSession(
    hostId: string,
    sessionId: string,
    currentTodos?: readonly OpenCodeTodoItem[],
  ): Promise<void> {
    const binding = this.#state.getBySession(hostId, sessionId);
    if (!binding) return;

    const todos =
      currentTodos ??
      (await this.#gatewayFor(hostId).listTodos(binding.directory, binding.sessionId));
    const content = renderTodoPanel(todos);
    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;

    const existing = await this.#fetchManagedMessage(binding, thread);
    if (!existing) {
      const created = await thread.send({ content, allowedMentions: { parse: [] } });
      await this.#state.updateTodoMessageId(binding.threadId, created.id);
      return;
    }

    if (existing.content === content) return;
    await existing.edit({ content, allowedMentions: { parse: [] } });
  }

  async #fetchManagedMessage(binding: SessionBinding, thread: ThreadChannel) {
    if (!binding.todoMessageId) return undefined;
    return thread.messages.fetch(binding.todoMessageId).catch(() => undefined);
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}
