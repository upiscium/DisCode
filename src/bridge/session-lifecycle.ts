import type { SessionBinding } from "../domain/session-binding.js";

export type LifecycleStatus = "busy" | "retry" | "idle" | undefined;

export type LifecycleBlockReason =
  | { kind: "pending-question" }
  | { kind: "active-session"; status: "busy" | "retry" };

export type CloseMutationOperations = {
  deleteSession: () => Promise<void>;
  removeBinding: () => Promise<void>;
};

export type UnbindMutationOperations = {
  removeBinding: () => Promise<void>;
};

export type PureUnbindOperations = UnbindMutationOperations & {
  forgetBinding: () => void;
  clearPendingQuestions: () => void;
  clearQuestionPublications: () => void;
  clearPermissionPublications: () => void;
};

type BindingMutationSerializer = {
  runBindingMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
};

/** Serializes top-level lifecycle transactions without reusing managed-panel queues. */
export class SessionLifecycleSerializer {
  readonly #queues = new Map<string, Promise<void>>();

  run<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(threadId, settled);
    void settled.then(() => {
      if (this.#queues.get(threadId) === settled) this.#queues.delete(threadId);
    });
    return current;
  }
}

export function lifecycleBlockReason(
  status: LifecycleStatus,
  hasPendingQuestion: boolean,
): LifecycleBlockReason | undefined {
  if (hasPendingQuestion) return { kind: "pending-question" };
  if (status === "busy" || status === "retry") {
    return { kind: "active-session", status };
  }
  return undefined;
}

export function renderLifecycleBlock(reason: LifecycleBlockReason): string {
  if (reason.kind === "pending-question") {
    return "An OpenCode Ask is still pending. Answer or reject it before changing the session lifecycle.";
  }
  return `OpenCode is currently **${reason.status}**. Wait for the current turn to finish or use \`/oc abort\`, then retry.`;
}

export async function executeCloseMutation(operations: CloseMutationOperations): Promise<void> {
  await operations.deleteSession();
  await operations.removeBinding();
}

export async function executeUnbindMutation(operations: UnbindMutationOperations): Promise<void> {
  await operations.removeBinding();
}

export function runManagedPanelMutation<T>(
  threadId: string,
  todos: BindingMutationSerializer,
  subagents: BindingMutationSerializer,
  operation: () => Promise<T>,
): Promise<T> {
  return todos.runBindingMutation(threadId, () =>
    subagents.runBindingMutation(threadId, operation),
  );
}

export function runCurrentManagedLifecycleMutation<T>(options: {
  binding: SessionBinding;
  currentBinding: (threadId: string) => SessionBinding | undefined;
  lifecycle: Pick<SessionLifecycleSerializer, "run">;
  todos: BindingMutationSerializer;
  subagents: BindingMutationSerializer;
  operation: () => Promise<T>;
}): Promise<{ current: false } | { current: true; result: T }> {
  return options.lifecycle.run(options.binding.threadId, async () => {
    if (!sameLifecycleBinding(options.currentBinding(options.binding.threadId), options.binding)) {
      return { current: false };
    }
    const result = await runManagedPanelMutation(
      options.binding.threadId,
      options.todos,
      options.subagents,
      options.operation,
    );
    return { current: true, result };
  });
}

/** Removes only Discord-owned binding state; OpenCode execution state is deliberately absent. */
export function runPureUnbindLifecycleMutation(options: {
  binding: SessionBinding;
  currentBinding: (threadId: string) => SessionBinding | undefined;
  lifecycle: Pick<SessionLifecycleSerializer, "run">;
  todos: BindingMutationSerializer;
  subagents: BindingMutationSerializer;
  operations: PureUnbindOperations;
}): Promise<{ current: false } | { current: true; result: undefined }> {
  return runCurrentManagedLifecycleMutation({
    binding: options.binding,
    currentBinding: options.currentBinding,
    lifecycle: options.lifecycle,
    todos: options.todos,
    subagents: options.subagents,
    operation: async () => {
      await executeUnbindMutation({ removeBinding: options.operations.removeBinding });
      options.operations.forgetBinding();
      options.operations.clearPendingQuestions();
      options.operations.clearQuestionPublications();
      options.operations.clearPermissionPublications();
      return undefined;
    },
  });
}

function sameLifecycleBinding(
  current: SessionBinding | undefined,
  expected: SessionBinding,
): boolean {
  return (
    current?.threadId === expected.threadId &&
    current.hostId === expected.hostId &&
    current.sessionId === expected.sessionId &&
    current.directory === expected.directory &&
    current.createdAt === expected.createdAt
  );
}
