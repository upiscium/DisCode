import type { ExistingSession } from "../opencode/existing-session-gateway.js";
import type { OpenCodeHostRuntime } from "../opencode/host-runtime-registry.js";

export type SessionAuthorityInput = Readonly<{
  hostId: string;
  directory: string;
  sessionId: string;
}>;

export type ResolvedSessionAuthority = Readonly<{
  hostId: string;
  canonicalDirectory: string;
  sessionId: string;
  title?: string;
  agent?: string;
  model?: Readonly<{ providerID: string; modelID: string }>;
}>;

type SessionAuthorityRuntime = Pick<
  OpenCodeHostRuntime,
  "id" | "authorizeDirectory" | "existingSessions"
>;

type SessionAuthorityHostRegistry = Readonly<{
  get(id: string): SessionAuthorityRuntime;
}>;

export class SessionAuthorityResolver {
  readonly #hosts: SessionAuthorityHostRegistry;

  constructor(hosts: SessionAuthorityHostRegistry) {
    this.#hosts = hosts;
  }

  async resolve(input: SessionAuthorityInput): Promise<ResolvedSessionAuthority> {
    if (!input.hostId || !input.directory || !input.sessionId) {
      throw new Error("Session authority requires host, directory, and session identity");
    }

    const runtime = this.#hosts.get(input.hostId);
    const canonicalDirectory = await runtime.authorizeDirectory(input.directory);
    const session = await runtime.existingSessions.getSession(canonicalDirectory, input.sessionId);
    assertExactRootSession(runtime.id, canonicalDirectory, input.sessionId, session);

    return {
      hostId: runtime.id,
      canonicalDirectory,
      sessionId: session.id,
      ...(session.title ? { title: session.title } : {}),
      ...(session.agent ? { agent: session.agent } : {}),
      ...(session.model ? { model: { ...session.model } } : {}),
    };
  }
}

function assertExactRootSession(
  hostId: string,
  canonicalDirectory: string,
  sessionId: string,
  session: ExistingSession,
): void {
  if (
    session.hostId !== hostId ||
    session.id !== sessionId ||
    session.directory !== canonicalDirectory
  ) {
    throw new Error("OpenCode session identity changed during authority resolution");
  }
  if (session.parentId) {
    throw new Error("Only OpenCode root sessions can become managed session authority");
  }
  if (session.archivedAt !== undefined) {
    throw new Error("Archived OpenCode sessions cannot become managed session authority");
  }
}
