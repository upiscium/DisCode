import { REST, Routes } from "discord.js";
import { renderToolActivitySummary, safeToolAnnotation } from "../discord/tool-summary.js";
import type { OpenCodeEvent, OpenCodeGateway } from "../opencode/gateway.js";
import type { StateStore } from "../state/state-store.js";
import { CoalescedSessionFlusher } from "./assistant-stream.js";
import { ToolActivityBuffer } from "./tool-activity.js";

type ToolSummaryStateStore = Pick<StateStore, "getBySession">;

type SummaryMessageState = {
  assistantMessageId: string;
  discordMessageId: string;
  content: string;
};

export type ToolSummaryTransport = {
  post(route: string, options: { body: { content: string } }): Promise<unknown>;
  patch(route: string, options: { body: { content: string } }): Promise<unknown>;
};

export class ToolSummaryPublisher {
  readonly #enabled: boolean;
  readonly #state: ToolSummaryStateStore;
  readonly #rest: ToolSummaryTransport;
  readonly #buffer = new ToolActivityBuffer();
  readonly #flusher: CoalescedSessionFlusher;
  readonly #messages = new Map<string, SummaryMessageState>();

  constructor(options: {
    enabled: boolean;
    discordToken: string;
    state: ToolSummaryStateStore;
    flushIntervalMs?: number;
    transport?: ToolSummaryTransport;
  }) {
    this.#enabled = options.enabled;
    this.#state = options.state;
    this.#rest = options.transport ?? new REST({ version: "10" }).setToken(options.discordToken);
    this.#flusher = new CoalescedSessionFlusher(
      options.flushIntervalMs ?? 1000,
      (sessionId, error) => {
        console.error(`Discord tool summary failed for ${sessionId}`, error);
      },
    );
  }

  async handleEvent(
    event: OpenCodeEvent,
    _gateway: Pick<OpenCodeGateway, "latestAssistantResult">,
  ): Promise<void> {
    if (!this.#enabled) return;

    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info;
        if (info.role !== "assistant" || !this.#state.getBySession(info.sessionID)) return;
        if (this.#buffer.currentMessageId(info.sessionID) !== info.id) {
          await this.#flusher.cancelAndDrain(info.sessionID);
          this.#messages.delete(info.sessionID);
          this.#buffer.startAssistantMessage(info.sessionID, info.id);
        }
        return;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        if (part.type !== "tool") return;
        const binding = this.#state.getBySession(part.sessionID);
        if (!binding) return;
        const input = isRecord(part.state.input) ? part.state.input : {};
        const timing = toolTiming(part.state);
        const annotation = safeToolAnnotation({
          tool: part.tool,
          input,
          directory: binding.directory,
        });
        const changed = this.#buffer.observeTool({
          sessionId: part.sessionID,
          messageId: part.messageID,
          partId: part.id,
          tool: part.tool,
          status: part.state.status,
          ...(annotation ? { annotation } : {}),
          ...timing,
        });
        if (changed) this.#requestFlush(part.sessionID);
        return;
      }
      case "session.idle":
        await this.#finalize(event.properties.sessionID);
        return;
      default:
        return;
    }
  }

  stop(): void {
    this.#flusher.cancelAll();
    this.#messages.clear();
    this.#buffer.clearAll();
  }

  #requestFlush(sessionId: string): void {
    this.#flusher.request(sessionId, async () => this.#flushSummary(sessionId));
  }

  async #flushSummary(sessionId: string): Promise<void> {
    const binding = this.#state.getBySession(sessionId);
    const assistantMessageId = this.#buffer.currentMessageId(sessionId);
    const items = this.#buffer.snapshot(sessionId);
    if (!binding || !assistantMessageId || items.length === 0) return;

    const content = renderToolActivitySummary(items);
    const current = this.#messages.get(sessionId);
    if (current?.assistantMessageId === assistantMessageId) {
      if (current.content === content) return;
      await this.#rest.patch(Routes.channelMessage(binding.threadId, current.discordMessageId), {
        body: { content },
      });
      current.content = content;
      return;
    }

    const created = await this.#rest.post(Routes.channelMessages(binding.threadId), {
      body: { content },
    });
    if (!isRecord(created) || typeof created.id !== "string") {
      throw new Error("Discord create-message response did not include an id");
    }
    this.#messages.set(sessionId, {
      assistantMessageId,
      discordMessageId: created.id,
      content,
    });
  }

  async #finalize(sessionId: string): Promise<void> {
    await this.#flusher.cancelAndDrain(sessionId);
    try {
      await this.#flushSummary(sessionId);
    } finally {
      this.#buffer.clearSession(sessionId);
      this.#messages.delete(sessionId);
    }
  }
}

function toolTiming(state: {
  status: "pending" | "running" | "completed" | "error";
  time?: { start: number; end?: number };
}): { startedAt?: number; endedAt?: number } {
  if (!state.time) return {};
  return {
    startedAt: state.time.start,
    ...(state.time.end !== undefined ? { endedAt: state.time.end } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
