import { REST, Routes } from "discord.js";
import { renderAssistantResult } from "../discord/format.js";
import {
  deliverCanonicalAssistantResult,
  renderAssistantStreamingPreview,
} from "../discord/streaming.js";
import type { OpenCodeEvent, OpenCodeGateway } from "../opencode/gateway.js";
import type { StateStore } from "../state/state-store.js";
import { AssistantTextStreamBuffer, CoalescedSessionFlusher } from "./assistant-stream.js";

type PreviewState = {
  messageId: string;
  content: string;
};

type StreamingStateStore = Pick<StateStore, "getBySession" | "updateLastPublished">;

export type DiscordMessageTransport = {
  post(route: string, options: { body: { content: string } }): Promise<unknown>;
  patch(route: string, options: { body: { content: string } }): Promise<unknown>;
};

export class AssistantStreamingPublisher {
  readonly #enabled: boolean;
  readonly #state: StreamingStateStore;
  readonly #rest: DiscordMessageTransport;
  readonly #buffer = new AssistantTextStreamBuffer();
  readonly #flusher: CoalescedSessionFlusher;
  readonly #previews = new Map<string, PreviewState>();

  constructor(options: {
    enabled: boolean;
    discordToken: string;
    state: StreamingStateStore;
    flushIntervalMs?: number;
    transport?: DiscordMessageTransport;
  }) {
    this.#enabled = options.enabled;
    this.#state = options.state;
    this.#rest = options.transport ?? new REST({ version: "10" }).setToken(options.discordToken);
    this.#flusher = new CoalescedSessionFlusher(
      options.flushIntervalMs ?? 1000,
      (sessionId, error) => {
        console.error(`Discord streaming preview failed for ${sessionId}`, error);
      },
    );
  }

  async handleEvent(
    event: OpenCodeEvent,
    gateway: Pick<OpenCodeGateway, "latestAssistantResult">,
  ): Promise<void> {
    if (!this.#enabled) return;

    switch (event.type) {
      case "message.updated": {
        const sessionId = event.properties.sessionID;
        if (!this.#state.getBySession(sessionId)) return;
        this.#buffer.observeMessage({
          sessionId,
          messageId: event.properties.info.id,
          role: event.properties.info.role,
        });
        return;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        if (!this.#state.getBySession(part.sessionID)) return;
        const changed = this.#buffer.observePart({
          sessionId: part.sessionID,
          messageId: part.messageID,
          partId: part.id,
          type: part.type,
          ...(part.type === "text" ? { text: part.text } : {}),
        });
        if (changed) this.#requestFlush(part.sessionID);
        return;
      }
      case "message.part.delta": {
        const properties = event.properties;
        if (!this.#state.getBySession(properties.sessionID)) return;
        const changed = this.#buffer.appendDelta({
          sessionId: properties.sessionID,
          messageId: properties.messageID,
          partId: properties.partID,
          field: properties.field,
          delta: properties.delta,
        });
        if (changed) this.#requestFlush(properties.sessionID);
        return;
      }
      case "session.idle":
        await this.#finalize(event.properties.sessionID, gateway);
        return;
      default:
        return;
    }
  }

  stop(): void {
    this.#flusher.cancelAll();
    this.#previews.clear();
  }

  #requestFlush(sessionId: string): void {
    this.#flusher.request(sessionId, async () => this.#flushPreview(sessionId));
  }

  async #flushPreview(sessionId: string): Promise<void> {
    const binding = this.#state.getBySession(sessionId);
    const snapshot = this.#buffer.snapshot(sessionId);
    if (!binding || !snapshot) return;

    const content = renderAssistantStreamingPreview(snapshot.text);
    const preview = this.#previews.get(sessionId);
    if (preview) {
      if (preview.content === content) return;
      await this.#rest.patch(Routes.channelMessage(binding.threadId, preview.messageId), {
        body: { content },
      });
      preview.content = content;
      return;
    }

    const created = await this.#rest.post(Routes.channelMessages(binding.threadId), {
      body: { content },
    });
    if (!isRecord(created) || typeof created.id !== "string") {
      throw new Error("Discord create-message response did not include an id");
    }
    this.#previews.set(sessionId, { messageId: created.id, content });
  }

  async #finalize(
    sessionId: string,
    gateway: Pick<OpenCodeGateway, "latestAssistantResult">,
  ): Promise<void> {
    this.#flusher.cancel(sessionId);
    const preview = this.#previews.get(sessionId);
    if (!preview) {
      this.#buffer.clearSession(sessionId);
      return;
    }

    try {
      const binding = this.#state.getBySession(sessionId);
      if (!binding) return;
      const result = await gateway.latestAssistantResult(binding.directory, sessionId);
      if (!result || result.messageId === binding.lastPublishedAssistantMessageId) return;

      const rendered = renderAssistantResult(result.parts);
      await deliverCanonicalAssistantResult({
        rendered,
        send: async (content) =>
          this.#rest.post(Routes.channelMessages(binding.threadId), { body: { content } }),
        editPreview: async (content) =>
          this.#rest.patch(Routes.channelMessage(binding.threadId, preview.messageId), {
            body: { content },
          }),
        onPreviewEditError: (error) => {
          console.error(`Failed to promote streaming preview for ${sessionId}`, error);
        },
      });

      await this.#state.updateLastPublished(binding.threadId, result.messageId);
    } finally {
      this.#buffer.clearSession(sessionId);
      this.#previews.delete(sessionId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
