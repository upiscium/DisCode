import { createOpencodeClient } from "@opencode-ai/sdk";

export type NormalizedSession = {
  hostId: string;
  id: string;
  parentId?: string;
  directory: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
};
export type OpenCodeChildSession = NormalizedSession;

export type NormalizedModel = { providerID: string; modelID: string };

export type NormalizedToolActivity = { tool: string; status: string };

export type NormalizedTranscript = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  createdAt?: number;
  agent?: string;
  model?: NormalizedModel;
  textParts: string[];
  toolActivity: NormalizedToolActivity[];
};
export type OpenCodeTranscript = NormalizedTranscript;

export type NormalizedSessionStatus = "idle" | "busy" | "retry" | "unknown";
export type NormalizedSessionStatuses = Readonly<Record<string, NormalizedSessionStatus>>;

export const MAX_SESSION_ITEMS = 500;
export const MAX_STRING_LENGTH = 4_000;
export const MAX_TRANSCRIPT_PARTS = 40;
export const MAX_RECENT_MESSAGES = 50;
const MAX_TRANSCRIPT_MESSAGES = 100;
const MAX_TEXT_PART_LENGTH = 2_000;
const MAX_TEXT_CHARACTERS_PER_MESSAGE = 8_000;
const MAX_METADATA_LENGTH = 256;
const MAX_TOOL_ACTIVITY_ITEMS = 40;
const MAX_STATUS_ITEMS = 1_000;

type RecordValue = Record<string, unknown>;

export class OpenCodeChildSessionGateway {
  readonly #hostId: string;
  readonly #client: ReturnType<typeof createOpencodeClient>;

  constructor(options: {
    hostId: string;
    baseUrl: string;
    username: string;
    password?: string;
  }) {
    this.#hostId = options.hostId;
    const headers: Record<string, string> = {};
    if (options.password) {
      headers.Authorization = `Basic ${Buffer.from(
        `${options.username}:${options.password}`,
        "utf8",
      ).toString("base64")}`;
    }
    this.#client = createOpencodeClient({
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  async listChildren(directory: string, parentSessionId: string): Promise<NormalizedSession[]> {
    const result = await this.#client.session.children({
      path: { id: parentSessionId },
      query: { directory },
      throwOnError: true,
    });
    const sessions = normalizeSessions(result.data, this.#hostId);
    if (!sessions) throw invalidResponse("children");
    return sessions;
  }

  async getSession(directory: string, sessionId: string): Promise<NormalizedSession> {
    const result = await this.#client.session.get({
      path: { id: sessionId },
      query: { directory },
      throwOnError: true,
    });
    const session = normalizeSession(result.data, this.#hostId);
    if (!session) throw invalidResponse("session");
    return session;
  }

  async getStatus(directory: string, sessionId: string): Promise<NormalizedSessionStatus> {
    const statuses = await this.listStatuses(directory);
    return statuses[sessionId] ?? "unknown";
  }

  async listStatuses(directory: string): Promise<NormalizedSessionStatuses> {
    const result = await this.#client.session.status({
      query: { directory },
      throwOnError: true,
    });
    const statuses = normalizeSessionStatuses(result.data);
    if (!statuses) throw invalidResponse("status");
    return statuses;
  }

  async getRecentMessages(
    directory: string,
    sessionId: string,
    limit = MAX_RECENT_MESSAGES,
  ): Promise<NormalizedTranscript[]> {
    const boundedLimit =
      Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RECENT_MESSAGES) : 0;
    if (!boundedLimit) throw new Error("Invalid recent message limit");
    const result = await this.#client.session.messages({
      path: { id: sessionId },
      query: { directory, limit: boundedLimit },
      throwOnError: true,
    });
    const messages = normalizeTranscripts(result.data, sessionId);
    if (!messages) throw invalidResponse("messages");
    return messages.slice(-boundedLimit);
  }
}

export function normalizeSession(value: unknown, hostId: string): NormalizedSession | undefined {
  if (!isRecord(value) || !boundedString(value.id) || !boundedString(value.directory)) {
    return undefined;
  }
  const time = value.time;
  if (time !== undefined && !isRecord(time)) return undefined;
  if (
    isRecord(time) &&
    ((time.created !== undefined && !finiteNumber(time.created)) ||
      (time.updated !== undefined && !finiteNumber(time.updated)))
  ) {
    return undefined;
  }
  const result: NormalizedSession = {
    hostId,
    id: value.id,
    directory: value.directory,
    ...(isRecord(time) && finiteNumber(time.created) ? { createdAt: time.created } : {}),
    ...(isRecord(time) && finiteNumber(time.updated) ? { updatedAt: time.updated } : {}),
  };
  if (value.parentID !== undefined) {
    if (!boundedString(value.parentID)) return undefined;
    result.parentId = value.parentID;
  }
  if (value.title !== undefined) {
    if (!boundedString(value.title)) return undefined;
    result.title = value.title;
  }
  return result;
}

