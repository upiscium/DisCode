import type { OpenCodePermissionRequest } from "../opencode/gateway.js";

type PublishingEntry = Readonly<{
  state: "publishing";
  request: OpenCodePermissionRequest;
  promise: Promise<void>;
}>;

type PublishedEntry = Readonly<{
  state: "published";
  request: OpenCodePermissionRequest;
}>;

type PermissionEntry = PublishingEntry | PublishedEntry;

export function hasPendingPermissionRequest(
  requests: readonly OpenCodePermissionRequest[],
  sessionId: string,
  permissionId: string,
): boolean {
  return requests.some(
    (request) => request.id === permissionId && request.sessionID === sessionId,
  );
}

export class PermissionPublicationTracker {
  readonly #entries = new Map<string, PermissionEntry>();

  current(hostId: string, permissionId: string): OpenCodePermissionRequest | undefined {
    const entry = this.#entries.get(permissionKey(hostId, permissionId));
    return entry?.state === "published" ? entry.request : undefined;
  }

  clear(hostId: string, permissionId: string): void {
    this.#entries.delete(permissionKey(hostId, permissionId));
  }

  clearSession(hostId: string, sessionId: string): void {
    for (const [key, entry] of this.#entries) {
      if (key.startsWith(`${hostId}:`) && entry.request.sessionID === sessionId) {
        this.#entries.delete(key);
      }
    }
  }

  async publish(
    hostId: string,
    request: OpenCodePermissionRequest,
    send: () => Promise<void>,
  ): Promise<boolean> {
    const key = permissionKey(hostId, request.id);

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
      this.#entries.set(key, { state: "publishing", request, promise });
      try {
        await promise;
        const current = this.#entries.get(key);
        if (current?.state === "publishing" && current.promise === promise) {
          this.#entries.set(key, { state: "published", request });
        }
        return true;
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

function permissionKey(hostId: string, permissionId: string): string {
  return `${hostId}:${permissionId}`;
}
