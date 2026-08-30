import type { OpenCodeTodoItem } from "../opencode/todo-gateway.js";

const DEFAULT_MAX_LENGTH = 1900;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MAX_TOOLS = 12;
const DEFAULT_MAX_TODOS = 12;
const UNKNOWN = "(unknown)";

export type SubagentModel = string | { providerID: string; modelID: string };

export type SubagentMetadata = {
  id: string;
  parentSessionId: string;
  title?: string;
  status?: string;
  agent?: string;
  model?: SubagentModel;
  createdAt?: string | number;
  updatedAt?: string | number;
  depth: number;
  hostId: string;
  directory: string;
};

export type SubagentTranscriptMessage = {
  role: "user" | "assistant";
  text?: string;
  textParts?: readonly string[];
  parts?: readonly SubagentTextPart[];
};

export type SubagentTextPart = { type: "text"; text: string };

/** Deliberately contains no tool input, output, or error fields. */
export type SubagentToolActivity = { tool: string; status: string };

export type SubagentDetail = SubagentMetadata & {
  messages?: readonly SubagentTranscriptMessage[];
  toolActivity?: readonly SubagentToolActivity[];
  todos?: readonly OpenCodeTodoItem[];
  todoUnavailable?: boolean;
};

export type SubagentRenderOptions = {
  maxLength?: number;
  maxItems?: number;
  maxMessages?: number;
  maxTools?: number;
  maxTodos?: number;
  maxTextLength?: number;
};

export type SubagentListAggregate = Readonly<{
  items: readonly SubagentMetadata[];
  depthBoundaryReached?: boolean;
  sessionLimitReached?: boolean;
}>;

export type SubagentListInput = readonly SubagentMetadata[] | SubagentListAggregate;

export function renderSubagentList(
  input: SubagentListInput,
  options: SubagentRenderOptions | number = {},
): string {
  const limits = getLimits(options);
  let items: readonly SubagentMetadata[];
  let depthBoundaryReached = false;
  let sessionLimitReached = false;
  if (isListAggregate(input)) {
    items = input.items;
    depthBoundaryReached = input.depthBoundaryReached === true;
    sessionLimitReached = input.sessionLimitReached === true;
  } else {
    items = input;
  }
  const visible = items.slice(0, limits.maxItems);
  const lines = visible.map((item, index) =>
    [
      `${index + 1}. ${inline(item.title ?? UNKNOWN, 100)}`,
      `Session: ${inline(item.id, 120)} · Parent: ${inline(item.parentSessionId, 120)}`,
      `Status: ${inline(item.status ?? UNKNOWN, 40)} · Agent: ${inline(item.agent ?? UNKNOWN, 60)}`,
      `Model: ${inline(renderModel(item.model), 100)} · Depth: ${item.depth}`,
      `Created: ${inline(renderValue(item.createdAt), 80)} · Updated: ${inline(renderValue(item.updatedAt), 80)}`,
    ].join("\n"),
  );
  const omitted = Math.max(0, items.length - visible.length);
  return bounded(
    [
      "🤖 **Subagents**",
      ...(depthBoundaryReached || sessionLimitReached
        ? [
            `… ${[
              ...(depthBoundaryReached ? ["deeper descendants not checked (depth boundary)"] : []),
              ...(sessionLimitReached ? ["discovery truncated (session limit)"] : []),
            ].join("; ")}`,
          ]
        : []),
      ...lines,
      ...(omitted ? [`… ${omitted} subagent(s) omitted`] : []),
    ],
    limits.maxLength,
  );
}

function isListAggregate(input: SubagentListInput): input is SubagentListAggregate {
  return !Array.isArray(input);
}

