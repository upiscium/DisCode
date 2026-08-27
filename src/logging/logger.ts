export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";

export type LogFields = Readonly<Record<string, unknown>>;

export type LoggerLike = {
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields, error?: unknown): void;
  error(event: string, message: string, fields?: LogFields, error?: unknown): void;
};

type LoggerOptions = {
  level: LogLevel;
  format: LogFormat;
  secrets?: readonly string[];
  write?: (line: string) => void;
  now?: () => Date;
};

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = "[REDACTED]";
const OMITTED = "[OMITTED]";
const SENSITIVE_KEY = /(token|password|authorization|secret|credential)/i;
const CONTENT_KEY = /(^|_)(prompt|answer|tool_output|attachment_content|message_content|raw_content|content)($|_)/i;

export class Logger implements LoggerLike {
  readonly #level: LogLevel;
  readonly #format: LogFormat;
  readonly #secrets: readonly string[];
  readonly #write: (line: string) => void;
  readonly #now: () => Date;

  constructor(options: LoggerOptions) {
    this.#level = options.level;
    this.#format = options.format;
    this.#secrets = Object.freeze([...new Set((options.secrets ?? []).filter(Boolean))]);
    this.#write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.#now = options.now ?? (() => new Date());
  }

  debug(event: string, message: string, fields: LogFields = {}): void {
    this.#emit("debug", event, message, fields);
  }

  info(event: string, message: string, fields: LogFields = {}): void {
    this.#emit("info", event, message, fields);
  }

  warn(event: string, message: string, fields: LogFields = {}, error?: unknown): void {
    this.#emit("warn", event, message, fields, error);
  }

  error(event: string, message: string, fields: LogFields = {}, error?: unknown): void {
    this.#emit("error", event, message, fields, error);
  }

  #emit(
    level: LogLevel,
    event: string,
    message: string,
    fields: LogFields,
    error?: unknown,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;

    const record: Record<string, unknown> = {
      timestamp: this.#now().toISOString(),
      level,
      event: this.#redactString(event),
      message: this.#redactString(message),
    };

    for (const [key, value] of Object.entries(fields)) {
      const sanitized = this.#sanitizeField(key, value);
      if (sanitized !== undefined) record[key] = sanitized;
    }

    if (error !== undefined) {
      const normalized = normalizeError(error);
      record.error_type = this.#redactString(normalized.type);
      record.error_message = this.#redactString(normalized.message);
    }

    this.#write(this.#format === "json" ? JSON.stringify(record) : formatPretty(record));
  }

  #sanitizeField(key: string, value: unknown): string | number | boolean | null | undefined {
    if (value === undefined) return undefined;
    if (SENSITIVE_KEY.test(key)) return REDACTED;
    if (CONTENT_KEY.test(key)) return OMITTED;
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return this.#redactString(value);
    return OMITTED;
  }

  #redactString(value: string): string {
    let result = value;
    for (const secret of this.#secrets) {
      result = result.split(secret).join(REDACTED);
    }
    return result;
  }
}

export const noopLogger: LoggerLike = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  throw new Error("OCB_LOG_LEVEL must be one of: debug, info, warn, error");
}

export function parseLogFormat(
  value: string | undefined,
  fallback: LogFormat = "pretty",
): LogFormat {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (normalized === "json" || normalized === "pretty") return normalized;
  throw new Error("OCB_LOG_FORMAT must be one of: json, pretty");
}

function normalizeError(error: unknown): { type: string; message: string } {
  if (error instanceof Error) {
    return {
      type: error.name || "Error",
      message: error.message || "Error without message",
    };
  }
  if (typeof error === "string") return { type: "NonError", message: error };
  return { type: "NonError", message: "Non-Error value" };
}

function formatPretty(record: Readonly<Record<string, unknown>>): string {
  const timestamp = String(record.timestamp);
  const level = String(record.level).toUpperCase();
  const event = String(record.event);
  const message = String(record.message);
  const fields = Object.entries(record)
    .filter(([key]) => !new Set(["timestamp", "level", "event", "message"]).has(key))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return `${timestamp} ${level} ${event}: ${message}${fields ? ` ${fields}` : ""}`;
}
