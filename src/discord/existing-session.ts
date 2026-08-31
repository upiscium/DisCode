import {
  compareExistingSessions,
  type DiscoveredExistingSession,
  type ExistingSessionScope,
  isEligibleExistingSession,
} from "../opencode/existing-session-discovery.js";

const DEFAULT_MAX_LENGTH = 1_900;
const DEFAULT_MAX_ITEMS = 20;
const MAX_CHOICES = 25;
const MAX_CHOICE_LENGTH = 100;
const UNKNOWN = "(unknown)";

export type ExistingSessionRenderOptions = {
  maxLength?: number;
  maxItems?: number;
};

export type ExistingSessionChoice = { name: string; value: string };

export function renderExistingSessions(
  items: readonly DiscoveredExistingSession[],
  options: ExistingSessionRenderOptions = {},
): string {
  const maxLength = integerOption(options.maxLength, DEFAULT_MAX_LENGTH, "maxLength");
  const maxItems = integerOption(options.maxItems, DEFAULT_MAX_ITEMS, "maxItems");
  const visible = items.slice(0, maxItems);
  const lines = ["🗂️ **OpenCode sessions**", ""];

  if (items.length === 0) lines.push("No existing sessions.");
  for (const [index, item] of visible.entries()) {
    lines.push(
      [
        `${index + 1}. ${inline(item.title ?? UNKNOWN, 120)}`,
        `Session: ${inline(item.id, 120)}`,
        `Status: ${inline(item.status ?? UNKNOWN, 40)}`,
        `Updated: ${inline(updatedText(item.updatedAt), 40)}`,
        `Binding: ${item.binding}`,
      ].join("\n"),
    );
  }
  const omitted = Math.max(0, items.length - visible.length);
  if (omitted > 0) lines.push(`… ${omitted} session(s) omitted`);
  return bounded(lines.join("\n"), maxLength);
}

export function projectExistingSessionChoices(
  items: readonly DiscoveredExistingSession[],
  options: ExistingSessionScope & { query?: string },
): ExistingSessionChoice[] {
  const query = sanitize(options.query ?? "").toLowerCase();
  return items
    .filter((item) => isEligibleExistingSession(item, options))
    .filter((item) => item.binding === "unbound")
    .filter((item) => {
      if (!query) return true;
      return `${sanitize(item.title ?? "")} ${sanitize(item.id)}`.toLowerCase().includes(query);
    })
    .sort(compareExistingSessions)
    .map((item) => ({
      name: inline(
        `${item.title ?? UNKNOWN} · ${item.status ?? UNKNOWN} · ${updatedText(item.updatedAt)}`,
        MAX_CHOICE_LENGTH,
      ),
      value: item.id,
    }))
    .filter(
      (choice) =>
        choice.name.length <= MAX_CHOICE_LENGTH && choice.value.length <= MAX_CHOICE_LENGTH,
    )
    .slice(0, MAX_CHOICES);
}

function updatedText(value: number | undefined): string {
  if (value === undefined) return UNKNOWN;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? UNKNOWN : date.toISOString();
}

function integerOption(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return selected;
}

function sanitize(value: string): string {
  return value
    .replace(/@/g, "＠")
    .replace(/[\\`*_~>|]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inline(value: string, maxLength: number): string {
  const safe = sanitize(value);
  return safe.length <= maxLength ? safe : `${safe.slice(0, Math.max(0, maxLength - 1))}…`;
}

function bounded(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = "… output truncated";
  if (maxLength <= marker.length) return marker.slice(0, maxLength);
  return `${value.slice(0, maxLength - marker.length).trimEnd()}${marker}`;
}
