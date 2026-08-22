import { describe, expect, it, vi } from "vitest";
import {
  AttachmentValidationError,
  classifyAttachmentMime,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_ATTACHMENT_BYTES,
  prepareDiscordAttachments,
  sanitizeFilename,
  validateAttachmentMetadata,
  validateDiscordAttachmentUrl,
} from "../src/discord/attachments.js";

describe("Discord attachment policy", () => {
  it("accepts only HTTPS Discord attachment CDN URLs", () => {
    expect(
      validateDiscordAttachmentUrl(
        "https://cdn.discordapp.com/attachments/123/456/example.txt?ex=signed",
      ).hostname,
    ).toBe("cdn.discordapp.com");
    expect(() =>
      validateDiscordAttachmentUrl("https://example.com/attachments/123/456/example.txt"),
    ).toThrow(AttachmentValidationError);
    expect(() =>
      validateDiscordAttachmentUrl("http://cdn.discordapp.com/attachments/123/456/example.txt"),
    ).toThrow(AttachmentValidationError);
    expect(() => validateDiscordAttachmentUrl("https://cdn.discordapp.com/not-attachments/x")).toThrow(
      AttachmentValidationError,
    );
  });

  it("sanitizes filenames without using them as paths", () => {
    expect(sanitizeFilename("../../secret\nname.txt")).toBe("secretname.txt");
    expect(sanitizeFilename("..\\..\\windows.txt")).toBe("windows.txt");
    expect(sanitizeFilename("\u0000\n")).toBe("attachment");
    expect(sanitizeFilename("x".repeat(200))).toHaveLength(120);
  });

  it("enforces attachment count, per-file size, and total size", () => {
    const attachment = (size: number) => ({
      name: "a.txt",
      size,
      contentType: "text/plain",
      url: "https://cdn.discordapp.com/attachments/1/2/a.txt",
    });
    expect(() => validateAttachmentMetadata(Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => attachment(1)))).toThrow(
      /At most/,
    );
    expect(() => validateAttachmentMetadata([attachment(MAX_ATTACHMENT_BYTES + 1)])).toThrow(
      /10 MiB/,
    );
    expect(() =>
      validateAttachmentMetadata([
        attachment(MAX_TOTAL_ATTACHMENT_BYTES / 2 + 1),
        attachment(MAX_TOTAL_ATTACHMENT_BYTES / 2),
      ]),
    ).toThrow(/20 MiB/);
  });
});

describe("attachment MIME classification", () => {
  it("validates direct media signatures", () => {
    expect(
      classifyAttachmentMime(
        "image/png",
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
      ),
    ).toBe("image/png");
    expect(classifyAttachmentMime("application/pdf", new TextEncoder().encode("%PDF-1.7\n"))).toBe(
      "application/pdf",
    );
    expect(() =>
      classifyAttachmentMime("image/png", new TextEncoder().encode("not a png")),
    ).toThrow(/signature/);
  });

  it("normalizes UTF-8 text-like attachments to text/plain", () => {
    expect(classifyAttachmentMime("application/json", new TextEncoder().encode('{"ok":true}'))).toBe(
      "text/plain",
    );
    expect(classifyAttachmentMime(undefined, new TextEncoder().encode("plain UTF-8 text"))).toBe(
      "text/plain",
    );
  });

  it("rejects unsupported and binary payloads", () => {
    expect(() =>
      classifyAttachmentMime("application/zip", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])),
    ).toThrow(/Unsupported attachment type/);
    expect(() => classifyAttachmentMime(undefined, Uint8Array.from([0xff, 0x00, 0xfe, 0x01]))).toThrow(
      /Unsupported binary attachment/,
    );
  });
});

describe("prepareDiscordAttachments", () => {
  it("downloads without redirects and returns a data URL", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response("hello attachment", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "16" },
      });
    });

    const result = await prepareDiscordAttachments(
      [
        {
          name: "notes.md",
          size: 16,
          contentType: "text/markdown; charset=utf-8",
          url: "https://cdn.discordapp.com/attachments/1/2/notes.md?ex=signed",
        },
      ],
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.mime).toBe("text/plain");
    expect(result[0]?.filename).toBe("notes.md");
    expect(result[0]?.url).toBe(
      `data:text/plain;base64,${Buffer.from("hello attachment").toString("base64")}`,
    );
  });

  it("rejects unsupported response content without returning a partial set", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("first", { headers: { "content-type": "text/plain" } });
      }
      return new Response(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), {
        headers: { "content-type": "application/zip" },
      });
    });

    await expect(
      prepareDiscordAttachments(
        [
          {
            name: "first.txt",
            size: 5,
            contentType: "text/plain",
            url: "https://cdn.discordapp.com/attachments/1/2/first.txt",
          },
          {
            name: "archive.zip",
            size: 4,
            contentType: "application/zip",
            url: "https://cdn.discordapp.com/attachments/1/2/archive.zip",
          },
        ],
        fetchImpl,
      ),
    ).rejects.toThrow(/Unsupported attachment type/);
  });

  it("enforces actual and Content-Length size limits", async () => {
    const metadata = {
      name: "large.txt",
      size: 1,
      contentType: "text/plain",
      url: "https://cdn.discordapp.com/attachments/1/2/large.txt",
    };
    await expect(
      prepareDiscordAttachments([metadata], async () =>
        new Response("x", {
          headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1), "content-type": "text/plain" },
        }),
      ),
    ).rejects.toThrow(/10 MiB/);
  });
});
