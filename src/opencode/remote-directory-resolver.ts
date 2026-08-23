import type { OpenCodeHostConfig } from "../domain/host-registry.js";

export type DirectoryValidationTransport = typeof fetch;

export function createOpenCodeDirectoryResolver(
  host: OpenCodeHostConfig,
  transport: DirectoryValidationTransport = fetch,
): (directory: string) => Promise<string> {
  const headers = authorizationHeaders(host);

  return async (requestedDirectory: string): Promise<string> => {
    const pathUrl = new URL(`${host.baseUrl}/path`);
    pathUrl.searchParams.set("directory", requestedDirectory);
    const pathResponse = await transport(pathUrl, {
      method: "GET",
      headers,
    });
    if (!pathResponse.ok) {
      throw new Error(`OpenCode path validation failed with HTTP ${pathResponse.status}`);
    }

    const pathBody: unknown = await pathResponse.json();
    if (!isRecord(pathBody) || typeof pathBody.directory !== "string" || !pathBody.directory) {
      throw new Error("OpenCode path validation returned an invalid directory");
    }
    const canonicalDirectory = pathBody.directory;

    const listUrl = new URL(`${host.baseUrl}/file`);
    listUrl.searchParams.set("directory", canonicalDirectory);
    listUrl.searchParams.set("path", ".");
    const listResponse = await transport(listUrl, {
      method: "GET",
      headers,
    });
    if (!listResponse.ok) {
      throw new Error(`OpenCode directory validation failed with HTTP ${listResponse.status}`);
    }
    const listing: unknown = await listResponse.json();
    if (!Array.isArray(listing)) {
      throw new Error("OpenCode directory validation returned an invalid listing");
    }

    return canonicalDirectory;
  };
}

function authorizationHeaders(host: OpenCodeHostConfig): Readonly<Record<string, string>> {
  if (!host.password) return {};
  const credentials = Buffer.from(`${host.username}:${host.password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${credentials}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
