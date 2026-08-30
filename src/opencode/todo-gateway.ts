import { createOpencodeClient } from "@opencode-ai/sdk";

export type OpenCodeTodoItem = {
  content: string;
  status: string;
  priority: string;
  id?: string;
};

export type OpenCodeTodoUpdated = {
  sessionID: string;
  todos: OpenCodeTodoItem[];
};

const MAX_TODO_ITEMS = 500;
const MAX_TODO_CONTENT_LENGTH = 4_000;
const MAX_TODO_METADATA_LENGTH = 64;

export class OpenCodeTodoGateway {
  readonly #client: ReturnType<typeof createOpencodeClient>;

  constructor(options: { baseUrl: string; username: string; password?: string }) {
    const headers: Record<string, string> = {};
    if (options.password) {
      const credentials = Buffer.from(`${options.username}:${options.password}`, "utf8").toString(
        "base64",
      );
      headers.Authorization = `Basic ${credentials}`;
    }
    this.#client = createOpencodeClient({
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  async listTodos(directory: string, sessionId: string): Promise<OpenCodeTodoItem[]> {
    const result = await this.#client.session.todo({
      path: { id: sessionId },
      query: { directory },
      throwOnError: true,
    });
    const todos = normalizeOpenCodeTodoList(result.data);
    if (!todos) throw new Error("OpenCode session TODO API returned an invalid response");
    return todos;
  }
}

export function normalizeOpenCodeTodoList(value: unknown): OpenCodeTodoItem[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_TODO_ITEMS) return undefined;
  const todos: OpenCodeTodoItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    if (
      typeof raw.content !== "string" ||
      raw.content.length > MAX_TODO_CONTENT_LENGTH ||
      typeof raw.status !== "string" ||
      raw.status.length > MAX_TODO_METADATA_LENGTH ||
      typeof raw.priority !== "string" ||
      raw.priority.length > MAX_TODO_METADATA_LENGTH
    ) {
      return undefined;
    }
    if (typeof raw.id === "string" && raw.id.length > MAX_TODO_METADATA_LENGTH) return undefined;
    todos.push({
      content: raw.content,
      status: raw.status,
      priority: raw.priority,
      ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
    });
  }
  return todos;
}

export function normalizeOpenCodeTodoUpdated(value: unknown): OpenCodeTodoUpdated | undefined {
  if (!isRecord(value) || typeof value.sessionID !== "string" || !value.sessionID) return undefined;
  const todos = normalizeOpenCodeTodoList(value.todos);
  return todos ? { sessionID: value.sessionID, todos } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
