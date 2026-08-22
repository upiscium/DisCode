import {
  createOpencodeClient,
  type Event,
  type GlobalEvent,
  type Part,
  type Session,
  type SessionStatus,
} from "@opencode-ai/sdk";

export type OpenCodePermissionResponse = "once" | "always" | "reject";

export type OpenCodePromptFile = {
  mime: string;
  filename: string;
  url: string;
};

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

export type OpenCodeMessagePartDeltaEvent = {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
};

export type OpenCodeAssistantResult = {
  messageId: string;
  parts: Part[];
};

export type OpenCodeSessionHeaderContext = {
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  branch?: string;
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
    await this.promptAsyncWithFiles(directory, sessionId, text, []);
  }

  async promptAsyncWithFiles(
    directory: string,
    sessionId: string,
    text: string,
    files: readonly OpenCodePromptFile[],
  ): Promise<void> {
    const parts = [
      ...(text.trim() ? [{ type: "text" as const, text }] : []),
      ...files.map((file) => ({
        type: "file" as const,
        mime: file.mime,
        filename: file.filename,
        url: file.url,
      })),
    ];
    if (parts.length === 0)
      throw new Error("OpenCode prompt must contain text or at least one file");

    await this.#client.session.promptAsync({
      path: { id: sessionId },
      query: { directory },
      body: { parts },
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

  async sessionHeaderContext(
    directory: string,
    sessionId: string,
  ): Promise<OpenCodeSessionHeaderContext> {
    const [messageContext, branch] = await Promise.all([
      this.#latestUserContext(directory, sessionId),
      this.#vcsBranch(directory),
    ]);
    return {
      ...messageContext,
      ...(branch ? { branch } : {}),
    };
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
    const handledByCurrentApi = await this.#tryCurrentPermissionReply(
      directory,
      permissionId,
      response,
    );
    if (handledByCurrentApi) return;

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

  async #latestUserContext(
    directory: string,
    sessionId: string,
  ): Promise<Omit<OpenCodeSessionHeaderContext, "branch">> {
    const result = await this.#client.session.messages({
      path: { id: sessionId },
      query: { directory, limit: 50 },
      throwOnError: true,
    });
    const latest = [...result.data].reverse().find((message) => message.info.role === "user");
    if (latest?.info.role !== "user") return {};
    return {
      agent: latest.info.agent,
      model: {
        providerID: latest.info.model.providerID,
        modelID: latest.info.model.modelID,
      },
    };
  }

  async #vcsBranch(directory: string): Promise<string | undefined> {
    const url = new URL(`${this.#baseUrl}/vcs`);
    url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      method: "GET",
      headers: this.#headers,
    });
    if (!response.ok) {
      throw new Error(`OpenCode VCS API failed: ${response.status} ${await response.text()}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("OpenCode VCS API returned an invalid response");
    return typeof body.branch === "string" && body.branch ? body.branch : undefined;
  }

  async #tryCurrentPermissionReply(
    directory: string,
    requestId: string,
    reply: OpenCodePermissionResponse,
  ): Promise<boolean> {
    const url = new URL(`${this.#baseUrl}/permission/${encodeURIComponent(requestId)}/reply`);
    url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.#headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reply }),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(
        `OpenCode permission API failed: ${response.status} ${await response.text()}`,
      );
    }
    return true;
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
          yield normalizeBridgeGlobalEvent(event);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function normalizeBridgeGlobalEvent(event: unknown): BridgeGlobalEvent {
  if (!isRecord(event) || typeof event.directory !== "string" || !isRecord(event.payload)) {
    return event as BridgeGlobalEvent;
  }

  const payload = event.payload;
  if (payload.type === "permission.asked" && isRecord(payload.properties)) {
    const properties = payload.properties;
    if (
      typeof properties.id === "string" &&
      typeof properties.sessionID === "string" &&
      typeof properties.permission === "string"
    ) {
      const tool = isRecord(properties.tool) ? properties.tool : undefined;
      const messageID = tool && typeof tool.messageID === "string" ? tool.messageID : "";
      const callID = tool && typeof tool.callID === "string" ? tool.callID : undefined;
      return {
        directory: event.directory,
        payload: {
          type: "permission.updated",
          properties: {
            id: properties.id,
            type: properties.permission,
            pattern: stringArray(properties.patterns),
            sessionID: properties.sessionID,
            messageID,
            ...(callID ? { callID } : {}),
            title: properties.permission,
            metadata: isRecord(properties.metadata) ? properties.metadata : {},
            time: { created: Date.now() },
          },
        },
      };
    }
  }

  if (payload.type === "permission.replied" && isRecord(payload.properties)) {
    const properties = payload.properties;
    if (
      typeof properties.sessionID === "string" &&
      typeof properties.requestID === "string" &&
      typeof properties.reply === "string"
    ) {
      return {
        directory: event.directory,
        payload: {
          type: "permission.replied",
          properties: {
            sessionID: properties.sessionID,
            permissionID: properties.requestID,
            response: properties.reply,
          },
        },
      };
    }
  }

  return event as BridgeGlobalEvent;
}

// Re-export the event union for bridge-side exhaustiveness without exposing the SDK client itself.
export type OpenCodeEvent =
  | Event
  | OpenCodeQuestionAskedEvent
  | OpenCodeQuestionRepliedEvent
  | OpenCodeQuestionRejectedEvent
  | OpenCodeMessagePartDeltaEvent;

export type BridgeGlobalEvent = Omit<GlobalEvent, "payload"> & { payload: OpenCodeEvent };
