import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionBinding } from "../domain/session-binding.js";

type StateFile = {
  version: 1;
  bindings: Record<string, SessionBinding>;
};

const emptyState = (): StateFile => ({ version: 1, bindings: {} });

export class StateStore {
  readonly #path: string;
  #state: StateFile = emptyState();
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== "object") {
        throw new Error(`Unsupported state file format: ${this.#path}`);
      }
      this.#state = { version: 1, bindings: parsed.bindings };
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

  getBySession(sessionId: string): SessionBinding | undefined {
    const value = Object.values(this.#state.bindings).find((item) => item.sessionId === sessionId);
    return value ? { ...value } : undefined;
  }

  list(): SessionBinding[] {
    return Object.values(this.#state.bindings).map((item) => ({ ...item }));
  }

  async put(binding: SessionBinding): Promise<void> {
    this.#state.bindings[binding.threadId] = { ...binding };
    await this.#persist();
  }

  async updateLastPublished(threadId: string, messageId: string): Promise<void> {
    const current = this.#state.bindings[threadId];
    if (!current) return;
    this.#state.bindings[threadId] = {
      ...current,
      lastPublishedAssistantMessageId: messageId,
    };
    await this.#persist();
  }

  async updateHeaderMessageId(threadId: string, messageId: string): Promise<void> {
    const current = this.#state.bindings[threadId];
    if (!current) return;
    this.#state.bindings[threadId] = {
      ...current,
      headerMessageId: messageId,
    };
    await this.#persist();
  }

  async remove(threadId: string): Promise<void> {
    delete this.#state.bindings[threadId];
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}
