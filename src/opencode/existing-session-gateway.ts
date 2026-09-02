import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
  type NormalizedSessionStatuses,
  normalizeSessionStatuses,
} from "./child-session-gateway.js";

export const MAX_EXISTING_SESSION_ITEMS = 75;
const MAX_ID_LENGTH = 4_000;
const MAX_METADATA_LENGTH = 256;

export type ExistingSession = {
  hostId: string;
  id: string;
  directory: string;
  parentId?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  agent?: string;
  model?: { providerID: string; modelID: string };
};

export class OpenCodeExistingSessionGateway {
  readonly #hostId: string;
  readonly #client: ReturnType<typeof createOpencodeClient>;

  constructor(options: { hostId: string; baseUrl: string; username: string; password?: string }) {
    const headers: Record<string, string> = {};
    if (options.password) {
      headers.Authorization = `Basic ${Buffer.from(
        `${options.username}:${options.password}`,
        "utf8",
      ).toString("base64")}`;
    }
    this.#hostId = options.hostId;
    this.#client = createOpencodeClient({
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  async listSessions(directory: string, options?: { limit?: number }): Promise<ExistingSession[]> {
    const limit = options?.limit ?? MAX_EXISTING_SESSION_ITEMS;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXISTING_SESSION_ITEMS) {
      throw new Error("Invalid existing session limit");
    }
    const result = await this.#client.session.list(
      { directory, roots: true, limit },
      { throwOnError: true },
    );
    const sessions = normalizeExistingSessions(result.data, this.#hostId);
    if (!sessions) throw invalidResponse("list");
    return sessions.slice(0, limit);
  }

  async getSession(directory: string, id: string): Promise<ExistingSession> {
    const result = await this.#client.session.get(
      { sessionID: id, directory },
      { throwOnError: true },
    );
    const session = normalizeExistingSession(result.data, this.#hostId);
    if (!session) throw invalidResponse("get");
    return session;
  }

  async listStatuses(directory: string): Promise<NormalizedSessionStatuses> {
    const result = await this.#client.session.status({ directory }, { throwOnError: true });
    const statuses = normalizeSessionStatuses(result.data);
    if (!statuses) throw invalidResponse("status");
    return statuses;
  }
}

export function normalizeExistingSession(
  value: unknown,
  hostId: string,
): ExistingSession | undefined {
  if (!isRecord(value) || !requiredString(value.id) || !requiredString(value.directory)) {
    return undefined;
  }
  const result: ExistingSession = {
    hostId,
    id: value.id,
    directory: value.directory,
  };
  if (value.parentID !== undefined) {
    if (!requiredString(value.parentID)) return undefined;
    result.parentId = value.parentID;
  }
  for (const [rawKey, outputKey] of [
    ["title", "title"],
    ["agent", "agent"],
  ] as const) {
    if (value[rawKey] !== undefined) {
      if (typeof value[rawKey] !== "string") return undefined;
      const text = value[rawKey].slice(0, MAX_METADATA_LENGTH);
      if (outputKey === "title") result.title = text;
      else result.agent = text;
    }
  }
  if (value.model !== undefined) {
    if (
      !isRecord(value.model) ||
      !metadataString(value.model.providerID) ||
      !metadataString(value.model.id)
    ) {
      return undefined;
    }
    result.model = {
      providerID: value.model.providerID.slice(0, MAX_METADATA_LENGTH),
      modelID: value.model.id.slice(0, MAX_METADATA_LENGTH),
    };
  }
  if (value.time !== undefined) {
    if (!isRecord(value.time)) return undefined;
    for (const key of ["created", "updated", "archived"] as const) {
      if (value.time[key] !== undefined && !finiteNumber(value.time[key])) return undefined;
    }
    if (finiteNumber(value.time.created)) result.createdAt = value.time.created;
    if (finiteNumber(value.time.updated)) result.updatedAt = value.time.updated;
    if (finiteNumber(value.time.archived)) result.archivedAt = value.time.archived;
  }
  return result;
}

export function normalizeExistingSessions(
  value: unknown,
  hostId: string,
): ExistingSession[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sessions = value
    .slice(0, MAX_EXISTING_SESSION_ITEMS)
    .map((item) => normalizeExistingSession(item, hostId));
  return sessions.every((item): item is ExistingSession => item !== undefined)
    ? sessions
    : undefined;
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function metadataString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(endpoint: string): Error {
  return new Error(`OpenCode existing session ${endpoint} API returned an invalid response`);
}
