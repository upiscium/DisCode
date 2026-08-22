import {
  createOpencodeClient,
  type Event,
  type GlobalEvent,
  type Part,
  type Session,
  type SessionStatus,
} from "@opencode-ai/sdk";

export type OpenCodePermissionResponse = "once" | "always" | "reject";

export type OpenCodeQuestion = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
};

export type OpenCodeQuestionRequest = {
  id: string;
  sessionID: string;
  questions: OpenCodeQuestion[];
};

export type OpenCodeQuestionAskedEvent = {
  type: "question.asked";
  properties: OpenCodeQuestionRequest;
};

export type OpenCodeQuestionRepliedEvent = {
  type: "question.replied";
  properties: { sessionID: string; requestID: string; answers: string[][] };
};

export type OpenCodeQuestionRejectedEvent = {
  type: "question.rejected";
  properties: { sessionID: string; requestID: string };
};

export type OpenCodeAssistantResult = {
  messageId: string;
  parts: Part[];
};

export class OpenCodeGateway {
  readonly #client: ReturnType<typeof createOpencodeClient>;
  readonly #baseUrl: string;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(options: { baseUrl: string; username: string; password?: string }) {
    const headers: Record<string, string> = {};
    if (options.password) {
      const credentials = Buffer.from(`${options.username}:${options.password}`, "utf8").toString(
        "base64",
      );
      headers.Authorization = `Basic ${credentials}`;
    }
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#headers = headers;
    this.#client = createOpencodeClient({
      baseUrl: this.#baseUrl,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  async createSession(directory: string, title: string): Promise<Session> {
    const result = await this.#client.session.create({
      body: { title },
      query: { directory },
      throwOnError: true,
    });
    return result.data;
  }

  async deleteSession(directory: string, sessionId: string): Promise<void> {
    await this.#client.session.delete({
      path: { id: sessionId },
      query: { directory },
      throwOnError: true,
    });
  }

  async promptAsync(directory: string, sessionId: string, text: string): Promise<void> {
    await this.#client.session.promptAsync({
      path: { id: sessionId },
      query: { directory },
      body: {
        parts: [{ type: "text", text }],
      },
      throwOnError: true,
    });
  }

  async abort(directory: string, sessionId: string): Promise<void> {
    await this.#client.session.abort({
      path: { id: sessionId },
      query: { directory },
      throwOnError: true,
    });
  }

  async status(directory: string, sessionId: string): Promise<SessionStatus | undefined> {
    const result = await this.#client.session.status({
      query: { directory },
      throwOnError: true,
    });
    return result.data[sessionId];
  }

  async latestAssistantResult(
    directory: string,
    sessionId: string,
  ): Promise<OpenCodeAssistantResult | undefined> {
    const result = await this.#client.session.messages({
      path: { id: sessionId },
      query: { directory, limit: 20 },
      throwOnError: true,
    });
    const latest = [...result.data].reverse().find((message) => message.info.role === "assistant");
    if (!latest) return undefined;
    return { messageId: latest.info.id, parts: latest.parts };
  }

  async replyPermission(
    directory: string,
    sessionId: string,
    permissionId: string,
    response: OpenCodePermissionResponse,
  ): Promise<void> {
    await this.#client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      query: { directory },
      body: { response },
      throwOnError: true,
    });
  }

  async replyQuestion(directory: string, requestId: string, answers: string[][]): Promise<void> {
    await this.#requestQuestion(
      "POST",
      `/question/${encodeURIComponent(requestId)}/reply`,
      directory,
      { answers },
    );
  }

  async rejectQuestion(directory: string, requestId: string): Promise<void> {
    await this.#requestQuestion(
      "POST",
      `/question/${encodeURIComponent(requestId)}/reject`,
      directory,
    );
  }

  async listQuestions(directory: string): Promise<OpenCodeQuestionRequest[]> {
    return this.#requestQuestion<OpenCodeQuestionRequest[]>("GET", "/question", directory);
  }

  async #requestQuestion<T = unknown>(
    method: "GET" | "POST",
    path: string,
    directory: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      method,
      headers: {
        ...this.#headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`OpenCode question API failed: ${response.status} ${await response.text()}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async *events(signal?: AbortSignal): AsyncGenerator<BridgeGlobalEvent> {
    let backoffMs = 1000;
    while (!signal?.aborted) {
      try {
        const subscription = await this.#client.global.event({
          ...(signal ? { signal } : {}),
        });
        for await (const event of subscription.stream) {
          if (signal?.aborted) return;
          yield event as BridgeGlobalEvent;
        }
        backoffMs = 1000;
      } catch (error) {
        if (signal?.aborted) return;
        console.error("OpenCode event stream disconnected", error);
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// Re-export the event union for bridge-side exhaustiveness without exposing the SDK client itself.
export type OpenCodeEvent =
  | Event
  | OpenCodeQuestionAskedEvent
  | OpenCodeQuestionRepliedEvent
  | OpenCodeQuestionRejectedEvent;

export type BridgeGlobalEvent = Omit<GlobalEvent, "payload"> & { payload: OpenCodeEvent };
