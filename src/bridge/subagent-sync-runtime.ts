import type { SessionBinding } from "../domain/session-binding.js";
import type { LoggerLike } from "../logging/logger.js";
import type {
  SubagentInspectionList,
  SubagentInspectionMetadata,
} from "../opencode/subagent-inspector.js";

type State = {
  list(): readonly SessionBinding[];
  getByThread(threadId: string): SessionBinding | undefined;
};

export type Panels = {
  refreshBinding(binding: SessionBinding): Promise<SubagentInspectionList | undefined>;
  runExclusive<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
};

export type OpenCodeSubagentEvent = {
  type?: unknown;
  properties?: unknown;
};

type ThreadIndex = Map<string, Set<string>>;
type RefreshJob = { dirty: boolean; running: Promise<void> | undefined };

const MAX_STRING = 512;
const EVENT_TYPES = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
]);

/** Coordinates authoritative subagent snapshots with the panels which display them. */
export class SubagentSyncRuntime {
  readonly #state: State;
  readonly #panels: Panels;
  readonly #logger: LoggerLike;
  readonly #byHostDirectoryChild: ThreadIndex = new Map();
  readonly #jobs = new Map<string, RefreshJob>();

  constructor(options: { state: State; panels: Panels; logger: LoggerLike }) {
    this.#state = options.state;
    this.#panels = options.panels;
    this.#logger = options.logger;
  }

  async refreshInitial(binding: SessionBinding): Promise<void> {
    await this.#refresh(binding, "initial");
  }

  async reconcileStartup(): Promise<void> {
    for (const binding of this.#state.list()) await this.#refresh(binding, "startup");
  }

  async reconcileHost(hostId: string): Promise<void> {
    if (!valid(hostId)) return;
    for (const binding of this.#state.list()) {
      if (binding.hostId === hostId) await this.#refresh(binding, "reconnect");
    }
  }

  /** Schedules work and deliberately does not wait for the panel refresh. */
  applyEvent(hostId: string, eventDirectory: string, event: unknown): void {
    const hint = eventHint(event);
    if (!valid(hostId) || !valid(eventDirectory) || !hint) return;
    if (hint.directory !== undefined && hint.directory !== eventDirectory) return;

    const selected = new Set<string>();
    const add = (index: ThreadIndex, key: string) => {
      for (const thread of index.get(key) ?? []) selected.add(thread);
    };
    const scoped = `${hostId}\0${eventDirectory}`;
    add(this.#byHostDirectoryChild, `${scoped}\0${hint.sessionId}`);
    if (hint.parentId) {
      add(this.#byHostDirectoryChild, `${scoped}\0${hint.parentId}`);
      for (const binding of this.#state.list()) {
        if (
          binding.hostId === hostId &&
          binding.directory === eventDirectory &&
          binding.sessionId === hint.parentId
        ) {
          selected.add(binding.threadId);
        }
      }
    }

    // A new or cold session has no index entry. Restrict the fallback to the
    // exact host and directory; it must never fan out to another host/dir.
    if (selected.size === 0) {
      for (const binding of this.#state.list()) {
        if (binding.hostId === hostId && binding.directory === eventDirectory) {
          selected.add(binding.threadId);
        }
      }
    }
    for (const threadId of selected) {
      const binding = this.#state.getByThread(threadId);
      if (binding?.hostId === hostId && binding.directory === eventDirectory) {
        this.#schedule(threadId, hint.type);
      }
    }
  }

  drainBinding(threadId: string): Promise<void> {
    return this.#awaitDrained(threadId);
  }

  runBindingMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return this.#panels.runExclusive(threadId, operation);
  }

  forgetBinding(binding: SessionBinding): void {
    this.#removeEdges(binding.threadId);
    this.#jobs.delete(binding.threadId);
  }

  #schedule(threadId: string, eventType: string): void {
    const job = this.#jobs.get(threadId) ?? { dirty: false, running: undefined };
    job.dirty = true;
    this.#jobs.set(threadId, job);
    if (job.running) return;
    const binding = this.#state.getByThread(threadId);
    if (!binding) return;
    job.running = this.#drain(binding, eventType).finally(() => {
      if (this.#jobs.get(threadId) !== job) return;
      job.running = undefined;
      if (job.dirty) this.#start(threadId, job, eventType);
    });
  }

