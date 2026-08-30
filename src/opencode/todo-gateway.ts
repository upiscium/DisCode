import { createOpencodeClient } from "@opencode-ai/sdk";

export type OpenCodeTodoItem = {
  content: string;
  status: string;
  priority: string;
  id?: string;
};

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
  if (!Array.isArray(value)) return undefined;
  const todos: OpenCodeTodoItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    if (
      typeof raw.content !== "string" ||
      typeof raw.status !== "string" ||
      typeof raw.priority !== "string"
    ) {
      return undefined;
    }
    todos.push({
      content: raw.content,
      status: raw.status,
      priority: raw.priority,
      ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
    });
  }
  return todos;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