export function normalizeSessions(value: unknown, hostId: string): NormalizedSession[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_SESSION_ITEMS) return undefined;
  const sessions = value.map((item) => normalizeSession(item, hostId));
  return sessions.every((item): item is NormalizedSession => item !== undefined)
    ? sessions
    : undefined;
}

export function normalizeSessionStatus(value: unknown): NormalizedSessionStatus | undefined {
  if (!isRecord(value) || !boundedString(value.type)) return undefined;
  if (value.type === "idle" || value.type === "busy" || value.type === "retry") {
    return value.type;
  }
  return "unknown";
}

export function normalizeSessionStatuses(value: unknown): NormalizedSessionStatuses | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_STATUS_ITEMS) return undefined;
  const statuses = Object.create(null) as Record<string, NormalizedSessionStatus>;
  for (const [sessionId, rawStatus] of entries) {
    if (!boundedString(sessionId)) return undefined;
    const status = normalizeSessionStatus(rawStatus);
    if (!status) return undefined;
    statuses[sessionId] = status;
  }
  return statuses;
}

export function normalizeTranscripts(
  value: unknown,
  sessionId: string,
): NormalizedTranscript[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_MESSAGES) return undefined;
  const messages = value.map((item) => normalizeTranscript(item, sessionId));
  return messages.every((item): item is NormalizedTranscript => item !== undefined)
    ? messages
    : undefined;
}

export function normalizeTranscript(
  value: unknown,
  sessionId: string,
): NormalizedTranscript | undefined {
  if (!isRecord(value) || !isRecord(value.info) || value.info.sessionID !== sessionId) {
    return undefined;
  }
  const info = value.info;
  if (!boundedString(info.id)) return undefined;
  const messageId = info.id;
  if (info.role !== "user" && info.role !== "assistant") return undefined;
  const role = info.role;
  const time = info.time;
  if (time !== undefined && !isRecord(time)) return undefined;
  if (isRecord(time) && time.created !== undefined && !finiteNumber(time.created)) {
    return undefined;
  }
  if (!Array.isArray(value.parts) || value.parts.length > MAX_TRANSCRIPT_PARTS) {
    return undefined;
  }
  const textParts: string[] = [];
  const toolActivity: NormalizedToolActivity[] = [];
  let textCharacters = 0;
  let agent: string | undefined;
  let model: NormalizedModel | undefined;
  if (info.agent !== undefined) {
    if (!metadataString(info.agent)) return undefined;
    agent = info.agent;
  }
  if (info.model !== undefined) {
    if (!isRecord(info.model)) return undefined;
    model = normalizeModel(info.model);
    if (!model) return undefined;
  }
  if (role === "assistant" && agent === undefined && metadataString(info.mode)) {
    agent = info.mode;
  }
  if (
    role === "assistant" &&
    model === undefined &&
    metadataString(info.providerID) &&
    metadataString(info.modelID)
  ) {
    model = { providerID: info.providerID, modelID: info.modelID };
  }
  for (const part of value.parts) {
    if (!isRecord(part)) return undefined;
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.length > MAX_TEXT_PART_LENGTH) {
        return undefined;
      }
      textCharacters += part.text.length;
      if (textCharacters > MAX_TEXT_CHARACTERS_PER_MESSAGE) return undefined;
      textParts.push(part.text);
    } else if (part.type === "tool") {
      if (
        !metadataString(part.tool) ||
        !isRecord(part.state) ||
        !metadataString(part.state.status)
      ) {
        return undefined;
      }
      if (toolActivity.length < MAX_TOOL_ACTIVITY_ITEMS) {
        toolActivity.push({ tool: part.tool, status: safeToolStatus(part.state.status) });
      }
    } else if (part.type === "agent" && agent === undefined) {
      if (!metadataString(part.name)) return undefined;
      agent = part.name;
    }
  }
  return {
    id: messageId,
    sessionId,
    role,
    ...(isRecord(time) && finiteNumber(time.created) ? { createdAt: time.created } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    textParts,
    toolActivity,
  };
}

function normalizeModel(value: RecordValue): NormalizedModel | undefined {
  return metadataString(value.providerID) && metadataString(value.modelID)
    ? { providerID: value.providerID, modelID: value.modelID }
    : undefined;
}

function boundedString(value: unknown): value is string {
  return limitedString(value) && value.length > 0;
}

function limitedString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_STRING_LENGTH;
}

function metadataString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_METADATA_LENGTH;
}

function safeToolStatus(value: string): string {
  return value === "pending" || value === "running" || value === "completed" || value === "error"
    ? value
    : "unknown";
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(endpoint: string): Error {
  return new Error(`OpenCode child session ${endpoint} API returned an invalid response`);
}
