export type SessionStatusView = {
  hostId: string;
  sessionId: string;
  status: "busy" | "retry" | "idle";
  directory: string;
  baseUrl: string;
};

export function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Cannot render a shell argument containing NUL");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function credentialFreeBaseUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}

export function renderCodeBlock(content: string, language = ""): string {
  const longestRun = Math.max(0, ...(content.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

export function renderSessionStatus(view: SessionStatusView): string {
  const attachCommand = [
    "opencode attach",
    shellQuote(credentialFreeBaseUrl(view.baseUrl)),
    "--session",
    shellQuote(view.sessionId),
    "--dir",
    shellQuote(view.directory),
  ].join(" ");

  return [
    `Host: \`${escapeInlineCode(view.hostId)}\``,
    `Session \`${escapeInlineCode(view.sessionId)}\`: **${view.status}**`,
    `Directory: \`${escapeInlineCode(view.directory)}\``,
    "TUI attach on the OpenCode host:",
    renderCodeBlock(attachCommand, "sh"),
  ].join("\n");
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "ˋ").replace(/\r?\n/g, " ");
}
