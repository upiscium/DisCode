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
    const message = await thread.send({
      content: renderSessionHeader({
        hostId: binding.hostId,
        sessionId: binding.sessionId,
        directory: binding.directory,
      }),
      allowedMentions: { parse: [] },
    });
    await this.#state.updateHeaderMessageId(binding.threadId, message.id);
  }

  async refreshSession(hostId: string, sessionId: string): Promise<void> {
    const binding = this.#state.getBySession(hostId, sessionId);
    if (!binding) return;

    const context = await this.#gatewayFor(hostId).sessionHeaderContext(
      binding.directory,
      binding.sessionId,
    );
    const content = renderSessionHeader({
      hostId: binding.hostId,
      sessionId: binding.sessionId,
      directory: binding.directory,
      ...context,
    });
    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;

    if (!binding.headerMessageId) {
      const created = await thread.send({ content, allowedMentions: { parse: [] } });
      await this.#state.updateHeaderMessageId(binding.threadId, created.id);
      return;
    }

    const message = await thread.messages.fetch(binding.headerMessageId);
    if (message.content === content) return;
    await message.edit({ content, allowedMentions: { parse: [] } });
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}
