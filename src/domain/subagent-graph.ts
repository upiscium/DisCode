export type SubagentSessionIdentity = {
  hostId: string;
  id: string;
  parentId?: string;
  directory: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type SubagentRoot = Readonly<{
  hostId: string;
  directory: string;
  sessionId: string;
}>;

export type ResolvedSubagent = SubagentSessionIdentity & {
  rootSessionId: string;
  parentSessionId: string;
  depth: number;
};

export type SubagentGraph = Readonly<{
  root: SubagentRoot;
  descendants: readonly ResolvedSubagent[];
  depthBoundaryReached: boolean;
  sessionLimitReached: boolean;
}>;

export type SubagentGraphGateway = {
  listChildren(directory: string, parentSessionId: string): Promise<SubagentSessionIdentity[]>;
};

export const DEFAULT_SUBAGENT_MAX_DEPTH = 4;
export const DEFAULT_SUBAGENT_MAX_SESSIONS = 40;

export async function resolveSubagentGraph(options: {
  root: SubagentRoot;
  gateway: SubagentGraphGateway;
  maxDepth?: number;
  maxSessions?: number;
}): Promise<SubagentGraph> {
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_SUBAGENT_MAX_DEPTH, "maxDepth");
  const maxSessions = positiveInteger(
    options.maxSessions,
    DEFAULT_SUBAGENT_MAX_SESSIONS,
    "maxSessions",
  );
  const descendants: ResolvedSubagent[] = [];
  const visited = new Set([options.root.sessionId]);
  const queue: Array<{ sessionId: string; depth: number }> = [
    { sessionId: options.root.sessionId, depth: 0 },
  ];
  let depthBoundaryReached = false;
  let sessionLimitReached = false;

  while (queue.length > 0 && descendants.length < maxSessions) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth >= maxDepth) {
      depthBoundaryReached = true;
      continue;
    }

    const children = await options.gateway.listChildren(options.root.directory, current.sessionId);
    for (const child of children) {
      if (!isReachableChild(child, options.root, current.sessionId) || visited.has(child.id)) {
        continue;
      }
      if (descendants.length >= maxSessions) {
        sessionLimitReached = true;
        break;
      }

      visited.add(child.id);
      const depth = current.depth + 1;
      descendants.push({
        ...child,
        rootSessionId: options.root.sessionId,
        parentSessionId: current.sessionId,
        depth,
      });
      queue.push({ sessionId: child.id, depth });
    }
  }

  if (queue.length > 0 && descendants.length >= maxSessions) sessionLimitReached = true;
  return {
    root: { ...options.root },
    descendants,
    depthBoundaryReached,
    sessionLimitReached,
  };
}

function isReachableChild(
  child: SubagentSessionIdentity,
  root: SubagentRoot,
  expectedParentId: string,
): boolean {
  return (
    child.hostId === root.hostId &&
    child.directory === root.directory &&
    child.parentId === expectedParentId
  );
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1) throw new Error(`${name} must be positive`);
  return selected;
}
