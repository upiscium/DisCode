import type { SessionBinding } from "../domain/session-binding.js";
import type { LoggerLike } from "../logging/logger.js";
import type { OpenCodePermissionRequest } from "../opencode/gateway.js";

type PermissionReconcileHost = Readonly<{
  id: string;
  listPermissions(directory: string): Promise<OpenCodePermissionRequest[]>;
}>;

type ReconcileOptions = Readonly<{
  bindings: readonly Pick<SessionBinding, "hostId" | "sessionId" | "directory">[];
  hosts: readonly PermissionReconcileHost[];
  publish: (hostId: string, directory: string, request: OpenCodePermissionRequest) => Promise<void>;
  logger: LoggerLike;
}>;

export async function reconcilePendingPermissions(options: ReconcileOptions): Promise<void> {
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
      let requests: OpenCodePermissionRequest[];
      try {
        requests = await host.listPermissions(directory);
      } catch (error) {
        options.logger.warn(
          "opencode.permission_reconcile_failed",
          "Failed to list pending OpenCode permissions",
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
            "opencode.permission_reconcile_failed",
            "Failed to reconcile pending OpenCode permission",
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
