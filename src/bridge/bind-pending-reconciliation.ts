import type { SessionBinding } from "../domain/session-binding.js";
import type { LoggerLike } from "../logging/logger.js";

export async function reconcilePendingAfterBind(options: {
  binding: SessionBinding;
  questions: () => Promise<void>;
  permissions: () => Promise<void>;
  logger: LoggerLike;
}): Promise<void> {
  const fields = {
    host_id: bounded(options.binding.hostId),
    session_id: bounded(options.binding.sessionId),
    thread_id: bounded(options.binding.threadId),
    trigger: "bind",
  };
  await Promise.all([
    Promise.resolve()
      .then(options.questions)
      .catch((error) => {
        options.logger.warn(
          "opencode.question_reconcile_failed",
          "Failed to reconcile pending OpenCode questions after bind",
          fields,
          error,
        );
      }),
    Promise.resolve()
      .then(options.permissions)
      .catch((error) => {
        options.logger.warn(
          "opencode.permission_reconcile_failed",
          "Failed to reconcile pending OpenCode permissions after bind",
          fields,
          error,
        );
      }),
  ]);
}

function bounded(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? "�" : character;
    })
    .join("")
    .slice(0, 256);
}
