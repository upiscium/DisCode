import { chunkDiscordText } from "./format.js";

const STREAMING_HEADER = "💬 **Streaming…**\n";
const STREAMING_PREVIEW_LIMIT = 1800;
const FINAL_CHUNK_LIMIT = 1800;

export function renderAssistantStreamingPreview(
  text: string,
  maxLength = STREAMING_PREVIEW_LIMIT,
): string {
  if (maxLength <= STREAMING_HEADER.length + 10) {
    throw new Error("streaming preview maxLength is too small");
  }
  const normalized = text.trimEnd();
  const available = maxLength - STREAMING_HEADER.length;
  if (normalized.length <= available) return `${STREAMING_HEADER}${normalized}`;
  return `${STREAMING_HEADER}…${normalized.slice(-(available - 1))}`;
}

export async function deliverCanonicalAssistantResult(options: {
  rendered: string;
  send: (content: string) => Promise<unknown>;
  editPreview?: (content: string) => Promise<unknown>;
  onPreviewEditError?: (error: unknown) => void;
}): Promise<void> {
  const chunks = chunkDiscordText(options.rendered, FINAL_CHUNK_LIMIT);
  const first = `✅ **Result**\n${chunks[0]}`;

  if (options.editPreview) {
    try {
      await options.editPreview(first);
    } catch (error) {
      options.onPreviewEditError?.(error);
      await options.send(first);
      for (const chunk of chunks.slice(1)) await options.send(chunk);
      return;
    }

    for (const chunk of chunks.slice(1)) await options.send(chunk);
    return;
  }

  await options.send(first);
  for (const chunk of chunks.slice(1)) await options.send(chunk);
}
