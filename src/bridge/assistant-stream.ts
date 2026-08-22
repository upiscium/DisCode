export type AssistantStreamSnapshot = {
  sessionId: string;
  messageId: string;
  text: string;
};

type TextPartState = {
  sessionId: string;
  messageId: string;
  partId: string;
  text: string;
};

export class AssistantTextStreamBuffer {
  readonly #assistantMessages = new Set<string>();
  readonly #latestMessageBySession = new Map<string, string>();
  readonly #parts = new Map<string, TextPartState>();
  readonly #partOrderByMessage = new Map<string, string[]>();

  observeMessage(input: { sessionId: string; messageId: string; role: string }): void {
    if (input.role !== "assistant") return;
    this.#assistantMessages.add(messageKey(input.sessionId, input.messageId));
    this.#latestMessageBySession.set(input.sessionId, input.messageId);
  }

  observePart(input: {
    sessionId: string;
    messageId: string;
    partId: string;
    type: string;
    text?: string;
  }): boolean {
    if (input.type !== "text") return false;
    const msgKey = messageKey(input.sessionId, input.messageId);
    if (!this.#assistantMessages.has(msgKey)) return false;
    if (this.#latestMessageBySession.get(input.sessionId) !== input.messageId) return false;

    const key = partKey(input.sessionId, input.messageId, input.partId);
    const previous = this.#parts.get(key);
    const text = input.text ?? "";
    if (!previous) {
      const order = this.#partOrderByMessage.get(msgKey) ?? [];
      order.push(input.partId);
      this.#partOrderByMessage.set(msgKey, order);
    }
    this.#parts.set(key, {
      sessionId: input.sessionId,
      messageId: input.messageId,
      partId: input.partId,
      text,
    });
    return previous?.text !== text && text.length > 0;
  }

  appendDelta(input: {
    sessionId: string;
    messageId: string;
    partId: string;
    field: string;
    delta: string;
  }): boolean {
    if (input.field !== "text" || input.delta.length === 0) return false;
    if (this.#latestMessageBySession.get(input.sessionId) !== input.messageId) return false;

    const key = partKey(input.sessionId, input.messageId, input.partId);
    const part = this.#parts.get(key);
    if (!part) return false;
    part.text += input.delta;
    return true;
  }

  snapshot(sessionId: string): AssistantStreamSnapshot | undefined {
    const messageId = this.#latestMessageBySession.get(sessionId);
    if (!messageId) return undefined;
    const msgKey = messageKey(sessionId, messageId);
    const partIds = this.#partOrderByMessage.get(msgKey) ?? [];
    const text = partIds
      .map((partId) => this.#parts.get(partKey(sessionId, messageId, partId))?.text ?? "")
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!text) return undefined;
    return { sessionId, messageId, text };
  }

  clearSession(sessionId: string): void {
    this.#latestMessageBySession.delete(sessionId);
    for (const key of [...this.#assistantMessages]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.#assistantMessages.delete(key);
    }
    for (const [key, part] of [...this.#parts]) {
      if (part.sessionId === sessionId) this.#parts.delete(key);
    }
    for (const key of [...this.#partOrderByMessage.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.#partOrderByMessage.delete(key);
    }
  }
}

type FlushCallback = () => Promise<void> | void;

type FlushState = {
  callback: FlushCallback;
  pending: boolean;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  runPromise: Promise<void> | undefined;
};

export class CoalescedSessionFlusher {
  readonly #intervalMs: number;
  readonly #onError: (sessionId: string, error: unknown) => void;
  readonly #states = new Map<string, FlushState>();

  constructor(
    intervalMs = 1000,
    onError: (sessionId: string, error: unknown) => void = () => undefined,
  ) {
    this.#intervalMs = intervalMs;
    this.#onError = onError;
  }

  request(sessionId: string, callback: FlushCallback): void {
    const state = this.#states.get(sessionId) ?? {
      callback,
      pending: false,
      running: false,
      timer: undefined,
      runPromise: undefined,
    };
    state.callback = callback;
    state.pending = true;
    this.#states.set(sessionId, state);
    this.#arm(sessionId, state);
  }

  cancel(sessionId: string): void {
    const state = this.#states.get(sessionId);
    if (state?.timer) clearTimeout(state.timer);
    this.#states.delete(sessionId);
  }

  async cancelAndDrain(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId);
    if (state?.timer) clearTimeout(state.timer);
    this.#states.delete(sessionId);
    await state?.runPromise;
  }

  cancelAll(): void {
    for (const sessionId of [...this.#states.keys()]) this.cancel(sessionId);
  }

  #arm(sessionId: string, state: FlushState): void {
    if (state.timer || state.running || !state.pending) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const runPromise = this.#run(sessionId, state);
      state.runPromise = runPromise;
      void runPromise.finally(() => {
        if (state.runPromise === runPromise) state.runPromise = undefined;
      });
    }, this.#intervalMs);
  }

  async #run(sessionId: string, state: FlushState): Promise<void> {
    if (this.#states.get(sessionId) !== state) return;
    state.running = true;
    state.pending = false;
    try {
      await state.callback();
    } catch (error) {
      this.#onError(sessionId, error);
    } finally {
      state.running = false;
      if (this.#states.get(sessionId) === state) {
        if (state.pending) {
          this.#arm(sessionId, state);
        } else {
          this.#states.delete(sessionId);
        }
      }
    }
  }
}

function messageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`;
}

function partKey(sessionId: string, messageId: string, partId: string): string {
  return `${sessionId}\u0000${messageId}\u0000${partId}`;
}
