import { isAbsolute, relative, resolve, sep } from "node:path";

export type ToolActivityStatus = "pending" | "running" | "completed" | "error";

export type ToolActivityItem = {
  partId: string;
  tool: string;
  status: ToolActivityStatus;
  annotation?: string;
  startedAt?: number;
  endedAt?: number;
};

const FILE_FIELD_BY_TOOL: Readonly<Record<string, "filePath" | "path">> = {
  read: "filePath",
  edit: "filePath",
  write: "filePath",
  grep: "path",
  glob: "path",
};

const URL_FIELD_BY_TOOL: Readonly<Record<string, "url">> = {
  webfetch: "url",
};

const TOOL_ACTIVITY_HEADER = "🔧 **Tool activity**";
const DEFAULT_MAX_ITEMS = 12;
const DEFAULT_MAX_LENGTH = 1800;

export function safeToolAnnotation(options: {
  tool: string;
  input: Readonly<Record<string, unknown>>;
  directory: string;
}): string | undefined {
  const fileField = FILE_FIELD_BY_TOOL[options.tool];
  if (fileField) {
    const value = options.input[fileField];
    return typeof value === "string" ? safeRepositoryPath(value, options.directory) : undefined;
  }

  const urlField = URL_FIELD_BY_TOOL[options.tool];
  if (urlField) {
    const value = options.input[urlField];
    return typeof value === "string" ? safeUrl(value) : undefined;
  }

  return undefined;
}

export function renderToolActivitySummary(
  items: readonly ToolActivityItem[],
  options: { now?: number; maxItems?: number; maxLength?: number } = {},
): string {
  const now = options.now ?? Date.now();
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (maxItems < 1) throw new Error("tool summary maxItems must be positive");
  if (maxLength < 100) throw new Error("tool summary maxLength is too small");

  const visible = items.slice(-maxItems);
  let omitted = Math.max(0, items.length - visible.length);
  let lines = visible.map((item) => renderToolActivityLine(item, now));

  while (lines.length > 1 && renderSummary(lines, omitted).length > maxLength) {
    lines = lines.slice(1);
    omitted += 1;
  }

  const rendered = renderSummary(lines, omitted);
  return rendered.length <= maxLength ? rendered : `${rendered.slice(0, maxLength - 1).trimEnd()}…`;
}

function renderSummary(lines: readonly string[], omitted: number): string {
  return [
    TOOL_ACTIVITY_HEADER,
    ...(omitted > 0 ? [`… ${omitted} earlier call${omitted === 1 ? "" : "s"} omitted`] : []),
    ...lines,
  ].join("\n");
}

function renderToolActivityLine(item: ToolActivityItem, now: number): string {
  const status = statusGlyph(item.status);
  const tool = sanitizeInline(item.tool, 48);
  const annotation = item.annotation ? sanitizeInline(item.annotation, 110) : undefined;
  const duration = renderDuration(item, now);
  return [status, tool, annotation, duration].filter(Boolean).join(" — ");
}

function renderDuration(item: ToolActivityItem, now: number): string | undefined {
  if (item.startedAt === undefined) return undefined;
  const end = item.endedAt ?? (item.status === "running" ? now : undefined);
  if (end === undefined || end < item.startedAt) return undefined;
  const seconds = (end - item.startedAt) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function statusGlyph(status: ToolActivityStatus): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "running":
      return "🔄";
    case "completed":
      return "✅";
    case "error":
      return "❌";
  }
}

function safeRepositoryPath(value: string, directory: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const root = resolve(directory);
  const target = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
  const rel = relative(root, target);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "[external path]";
  return rel.split(sep).join("/");
}

function safeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function sanitizeInline(value: string, maxLength: number): string {
  const compact = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const markdownSafe = compact.replace(/[\\`*_~>|]/g, "");
  return markdownSafe.length <= maxLength
    ? markdownSafe
    : `${markdownSafe.slice(0, maxLength - 1)}…`;
}