export function renderSubagentDetail(
  detail: SubagentDetail,
  options: SubagentRenderOptions | number = {},
): string {
  const limits = getLimits(options);
  const header = [
    "🤖 **Subagent detail**",
    `Session: ${inline(detail.id, 120)} · Parent: ${inline(detail.parentSessionId, 120)}`,
    `Title: ${inline(detail.title ?? UNKNOWN, 100)} · Status: ${inline(detail.status ?? UNKNOWN, 40)}`,
    `Agent: ${inline(detail.agent ?? UNKNOWN, 60)} · Model: ${inline(renderModel(detail.model), 100)}`,
    `Created: ${inline(renderValue(detail.createdAt), 80)} · Updated: ${inline(renderValue(detail.updatedAt), 80)}`,
    `Depth: ${detail.depth}`,
  ];
  const messages = detail.messages ?? [];
  const messageLines = messages.slice(-limits.maxMessages).map((message) => {
    const text = messageText(message);
    return `${message.role === "user" ? "User" : "Assistant"}: ${inline(
      text || UNKNOWN,
      limits.maxTextLength,
    )}`;
  });
  const messageOmitted = Math.max(0, messages.length - messageLines.length);
  const tools = detail.toolActivity ?? [];
  const toolLines = tools
    .slice(-limits.maxTools)
    .map((tool) => `• ${inline(tool.tool, 80)} — ${inline(tool.status, 40)}`);
  const toolOmitted = Math.max(0, tools.length - toolLines.length);
  const todos = detail.todos ?? [];
  const todoLines = todos
    .slice(0, limits.maxTodos)
    .map((todo) => `${todoStatus(todo.status)} ${inline(todo.content, limits.maxTextLength)}`);
  const todoOmitted = Math.max(0, todos.length - todoLines.length);
  const sections = [
    ...header,
    "",
    "Recent transcript",
    ...(messageLines.length ? messageLines : ["(none)"]),
    ...(messageOmitted ? [`… ${messageOmitted} message(s) omitted`] : []),
    "",
    "Tool activity",
    ...(toolLines.length ? toolLines : ["(none) — tool payloads are not rendered"]),
    ...(toolOmitted ? [`… ${toolOmitted} tool entr(y/ies) omitted`] : []),
    "",
    "TODO",
    ...(detail.todoUnavailable ? ["TODO unavailable"] : todoLines.length ? todoLines : ["(none)"]),
    ...(todoOmitted ? [`… ${todoOmitted} TODO item(s) omitted`] : []),
  ];
  return bounded(sections, limits.maxLength);
}

function getLimits(options: SubagentRenderOptions | number) {
  const value = typeof options === "number" ? { maxLength: options } : options;
  return {
    maxLength: boundedInteger(value.maxLength, DEFAULT_MAX_LENGTH, 100, "maxLength"),
    maxItems: boundedInteger(value.maxItems, DEFAULT_MAX_ITEMS, 0, "maxItems"),
    maxMessages: boundedInteger(value.maxMessages, DEFAULT_MAX_MESSAGES, 0, "maxMessages"),
    maxTools: boundedInteger(value.maxTools, DEFAULT_MAX_TOOLS, 0, "maxTools"),
    maxTodos: boundedInteger(value.maxTodos, DEFAULT_MAX_TODOS, 0, "maxTodos"),
    maxTextLength: boundedInteger(value.maxTextLength, 360, 1, "maxTextLength"),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return selected;
}

function messageText(message: SubagentTranscriptMessage): string {
  if (typeof message.text === "string") return message.text;
  if (message.textParts) return message.textParts.join(" ");
  return (message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

function renderModel(model: SubagentModel | undefined): string {
  if (!model) return UNKNOWN;
  return typeof model === "string" ? model : `${model.providerID}/${model.modelID}`;
}

function renderValue(value: string | number | undefined): string {
  return value === undefined ? UNKNOWN : String(value);
}

function todoStatus(status: string): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[~]";
  if (status === "cancelled") return "[-]";
  if (status === "pending") return "[ ]";
  return "[?]";
}

function inline(value: string, maxLength: number): string {
  const safe = value
    .replace(/@/g, "＠")
    .replace(/[\\`*_~>|]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length <= maxLength ? safe : `${safe.slice(0, Math.max(0, maxLength - 1))}…`;
}

function bounded(lines: readonly string[], maxLength: number): string {
  const full = lines.join("\n");
  if (full.length <= maxLength) return full;
  const marker = "… output truncated";
  if (maxLength <= marker.length) return marker.slice(0, maxLength);
  return `${full.slice(0, maxLength - marker.length).trimEnd()}${marker}`;
}
