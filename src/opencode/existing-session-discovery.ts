import type { StateStore } from "../state/state-store.js";
import {
  type NormalizedSessionStatus,
  statusForReachableSession,
} from "./child-session-gateway.js";
import type {
  ExistingSession,
  OpenCodeExistingSessionGateway,
} from "./existing-session-gateway.js";

export type ExistingSessionScope = {
  hostId: string;
  canonicalDirectory: string;
};

export type DiscoveredExistingSession = ExistingSession & {
  status: NormalizedSessionStatus;
  binding: "bound" | "unbound";
};

export function isEligibleExistingSession(
  session: ExistingSession,
  scope: ExistingSessionScope,
): boolean {
  return (
    session.hostId === scope.hostId &&
    session.directory === scope.canonicalDirectory &&
    session.parentId === undefined &&
    session.archivedAt === undefined
  );
}

/** Sort newer sessions first; sessions without an update time are last. */
export function compareExistingSessions(left: ExistingSession, right: ExistingSession): number {
  if (left.updatedAt === undefined && right.updatedAt !== undefined) return 1;
  if (left.updatedAt !== undefined && right.updatedAt === undefined) return -1;
  if (left.updatedAt !== undefined && right.updatedAt !== undefined) {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function sortExistingSessions<T extends ExistingSession>(sessions: readonly T[]): T[] {
  return [...sessions].sort(compareExistingSessions);
}

export class ExistingSessionDiscovery {
  readonly #gatewayFor: (
    hostId: string,
  ) => Pick<OpenCodeExistingSessionGateway, "listSessions" | "listStatuses">;
  readonly #state: Pick<StateStore, "getBySession">;

  constructor(
    gatewayFor: (
      hostId: string,
    ) => Pick<OpenCodeExistingSessionGateway, "listSessions" | "listStatuses">,
    state: Pick<StateStore, "getBySession">,
  ) {
    this.#gatewayFor = gatewayFor;
    this.#state = state;
  }

  async discover(scope: ExistingSessionScope): Promise<DiscoveredExistingSession[]> {
    const gateway = this.#gatewayFor(scope.hostId);
    const [sessions, statuses] = await Promise.all([
      gateway.listSessions(scope.canonicalDirectory),
      gateway.listStatuses(scope.canonicalDirectory),
    ]);
    const eligible = sessions.filter((session) => isEligibleExistingSession(session, scope));
    return sortExistingSessions(
      eligible.map((session) => ({
        ...session,
        status: statusForReachableSession(statuses, session.id),
        binding:
          this.#state.getBySession(scope.hostId, session.id) === undefined ? "unbound" : "bound",
      })),
    );
  }
}
