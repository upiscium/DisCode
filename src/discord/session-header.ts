export type SessionHeaderContext = {
  hostId: string;
  sessionId: string;
  directory: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
  branch?: string;
};

export function renderSessionHeader(context: SessionHeaderContext): string {
  const model = context.model
    ? `${context.model.providerID}/${context.model.modelID}`
    : "(not selected)";
  const agent = context.agent || "(not selected)";
  const branch = context.branch || "(none)";

  return [
    "🤖 **OpenCode session**",
    `Host: \`${inline(context.hostId, 100)}\``,
    `Session: \`${inline(context.sessionId, 200)}\``,
    `Directory: \`${inline(context.directory, 800)}\``,
    `Model: \`${inline(model, 400)}\``,
    `Agent: \`${inline(agent, 300)}\``,
    `Branch: \`${inline(branch, 400)}\``,
    "",
    "Messages posted in this thread are sent to OpenCode.",
    "Execution permissions remain governed by OpenCode; Discord does not execute shell commands directly.",
  ].join("\n");
}

function inline(value: string, maxLength: number): string {
  const normalized = value.replace(/`/g, "ˋ").replace(/[\r\n]+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
