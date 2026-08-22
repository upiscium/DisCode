import type { Client, ThreadChannel } from "discord.js";
import { renderSessionHeader } from "../discord/session-header.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { OpenCodeGateway } from "../opencode/gateway.js";
import type { StateStore } from "../state/state-store.js";

export class SessionHeaderManager {
  readonly #discord: Client;
  readonly #state: StateStore;
  readonly #opencode: OpenCodeGateway;

  constructor(options: { discord: Client; state: StateStore; opencode: OpenCodeGateway }) {
    this.#discord = options.discord;
    this.#state = options.state;
    this.#opencode = options.opencode;
  }

  async createInitialHeader(binding: SessionBinding, thread: ThreadChannel): Promise<void> {
    const message = await thread.send({
      content: renderSessionHeader({ sessionId: binding.sessionId, directory: binding.directory }),
      allowedMentions: { parse: [] },
    });
    await this.#state.updateHeaderMessageId(binding.threadId, message.id);
  }

  async refreshSession(sessionId: string): Promise<void> {
    const binding = this.#state.getBySession(sessionId);
    if (!binding) return;

    const context = await this.#opencode.sessionHeaderContext(binding.directory, binding.sessionId);
    const content = renderSessionHeader({
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

  async refreshDirectory(directory: string): Promise<void> {
    for (const binding of this.#state.list()) {
      if (binding.directory !== directory) continue;
      await this.refreshSession(binding.sessionId);
    }
  }

  async reconcile(): Promise<void> {
    for (const binding of this.#state.list()) {
      await this.refreshSession(binding.sessionId);
    }
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}
