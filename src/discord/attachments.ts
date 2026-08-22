export const MAX_ATTACHMENT_COUNT = 4;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const DIRECT_MEDIA_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);
const TEXT_APPLICATION_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
]);

export type DiscordAttachmentInput = {
  name: string;
  size: number;
  contentType?: string | null;
  url: string;
};

export type OpenCodePromptFile = {
  mime: string;
  filename: string;
  url: string;
};

export type AttachmentFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export async function prepareDiscordAttachments(
  attachments: readonly DiscordAttachmentInput[],
  fetchImpl: AttachmentFetch = fetch,
): Promise<OpenCodePromptFile[]> {
  validateAttachmentMetadata(attachments);

  const prepared: OpenCodePromptFile[] = [];
  let actualTotal = 0;
  for (const attachment of attachments) {
    const url = validateDiscordAttachmentUrl(attachment.url);
    const response = await fetchImpl(url, { redirect: "error" });
    if (!response.ok) {
      throw new AttachmentValidationError(
        `Could not download attachment ${sanitizeFilename(attachment.name)}: HTTP ${response.status}`,
      );
    }

    const contentLength = parseContentLength(response.headers.get("content-length"));
    if (contentLength !== undefined && contentLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachment ${sanitizeFilename(attachment.name)} exceeds the ${formatMiB(MAX_ATTACHMENT_BYTES)} MiB limit`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachment ${sanitizeFilename(attachment.name)} exceeds the ${formatMiB(MAX_ATTACHMENT_BYTES)} MiB limit`,
      );
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachments exceed the ${formatMiB(MAX_TOTAL_ATTACHMENT_BYTES)} MiB total limit`,
      );
    }

    const mime = classifyAttachmentMime(
      normalizeMime(attachment.contentType) ?? normalizeMime(response.headers.get("content-type")),
      bytes,
    );
    prepared.push({
      mime,
      filename: sanitizeFilename(attachment.name),
      url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
    });
  }
  return prepared;
}

export function validateAttachmentMetadata(attachments: readonly DiscordAttachmentInput[]): void {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentValidationError(`At most ${MAX_ATTACHMENT_COUNT} attachments are allowed`);
  }

  let total = 0;
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new AttachmentValidationError("Attachment size is invalid");
    }
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `Attachment ${sanitizeFilename(attachment.name)} exceeds the ${formatMiB(MAX_ATTACHMENT_BYTES)} MiB limit`,
      );
    }
    total += attachment.size;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AttachmentValidationError(
      `Attachments exceed the ${formatMiB(MAX_TOTAL_ATTACHMENT_BYTES)} MiB total limit`,
    );
  }
}

export function validateDiscordAttachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AttachmentValidationError("Attachment URL is invalid");
  }
  if (url.protocol !== "https:" || !DISCORD_ATTACHMENT_HOSTS.has(url.hostname)) {
    throw new AttachmentValidationError("Attachment URL is not an approved Discord CDN URL");
  }
  if (!url.pathname.startsWith("/attachments/")) {
    throw new AttachmentValidationError("Attachment URL is not a Discord attachment path");
  }
  return url;
}

export function sanitizeFilename(value: string): string {
  const basename = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const compact = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (compact || "attachment").slice(0, 120);
}

export function classifyAttachmentMime(declaredMime: string | undefined, bytes: Uint8Array): string {
  const detectedMedia = sniffDirectMediaMime(bytes);
  if (declaredMime && DIRECT_MEDIA_MIMES.has(declaredMime)) {
    if (detectedMedia !== declaredMime) {
      throw new AttachmentValidationError(`Attachment media signature does not match ${declaredMime}`);
    }
    return declaredMime;
  }

  if (!declaredMime && detectedMedia) return detectedMedia;

  if (declaredMime && !isTextLikeMime(declaredMime)) {
    throw new AttachmentValidationError(`Unsupported attachment type: ${declaredMime}`);
  }
  if (detectedMedia) {
    throw new AttachmentValidationError("Attachment media signature does not match its text content type");
  }
  if (!isUtf8Text(bytes)) {
    throw new AttachmentValidationError("Unsupported binary attachment; only images, PDF, and UTF-8 text are allowed");
  }
  return "text/plain";
}

function normalizeMime(value: string | null | undefined): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function isTextLikeMime(mime: string): boolean {
  return mime.startsWith("text/") || TEXT_APPLICATION_MIMES.has(mime);
}

function sniffDirectMediaMime(bytes: Uint8Array): string | undefined {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const prefix6 = ascii(bytes, 0, 6);
  if (prefix6 === "GIF87a" || prefix6 === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  return undefined;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.includes("\u0000")) return false;
  let controls = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls += 1;
  }
  return text.length === 0 || controls / text.length < 0.01;
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (bytes.byteLength < end) return "";
  return String.fromCharCode(...bytes.slice(start, end));
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}
