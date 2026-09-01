import type { OpenCodeQuestionRequest } from "../opencode/gateway.js";

type PublishingEntry = Readonly<{
  state: "publishing";
  hostId: string;
  request: OpenCodeQuestionRequest;
  promise: Promise<void>;
}>;

type PublishedEntry = Readonly<{
  state: "published";
  hostId: string;
  request: OpenCodeQuestionRequest;
}>;

type QuestionEntry = PublishingEntry | PublishedEntry;

/** Coalesces transient Question publication without making Discord history authoritative. */
export class QuestionPublicationTracker {
  readonly #entries = new Map<string, QuestionEntry>();

  current(hostId: string, requestId: string): OpenCodeQuestionRequest | undefined {
    const entry = this.#entries.get(questionKey(hostId, requestId));
    return entry?.state === "published" ? entry.request : undefined;
  }

  clear(hostId: string, requestId: string): void {
    this.#entries.delete(questionKey(hostId, requestId));
  }

  clearSession(hostId: string, sessionId: string): void {
    for (const [key, entry] of this.#entries) {
      if (entry.hostId === hostId && entry.request.sessionID === sessionId) {
        this.#entries.delete(key);
      }
    }
  }

  async publish(
    hostId: string,
    request: OpenCodeQuestionRequest,
    send: () => Promise<void>,
  ): Promise<boolean> {
    const key = questionKey(hostId, request.id);
    while (true) {
      const existing = this.#entries.get(key);
      if (existing?.state === "published") return false;
      if (existing?.state === "publishing") {
        try {
          await existing.promise;
          return false;
        } catch {
          continue;
        }
      }

      const promise = Promise.resolve().then(send);
      this.#entries.set(key, { state: "publishing", hostId, request, promise });
      try {
        await promise;
        const current = this.#entries.get(key);
        if (current?.state === "publishing" && current.promise === promise) {
          this.#entries.set(key, { state: "published", hostId, request });
          return true;
        }
        return false;
      } catch (error) {
        const current = this.#entries.get(key);
        if (current?.state === "publishing" && current.promise === promise) {
          this.#entries.delete(key);
        }
        throw error;
      }
    }
  }
}

function questionKey(hostId: string, requestId: string): string {
  return JSON.stringify([hostId, requestId]);
}
