import type { OpenCodeTodoItem } from "../opencode/gateway.js";

const DEFAULT_MAX_LENGTH = 1900;

export function renderTodoPanel(
  todos: readonly OpenCodeTodoItem[],
  maxLength = DEFAULT_MAX_LENGTH,
): string {
  if (!Number.isInteger(maxLength) || maxLength < 200) {
    throw new Error("TODO panel max length must be an integer >= 200");
  }

  const counts = countStatuses(todos);
  const header = [
    "📝 **TODO**",
    `pending ${counts.pending} · in progress ${counts.inProgress} · completed ${counts.completed} · cancelled ${counts.cancelled}`,
  ];

  if (todos.length === 0) return [...header, "_No current TODO items._"].join("\n");

  const lines = todos.map(renderTodoLine);
  const output = [...header];
  let shown = 0;

  for (const line of lines) {
    const remaining = lines.length - (shown + 1);
    const suffix = remaining > 0 ? `\n… +${remaining} more` : "";
    const candidate = [...output, line].join("\n") + suffix;
    if (candidate.length > maxLength) break;
    output.push(line);
    shown += 1;
  }

  const hidden = lines.length - shown;
  if (hidden > 0) {
    const suffix = `… +${hidden} more`;
    while (output.length > header.length && [...output, suffix].join("\n").length > maxLength) {
      output.pop();
      shown -= 1;
    }
    const finalHidden = lines.length - shown;
    output.push(`… +${finalHidden} more`);
  }

  return output.join("\n").slice(0, maxLength);
}

function renderTodoLine(todo: OpenCodeTodoItem): string {
  const status = statusSymbol(todo.status);
  const priority = normalizeInline(todo.priority || "unknown");
  const content = normalizeContent(todo.content);
  return `${status} \`${priority}\` ${content}`;
}

function statusSymbol(status: string): string {
  switch (status) {
    case "pending":
      return "[ ]";
    case "in_progress":
      return "[~]";
    case "completed":
      return "[x]";
    case "cancelled":
      return "[-]";
    default:
      return "[?]";
  }
}

function countStatuses(todos: readonly OpenCodeTodoItem[]): {
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
} {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let cancelled = 0;
  for (const todo of todos) {
    if (todo.status === "pending") pending += 1;
    else if (todo.status === "in_progress") inProgress += 1;
    else if (todo.status === "completed") completed += 1;
    else if (todo.status === "cancelled") cancelled += 1;
  }
  return { pending, inProgress, completed, cancelled };
}

function normalizeInline(value: string): string {
  return value.replace(/`/g, "ˋ").replace(/\r?\n/g, " ").trim();
}

function normalizeContent(value: string): string {
  return normalizeInline(value)
    .replace(/\\/g, "\\\\")
    .replace(/([*_~|>])/g, "\\$1")
    .replace(/@/g, "＠");
}
