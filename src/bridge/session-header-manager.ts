import type { Client, ThreadChannel } from "discord.js";
import { renderSessionHeader } from "../discord/session-header.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { OpenCodeGateway } from "../opencode/gateway.js";
import type { StateStore } from "../state/state-store.js";

type HeaderGateway = Pick<OpenCodeGateway, "sessionHeaderContext">;

export class SessionHeaderManager {
  readonly #discord: Client;
  readonly #state: StateStore;
  readonly #gatewayFor: (hostId: string) => HeaderGateway;
  readonly #bindingMutationQueues = new Map<string, Promise<void>>();

  constructor(options: {
    discord: Client;
    state: StateStore;
    gatewayFor: (hostId: string) => HeaderGateway;
  }) {
    this.#discord = options.discord;
    this.#state = options.state;
    this.#gatewayFor = options.gatewayFor;
  }

  async createInitialHeader(binding: SessionBinding, thread: ThreadChannel): Promise<void> {
    await this.#runBindingMutation(binding.threadId, async () => {
      const current = this.#state.getByThread(binding.threadId);
      if (!current || !this.#sameBinding(current, binding) || current.headerMessageId) return;

      const message = await thread.send({
        content: renderSessionHeader({
          hostId: binding.hostId,
          sessionId: binding.sessionId,
          directory: binding.directory,
          ...(binding.model ? { preferenceModel: binding.model } : {}),
          ...(binding.agent ? { preferenceAgent: binding.agent } : {}),
        }),
        allowedMentions: { parse: [] },
      });
      const afterSend = this.#state.getByThread(binding.threadId);
      if (!afterSend || !this.#sameBinding(afterSend, binding) || afterSend.headerMessageId) {
        await message.delete().catch(() => undefined);
        return;
      }
      await this.#state.updateHeaderMessageId(binding.threadId, message.id);
    });
  }

  async refreshSession(hostId: string, sessionId: string): Promise<void> {
    const queuedFor = this.#state.getBySession(hostId, sessionId)?.threadId;
    if (!queuedFor) return;

    await this.#runBindingMutation(queuedFor, async () => {
      const binding = this.#state.getBySession(hostId, sessionId);
      if (!binding) return;

      const context = await this.#gatewayFor(hostId).sessionHeaderContext(
        binding.directory,
        binding.sessionId,
      );
      if (!this.#isCurrentBinding(binding)) return;

      const content = renderSessionHeader({
        hostId: binding.hostId,
        sessionId: binding.sessionId,
        directory: binding.directory,
        ...context,
        ...(binding.model ? { preferenceModel: binding.model } : {}),
        ...(binding.agent ? { preferenceAgent: binding.agent } : {}),
      });
      const thread = await this.#fetchThread(binding.threadId);
      if (!thread || !this.#isCurrentBinding(binding)) return;

      if (!binding.headerMessageId) {
        const created = await thread.send({ content, allowedMentions: { parse: [] } });
        if (!this.#isCurrentBinding(binding)) {
          await created.delete().catch(() => undefined);
          return;
        }
        await this.#state.updateHeaderMessageId(binding.threadId, created.id);
        return;
      }

      const message = await thread.messages.fetch(binding.headerMessageId);
      if (!this.#isCurrentBinding(binding)) return;
      if (message.content === content) return;
      await message.edit({ content, allowedMentions: { parse: [] } });
    });
  }

  #isCurrentBinding(binding: SessionBinding): boolean {
    const current = this.#state.getByThread(binding.threadId);
    return current !== undefined && this.#sameBinding(current, binding);
  }

  #sameBinding(left: SessionBinding, right: SessionBinding): boolean {
    return (
      left.threadId === right.threadId &&
      left.parentChannelId === right.parentChannelId &&
      left.hostId === right.hostId &&
      left.sessionId === right.sessionId &&
      left.directory === right.directory &&
      left.title === right.title &&
      left.createdBy === right.createdBy &&
      left.createdAt === right.createdAt &&
      left.model?.providerID === right.model?.providerID &&
      left.model?.modelID === right.model?.modelID &&
      left.agent === right.agent &&
      left.headerMessageId === right.headerMessageId
    );
  }

  async #runBindingMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#bindingMutationQueues.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#bindingMutationQueues.set(threadId, settled);
    try {
      return await current;
    } finally {
      if (this.#bindingMutationQueues.get(threadId) === settled) {
        this.#bindingMutationQueues.delete(threadId);
      }
    }
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}
