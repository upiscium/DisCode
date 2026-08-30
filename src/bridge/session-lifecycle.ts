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

type BindingMutationSerializer = {
  runBindingMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
};

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