  #start(threadId: string, job: RefreshJob, eventType: string): void {
    const binding = this.#state.getByThread(threadId);
    if (!binding || job.running) return;
    job.running = this.#drain(binding, eventType).finally(() => {
      if (this.#jobs.get(threadId) !== job) return;
      job.running = undefined;
      if (job.dirty) this.#start(threadId, job, eventType);
    });
  }

  async #awaitDrained(threadId: string): Promise<void> {
    for (;;) {
      const running = this.#jobs.get(threadId)?.running;
      if (!running) return;
      await running;
      if (this.#jobs.get(threadId)?.running === undefined) return;
    }
  }

  async #drain(binding: SessionBinding, eventType: string): Promise<void> {
    const job = this.#jobs.get(binding.threadId);
    if (!job) return;
    do {
      job.dirty = false;
      await this.#refresh(binding, "event", eventType);
    } while (job.dirty);
  }

  async #refresh(binding: SessionBinding, trigger: string, eventType?: string): Promise<void> {
    try {
      const result = await this.#panels.refreshBinding(binding);
      const current = this.#state.getByThread(binding.threadId);
      if (result !== undefined && sameBinding(current, binding)) {
        this.#replaceEdges(binding, result);
      }
    } catch (error) {
      this.#logger.warn(
        "discord.subagent_panel_failed",
        "Failed to refresh Discord subagent panel",
        {
          host_id: bounded(binding.hostId),
          session_id: bounded(binding.sessionId),
          thread_id: bounded(binding.threadId),
          trigger,
          ...(eventType === undefined ? {} : { event_type: eventType }),
        },
        error,
      );
    }
  }

  #replaceEdges(binding: SessionBinding, result: SubagentInspectionList): void {
    this.#removeEdges(binding.threadId);
    this.#add(
      this.#byHostDirectoryChild,
      `${binding.hostId}\0${binding.directory}\0${binding.sessionId}`,
      binding.threadId,
    );
    for (const item of result.items) {
      if (!metadata(item, binding)) continue;
      const parent = item.parentSessionId || item.parentId;
      if (!valid(parent)) continue;
      this.#add(
        this.#byHostDirectoryChild,
        `${binding.hostId}\0${binding.directory}\0${item.id}`,
        binding.threadId,
      );
      this.#add(
        this.#byHostDirectoryChild,
        `${binding.hostId}\0${binding.directory}\0${parent}`,
        binding.threadId,
      );
    }
  }

  #removeEdges(threadId: string): void {
    for (const [key, threads] of this.#byHostDirectoryChild) {
      threads.delete(threadId);
      if (threads.size === 0) this.#byHostDirectoryChild.delete(key);
    }
  }

  #add(index: ThreadIndex, key: string, threadId: string): void {
    const threads = index.get(key) ?? new Set<string>();
    threads.add(threadId);
    index.set(key, threads);
  }
}

export { SubagentSyncRuntime as SubagentSyncCoordinator };

function valid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING;
}
function bounded(value: string): string {
  return value.slice(0, MAX_STRING);
}
function metadata(item: SubagentInspectionMetadata, binding: SessionBinding): boolean {
  return (
    valid(item.id) &&
    item.hostId === binding.hostId &&
    item.directory === binding.directory &&
    item.rootSessionId === binding.sessionId &&
    (valid(item.parentSessionId) || valid(item.parentId))
  );
}

function sameBinding(current: SessionBinding | undefined, expected: SessionBinding): boolean {
  return Boolean(
    current &&
      current.threadId === expected.threadId &&
      current.hostId === expected.hostId &&
      current.sessionId === expected.sessionId &&
      current.directory === expected.directory,
  );
}
function eventHint(
  event: unknown,
): { type: string; sessionId: string; parentId?: string; directory?: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as OpenCodeSubagentEvent;
  if (typeof candidate.type !== "string" || !EVENT_TYPES.has(candidate.type)) return undefined;
  if (!candidate.properties || typeof candidate.properties !== "object") return undefined;
  const properties = candidate.properties as Record<string, unknown>;
  if (candidate.type === "session.status") {
    return valid(properties.sessionID)
      ? { type: candidate.type, sessionId: properties.sessionID }
      : undefined;
  }
  if (!properties.info || typeof properties.info !== "object") return undefined;
  const info = properties.info as Record<string, unknown>;
  if (
    !valid(info.id) ||
    !valid(info.directory) ||
    (info.parentID !== undefined && !valid(info.parentID))
  ) {
    return undefined;
  }
  return {
    type: candidate.type,
    sessionId: info.id,
    directory: info.directory,
    ...(valid(info.parentID) ? { parentId: info.parentID } : {}),
  };
}
