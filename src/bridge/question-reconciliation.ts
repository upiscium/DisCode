import type { SessionBinding } from "../domain/session-binding.js";
import type { LoggerLike } from "../logging/logger.js";
import type { OpenCodeQuestionRequest } from "../opencode/gateway.js";

type QuestionReconcileHost = Readonly<{
  id: string;
  listQuestions(directory: string): Promise<OpenCodeQuestionRequest[]>;
}>;

type ReconcileOptions = Readonly<{
  bindings: readonly Pick<SessionBinding, "hostId" | "sessionId" | "directory">[];
  hosts: readonly QuestionReconcileHost[];
  publish: (hostId: string, directory: string, request: OpenCodeQuestionRequest) => Promise<void>;
  logger: LoggerLike;
}>;

export async function reconcilePendingQuestions(options: ReconcileOptions): Promise<void> {
  const bindingsBySession = new Map(
    options.bindings.map((binding) => [sessionKey(binding.hostId, binding.sessionId), binding]),
  );

  for (const host of options.hosts) {
    const directories = [
      ...new Set(
        options.bindings
          .filter((binding) => binding.hostId === host.id)
          .map((binding) => binding.directory),
      ),
    ];
    for (const directory of directories) {
      let requests: OpenCodeQuestionRequest[];
      try {
        requests = await host.listQuestions(directory);
      } catch (error) {
        options.logger.warn(
          "opencode.question_reconcile_failed",
          "Failed to list pending OpenCode questions",
          { host_id: host.id },
          error,
        );
        continue;
      }

      for (const request of requests) {
        const binding = bindingsBySession.get(sessionKey(host.id, request.sessionID));
        if (!binding || binding.directory !== directory) continue;
        try {
          await options.publish(host.id, directory, request);
        } catch (error) {
          options.logger.warn(
            "opencode.question_reconcile_failed",
            "Failed to reconcile pending OpenCode question",
            { host_id: host.id },
            error,
          );
        }
      }
    }
  }
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}
