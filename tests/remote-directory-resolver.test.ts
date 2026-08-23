import { describe, expect, it, vi } from "vitest";
import { createOpenCodeDirectoryResolver } from "../src/opencode/remote-directory-resolver.js";

const host = {
  id: "lab",
  baseUrl: "http://10.0.0.20:4096",
  username: "opencode",
  password: "secret",
  allowedRoots: ["/srv/projects"],
} as const;

describe("createOpenCodeDirectoryResolver", () => {
  it("returns the remote canonical directory and verifies directory listing", async () => {
    const transport = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/path") {
        return new Response(JSON.stringify({ directory: "/srv/projects/repo-real" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/file") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const resolveDirectory = createOpenCodeDirectoryResolver(host, transport as typeof fetch);

    await expect(resolveDirectory("/srv/projects/link")).resolves.toBe("/srv/projects/repo-real");
    expect(transport).toHaveBeenCalledTimes(2);

    const pathUrl = new URL(String(transport.mock.calls[0]?.[0]));
    expect(pathUrl.pathname).toBe("/path");
    expect(pathUrl.searchParams.get("directory")).toBe("/srv/projects/link");

    const fileUrl = new URL(String(transport.mock.calls[1]?.[0]));
    expect(fileUrl.pathname).toBe("/file");
    expect(fileUrl.searchParams.get("directory")).toBe("/srv/projects/repo-real");
    expect(fileUrl.searchParams.get("path")).toBe(".");

    const headers = new Headers(transport.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe(
      `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`,
    );
  });

  it("rejects a relative requested directory before contacting OpenCode", async () => {
    const transport = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const resolveDirectory = createOpenCodeDirectoryResolver(host, transport as typeof fetch);

    await expect(resolveDirectory("srv/projects/repo")).rejects.toThrow(/absolute path/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute canonical directory from OpenCode", async () => {
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ directory: "srv/projects/repo" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const resolveDirectory = createOpenCodeDirectoryResolver(host, transport as typeof fetch);

    await expect(resolveDirectory("/srv/projects/repo")).rejects.toThrow(/non-absolute directory/);
  });

  it("fails closed when OpenCode cannot list the canonical directory", async () => {
    const transport = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/path") {
        return new Response(JSON.stringify({ directory: "/srv/projects/repo" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("forbidden", { status: 403 });
    });
    const resolveDirectory = createOpenCodeDirectoryResolver(host, transport as typeof fetch);

    await expect(resolveDirectory("/srv/projects/repo")).rejects.toThrow(
      /directory validation failed with HTTP 403/,
    );
  });
});
