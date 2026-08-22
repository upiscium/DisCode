import type { ToolActivityItem, ToolActivityStatus } from "../discord/tool-summary.js";

export class ToolActivityBuffer {
  readonly #latestMessageBySession = new Map<string, string>();
  readonly #itemsByMessage = new Map<string, Map<string, ToolActivityItem>>();
  readonly #orderByMessage = new Map<string, string[]>();

  currentMessageId(sessionId: string): string | undefined {
    return this.#latestMessageBySession.get(sessionId);
  }

  startAssistantMessage(sessionId: string, messageId: string): void {
    if (this.#latestMessageBySession.get(sessionId) === messageId) return;
    this.clearSession(sessionId);
    this.#latestMessageBySession.set(sessionId, messageId);
  }

  observeTool(input: {
    sessionId: string;
    messageId: string;
    partId: string;
    tool: string;
    status: ToolActivityStatus;
    annotation?: string;
    startedAt?: number;
    endedAt?: number;
  }): boolean {
    if (this.#latestMessageBySession.get(input.sessionId) !== input.messageId) return false;
    const key = messageKey(input.sessionId, input.messageId);
    const items = this.#itemsByMessage.get(key) ?? new Map<string, ToolActivityItem>();
    const order = this.#orderByMessage.get(key) ?? [];
    const previous = items.get(input.partId);
    const next: ToolActivityItem = {
      partId: input.partId,
      tool: input.tool,
      status: input.status,
      ...(input.annotation ? { annotation: input.annotation } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
    };

    if (!previous) order.push(input.partId);
    items.set(input.partId, next);
    this.#itemsByMessage.set(key, items);
    this.#orderByMessage.set(key, order);
    return !sameItem(previous, next);
  }

  snapshot(sessionId: string): ToolActivityItem[] {
    const messageId = this.#latestMessageBySession.get(sessionId);
    if (!messageId) return [];
    const key = messageKey(sessionId, messageId);
    const items = this.#itemsByMessage.get(key);
    if (!items) return [];
    return (this.#orderByMessage.get(key) ?? [])
      .map((partId) => items.get(partId))
      .filter((item): item is ToolActivityItem => item !== undefined)
      .map((item) => ({ ...item }));
  }

  clearSession(sessionId: string): void {
    const messageId = this.#latestMessageBySession.get(sessionId);
    this.#latestMessageBySession.delete(sessionId);
    if (!messageId) return;
    const key = messageKey(sessionId, messageId);
    this.#itemsByMessage.delete(key);
    this.#orderByMessage.delete(key);
  }

  clearAll(): void {
    this.#latestMessageBySession.clear();
    this.#itemsByMessage.clear();
    this.#orderByMessage.clear();
  }
}

function sameItem(left: ToolActivityItem | undefined, right: ToolActivityItem): boolean {
  return (
    left?.tool === right.tool &&
    left.status === right.status &&
    left.annotation === right.annotation &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt
  );
}

function messageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`;
}
