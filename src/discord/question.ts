import type { OpenCodeQuestion, OpenCodeQuestionRequest } from "../opencode/gateway.js";

export function renderQuestionAsk(request: OpenCodeQuestionRequest): string {
  const lines = [`❓ **Ask**`, `Request: \`${request.id}\``];
  for (const [index, question] of request.questions.entries()) {
    lines.push("", `**${index + 1}. ${question.header}**`, question.question);
    for (const option of question.options) {
      lines.push(`- \`${escapeInlineCode(option.label)}\` — ${option.description}`);
    }
    if (question.multiple) lines.push("Multiple selections are allowed; separate labels with commas.");
  }
  lines.push(
    "",
    request.questions.length === 1
      ? "Reply to this thread with the answer. The next authorized text message is consumed as the Ask answer."
      : "Reply with one line per question, in order (for example `1: answer`). The next authorized text message is consumed as the Ask answer.",
  );
  return lines.join("\n");
}

export function parseQuestionAnswers(text: string, questions: readonly OpenCodeQuestion[]): string[][] {
  const rawAnswers =
    questions.length === 1
      ? [text.trim()]
      : text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.replace(/^\d+\s*[:.)-]\s*/, ""));

  if (rawAnswers.length !== questions.length) {
    throw new Error(`expected ${questions.length} answer line(s), got ${rawAnswers.length}`);
  }

  return rawAnswers.map((raw, index) => {
    const question = questions[index];
    if (!question) throw new Error("question index mismatch");
    const values = question.multiple
      ? raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [raw.trim()];
    if (values.length === 0 || values.some((value) => value.length === 0)) {
      throw new Error(`answer ${index + 1} is empty`);
    }
    if (question.custom === false && question.options.length > 0) {
      const labels = new Set(question.options.map((option) => option.label));
      const invalid = values.find((value) => !labels.has(value));
      if (invalid) {
        throw new Error(`answer ${index + 1} must use one of: ${[...labels].join(", ")}`);
      }
    }
    return values;
  });
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "ˋ").replace(/\r?\n/g, " ");
}
