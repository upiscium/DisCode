export type ResultPart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: { status: string; error?: string; title?: string } }
  | { type: string; [key: string]: unknown };

export function chunkDiscordText(text: string, maxLength = 1900): string[] {
  if (maxLength < 100) throw new Error("maxLength is too small");
  const normalized = text.trim();
  if (!normalized) return ["(no textual result)"];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const newline = remaining.lastIndexOf("\n", maxLength);
    const space = remaining.lastIndexOf(" ", maxLength);
    const splitAt = Math.max(newline, space, Math.floor(maxLength * 0.6));
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function sanitizeThreadName(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  return (compact || "OpenCode session").slice(0, 100);
}

export function renderAssistantResult(parts: readonly ResultPart[]): string {
  const text = parts
    .filter((part): part is Extract<ResultPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");

  const toolErrors = parts
    .filter((part): part is Extract<ResultPart, { type: "tool" }> => part.type === "tool")
    .filter((part) => part.state.status === "error")
    .map((part) => `- ${part.tool}: ${part.state.error || "tool error"}`);

  const sections = [text];
  if (toolErrors.length > 0) {
    sections.push(`Tool errors:\n${toolErrors.join("\n")}`);
  }
  return sections.filter(Boolean).join("\n\n") || "(no textual result)";
}
