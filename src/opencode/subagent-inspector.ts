import {
  type ResolvedSubagent,
  resolveSubagentGraph,
  type SubagentGraph,
  type SubagentRoot,
} from "../domain/subagent-graph.js";
import type {
  NormalizedModel,
  NormalizedSession,
  NormalizedSessionStatus,
  NormalizedSessionStatuses,
  NormalizedToolActivity,
  NormalizedTranscript,
  OpenCodeChildSessionGateway,
} from "./child-session-gateway.js";
import type { OpenCodeTodoGateway, OpenCodeTodoItem } from "./todo-gateway.js";

type InspectionGateway = Pick<
  OpenCodeChildSessionGateway,
  "getRecentMessages" | "getSession" | "getStatus" | "listChildren" | "listStatuses"
>;
type TodoGateway = Pick<OpenCodeTodoGateway, "listTodos">;

export type SubagentInspectionMetadata = ResolvedSubagent & {
  status: NormalizedSessionStatus;
  agent?: string;
  model?: NormalizedModel;
};

export type SubagentInspectionDetail = SubagentInspectionMetadata & {
  messages: readonly NormalizedTranscript[];
  toolActivity: readonly NormalizedToolActivity[];
  todos?: readonly OpenCodeTodoItem[];
  todoUnavailable: boolean;
};

export type SubagentInspectionList = Readonly<{
  items: readonly SubagentInspectionMetadata[];
  depthBoundaryReached: boolean;
  sessionLimitReached: boolean;
}>;

const INSPECTION_CONCURRENCY = 4;

export class SubagentInspector {
  readonly #gatewayFor: (hostId: string) => InspectionGateway;
  readonly #todoGatewayFor: ((hostId: string) => TodoGateway) | undefined;
  readonly #maxDepth: number | undefined;
  readonly #maxSessions: number | undefined;

  constructor(options: {
    gatewayFor: (hostId: string) => InspectionGateway;
    todoGatewayFor?: (hostId: string) => TodoGateway;
    maxDepth?: number;
    maxSessions?: number;
  }) {
    this.#gatewayFor = options.gatewayFor;
    this.#todoGatewayFor = options.todoGatewayFor;
    this.#maxDepth = options.maxDepth;
    this.#maxSessions = options.maxSessions;
  }

  resolveGraph(root: SubagentRoot): Promise<SubagentGraph> {
    return resolveSubagentGraph({
      root,
      gateway: this.#gatewayFor(root.hostId),
      ...(this.#maxDepth === undefined ? {} : { maxDepth: this.#maxDepth }),
      ...(this.#maxSessions === undefined ? {} : { maxSessions: this.#maxSessions }),
    });
  }

  async listDescendants(root: SubagentRoot): Promise<SubagentInspectionList> {
    const graph = await this.resolveGraph(root);
    const statuses = await this.#gatewayFor(root.hostId).listStatuses(root.directory);
    const items = await mapWithConcurrency(
      graph.descendants,
      INSPECTION_CONCURRENCY,
      async (descendant) => {
        try {
          const { metadata } = await this.#loadCurrent(descendant, 6, statuses);
          return metadata;
        } catch (error) {
          if (error instanceof SessionAuthorityChangedError) return undefined;
          throw error;
        }
      },
    );
    const currentGraph = await this.resolveGraph(root);
    const reachableLineage = new Map(
      currentGraph.descendants.map((descendant) => [descendant.id, descendant]),
    );
    const reachableItems = items.filter(
      (item): item is SubagentInspectionMetadata =>
        item !== undefined && sameLineage(item, reachableLineage.get(item.id)),
    );
    return {
      items: reachableItems,
      depthBoundaryReached: currentGraph.depthBoundaryReached,
      sessionLimitReached: currentGraph.sessionLimitReached,
    };
  }

  async autocompleteDescendants(root: SubagentRoot): Promise<SubagentInspectionList> {
    const [graph, statuses] = await Promise.all([
      this.resolveGraph(root),
      this.#gatewayFor(root.hostId).listStatuses(root.directory),
    ]);
    return {
      items: graph.descendants.map((descendant) => ({
        ...descendant,
        status: statuses[descendant.id] ?? "unknown",
      })),
      depthBoundaryReached: graph.depthBoundaryReached,
      sessionLimitReached: graph.sessionLimitReached,
    };
  }

  async inspectDescendant(
    root: SubagentRoot,
    childSessionId: string,
  ): Promise<SubagentInspectionDetail | undefined> {
    const graph = await this.resolveGraph(root);
    const descendant = graph.descendants.find((item) => item.id === childSessionId);
    if (!descendant) return undefined;

    const { metadata, messages } = await this.#loadCurrent(descendant, 20);
    let todos: readonly OpenCodeTodoItem[] | undefined;
    let todoUnavailable = false;
    if (this.#todoGatewayFor) {
      try {
        todos = await this.#todoGatewayFor(root.hostId).listTodos(root.directory, descendant.id);
      } catch {
        todoUnavailable = true;
      }
    }

    const currentGraph = await this.resolveGraph(root);
    const currentDescendant = currentGraph.descendants.find((item) => item.id === descendant.id);
    if (!sameLineage(descendant, currentDescendant)) return undefined;

    return {
      ...metadata,
      messages,
      toolActivity: messages.flatMap((message) => message.toolActivity),
      ...(todos ? { todos } : {}),
      todoUnavailable,
    };
  }

  async #loadCurrent(
    descendant: ResolvedSubagent,
    messageLimit: number,
    statuses?: NormalizedSessionStatuses,
  ): Promise<{ metadata: SubagentInspectionMetadata; messages: NormalizedTranscript[] }> {
    const gateway = this.#gatewayFor(descendant.hostId);
    const [session, messages] = await Promise.all([
      gateway.getSession(descendant.directory, descendant.id),
      gateway.getRecentMessages(descendant.directory, descendant.id, messageLimit),
    ]);
    const status = statuses
      ? (statuses[descendant.id] ?? "unknown")
      : await gateway.getStatus(descendant.directory, descendant.id);
    assertCurrentSession(session, descendant);
    const latestContext = [...messages]
      .reverse()
      .find((message) => message.agent !== undefined || message.model !== undefined);
    return {
      metadata: {
        ...descendant,
        ...session,
        rootSessionId: descendant.rootSessionId,
        parentSessionId: descendant.parentSessionId,
        depth: descendant.depth,
        status,
        ...(latestContext?.agent ? { agent: latestContext.agent } : {}),
        ...(latestContext?.model ? { model: latestContext.model } : {}),
      },
      messages,
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function assertCurrentSession(session: NormalizedSession, descendant: ResolvedSubagent): void {
  if (
    session.hostId !== descendant.hostId ||
    session.directory !== descendant.directory ||
    session.id !== descendant.id ||
    session.parentId !== descendant.parentSessionId
  ) {
    throw new SessionAuthorityChangedError();
  }
}

class SessionAuthorityChangedError extends Error {
  constructor() {
    super("OpenCode child session identity changed during inspection");
  }
}

function sameLineage(expected: ResolvedSubagent, current: ResolvedSubagent | undefined): boolean {
  return (
    current !== undefined &&
    current.hostId === expected.hostId &&
    current.directory === expected.directory &&
    current.id === expected.id &&
    current.rootSessionId === expected.rootSessionId &&
    current.parentSessionId === expected.parentSessionId &&
    current.depth === expected.depth
  );
}
