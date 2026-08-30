import type { Client, ThreadChannel } from "discord.js";
import { renderTodoPanel } from "../discord/todo.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { OpenCodeTodoGateway, OpenCodeTodoItem } from "../opencode/todo-gateway.js";
import type { StateStore } from "../state/state-store.js";

type TodoGateway = Pick<OpenCodeTodoGateway, "listTodos">;

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

  readonly #queues = new Map<string, Promise<void>>();

  async refreshSession(hostId: string, sessionId: string): Promise<void> {
    const binding = this.#state.getBySession(hostId, sessionId);
    if (!binding) return;

    return this.#enqueue(binding.threadId, async () => {
      const currentBinding = this.#state.getByThread(binding.threadId);
      if (
        !currentBinding ||
        currentBinding.hostId !== hostId ||
        currentBinding.sessionId !== sessionId ||
        currentBinding.directory !== binding.directory
      ) {
        return;
      }
      const todos = await this.#gatewayFor(currentBinding.hostId).listTodos(
        currentBinding.directory,
        currentBinding.sessionId,
      );
      await this.#publish(currentBinding, todos);
    });
  }

  async updateFromEvent(
    hostId: string,
    eventDirectory: string,
    sessionID: string,
    todos: readonly OpenCodeTodoItem[],
  ): Promise<void> {
    const binding = this.#state.getBySession(hostId, sessionID);
    if (!binding || binding.hostId !== hostId || binding.sessionId !== sessionID) return;
    if (binding.directory !== eventDirectory) return;

    return this.#enqueue(binding.threadId, async () => {
      const currentBinding = this.#state.getByThread(binding.threadId);
      if (!currentBinding || currentBinding.hostId !== hostId) return;
      if (currentBinding.sessionId !== sessionID || currentBinding.directory !== eventDirectory) {
        return;
      }
      await this.#publish(currentBinding, todos);
    });
  }

  runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(threadId, operation);
  }

  async #publish(binding: SessionBinding, todos: readonly OpenCodeTodoItem[]): Promise<void> {
    const content = renderTodoPanel(todos);
    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;
    if (!this.#isCurrentBinding(binding)) return;

    const existing = await this.#fetchManagedMessage(binding, thread);
    if (!this.#isCurrentBinding(binding)) return;
    if (!existing) {
      const created = await thread.send({ content, allowedMentions: { parse: [] } });
      await this.#state.updateTodoMessageId(binding.threadId, created.id);
      return;
    }

    if (existing.content === content) return;
    await existing.edit({ content, allowedMentions: { parse: [] } });
  }

  #isCurrentBinding(binding: SessionBinding): boolean {
    const current = this.#state.getByThread(binding.threadId);
    return Boolean(
      current &&
        current.hostId === binding.hostId &&
        current.sessionId === binding.sessionId &&
        current.directory === binding.directory,
    );
  }

  async #fetchManagedMessage(binding: SessionBinding, thread: ThreadChannel) {
    if (!binding.todoMessageId) return undefined;
    try {
      return await thread.messages.fetch(binding.todoMessageId);
    } catch (error) {
      if (isUnknownMessage(error)) return undefined;
      throw error;
    }
  }

  #enqueue<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(threadId);
    const queued = (previous ? previous : Promise.resolve()).then(operation, operation);
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

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}

function isUnknownMessage(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 10008;
}
