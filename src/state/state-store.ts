import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OpenCodeModelSelection, SessionBinding } from "../domain/session-binding.js";

type PersistedSessionBinding = Omit<SessionBinding, "hostId"> & { hostId?: string };

type PersistedStateFile = {
  version: 1;
  bindings: Record<string, PersistedSessionBinding>;
};

type StateFile = {
  version: 1;
  bindings: Record<string, SessionBinding>;
};

const emptyState = (): StateFile => ({ version: 1, bindings: {} });

export class StateStore {
  readonly #path: string;
  readonly #legacyDefaultHostId: string;
  #state: StateFile = emptyState();
  #writeQueue: Promise<void> = Promise.resolve();
  #mutationQueue: Promise<void> | undefined;

  constructor(path: string, legacyDefaultHostId = "default") {
    this.#path = path;
    this.#legacyDefaultHostId = legacyDefaultHostId;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedStateFile>;
      if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== "object") {
        throw new Error(`Unsupported state file format: ${this.#path}`);
      }

      let migrated = false;
      const bindings = Object.fromEntries(
        Object.entries(parsed.bindings).map(([threadId, binding]) => {
          const hostId = binding.hostId?.trim() || this.#legacyDefaultHostId;
          if (!binding.hostId?.trim()) migrated = true;
          return [threadId, { ...binding, hostId } satisfies SessionBinding];
        }),
      );
      this.#state = { version: 1, bindings };
      if (migrated) await this.#persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#state = emptyState();
        return;
      }
      throw error;
    }
  }

  getByThread(threadId: string): SessionBinding | undefined {
    const value = this.#state.bindings[threadId];
    return value ? { ...value } : undefined;
  }

  getBySession(hostId: string, sessionId: string): SessionBinding | undefined {
    const value = Object.values(this.#state.bindings).find(
      (item) => item.hostId === hostId && item.sessionId === sessionId,
    );
    return value ? { ...value } : undefined;
  }

  list(): SessionBinding[] {
    return Object.values(this.#state.bindings).map((item) => ({ ...item }));
  }

  async put(binding: SessionBinding): Promise<void> {
    await this.#mutate(async () => {
      this.#state.bindings[binding.threadId] = { ...binding };
      await this.#persist();
    });
  }

  async claimBindingIfSessionUnbound(binding: SessionBinding): Promise<boolean> {
    return this.#mutate(async () => {
      if (
        this.getBySession(binding.hostId, binding.sessionId) ||
        this.#state.bindings[binding.threadId]
      ) {
        return false;
      }

      const previousState = this.#state;
      const nextState: StateFile = {
        version: 1,
        bindings: {
          ...previousState.bindings,
          [binding.threadId]: { ...binding },
        },
      };
      this.#state = nextState;
      try {
        await this.#persist(nextState);
        return true;
      } catch (error) {
        this.#state = previousState;
        throw error;
      }
    });
  }

  async removeBindingIfMatches(
    threadId: string,
    hostId: string,
    sessionId: string,
  ): Promise<boolean> {
    return this.#mutate(async () => {
      const current = this.#state.bindings[threadId];
      if (!current || current.hostId !== hostId || current.sessionId !== sessionId) {
        return false;
      }

      const previousState = this.#state;
      const nextState: StateFile = {
        version: 1,
        bindings: Object.fromEntries(
          Object.entries(previousState.bindings).filter(([key]) => key !== threadId),
        ),
      };
      this.#state = nextState;
      try {
        await this.#persist(nextState);
        return true;
      } catch (error) {
        this.#state = previousState;
        throw error;
      }
    });
  }

  async updateSelectionPreference(
    threadId: string,
    preference: { model?: OpenCodeModelSelection; agent?: string },
  ): Promise<void> {
    await this.#mutate(async () => {
      const current = this.#state.bindings[threadId];
      if (!current) return;
      this.#state.bindings[threadId] = {
        ...current,
        ...(preference.model === undefined ? {} : { model: { ...preference.model } }),
        ...(preference.agent === undefined ? {} : { agent: preference.agent }),
      };
      await this.#persist();
    });
  }

  async updateLastPublished(threadId: string, messageId: string): Promise<void> {
    await this.#mutate(async () => {
      const current = this.#state.bindings[threadId];
      if (!current) return;
      this.#state.bindings[threadId] = {
        ...current,
        lastPublishedAssistantMessageId: messageId,
      };
      await this.#persist();
    });
  }

  async updateHeaderMessageId(threadId: string, messageId: string): Promise<void> {
    await this.#mutate(async () => {
      const current = this.#state.bindings[threadId];
      if (!current) return;
      this.#state.bindings[threadId] = {
        ...current,
        headerMessageId: messageId,
      };
      await this.#persist();
    });
  }

  async updateTodoMessageId(threadId: string, messageId: string): Promise<void> {
    await this.#mutate(async () => {
      const current = this.#state.bindings[threadId];
      if (!current) return;
      this.#state.bindings[threadId] = {
        ...current,
        todoMessageId: messageId,
      };
      await this.#persist();
    });
  }

  async updateSubagentPanelMessageId(threadId: string, messageId: string): Promise<void> {
    await this.#mutate(async () => {
      const current = this.#state.bindings[threadId];
      if (!current) return;
      this.#state.bindings[threadId] = {
        ...current,
        subagentPanelMessageId: messageId,
      };
      await this.#persist();
    });
  }

  async remove(threadId: string): Promise<void> {
    await this.#mutate(async () => {
      delete this.#state.bindings[threadId];
      await this.#persist();
    });
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationQueue;
    const current = previous ? previous.then(operation, operation) : operation();
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#mutationQueue = settled;
    void settled.then(() => {
      if (this.#mutationQueue === settled) this.#mutationQueue = undefined;
    });
    return current;
  }

  async #persist(state: StateFile = this.#state): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}
