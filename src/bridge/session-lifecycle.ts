export type LifecycleStatus = "busy" | "retry" | "idle" | undefined;

export type LifecycleBlockReason =
  | { kind: "pending-question" }
  | { kind: "active-session"; status: "busy" | "retry" };

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
