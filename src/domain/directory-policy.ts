import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export class DirectoryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryPolicyError";
  }
}

export type DirectoryResolver = (directory: string) => Promise<string>;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function localDirectoryResolver(requestedDirectory: string): Promise<string> {
  const resolved = await realpath(requestedDirectory).catch(() => {
    throw new DirectoryPolicyError(`Directory does not exist: ${requestedDirectory}`);
  });
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new DirectoryPolicyError(`Path is not a directory: ${requestedDirectory}`);
  }
  return resolved;
}

export class DirectoryPolicy {
  readonly #roots: readonly string[];
  readonly #resolveDirectory: DirectoryResolver;

  private constructor(roots: readonly string[], resolveDirectory: DirectoryResolver) {
    this.#roots = roots;
    this.#resolveDirectory = resolveDirectory;
  }

  static async create(configuredRoots: readonly string[]): Promise<DirectoryPolicy> {
    return this.createWithResolver(configuredRoots, localDirectoryResolver);
  }

  static async createWithResolver(
    configuredRoots: readonly string[],
    resolveDirectory: DirectoryResolver,
  ): Promise<DirectoryPolicy> {
    const roots = await Promise.all(
      configuredRoots.map(async (root) => {
        try {
          return await resolveDirectory(root);
        } catch (error) {
          if (error instanceof DirectoryPolicyError) throw error;
          throw new DirectoryPolicyError(
            `Allowed root is not a safe directory: ${root}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    return new DirectoryPolicy([...new Set(roots)], resolveDirectory);
  }

  async authorize(requestedDirectory: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await this.#resolveDirectory(requestedDirectory);
    } catch (error) {
      if (error instanceof DirectoryPolicyError) throw error;
      throw new DirectoryPolicyError(
        `Directory is not accessible: ${requestedDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!this.#roots.some((root) => isInside(root, resolved))) {
      throw new DirectoryPolicyError(`Directory is outside configured allowed roots: ${resolved}`);
    }
    return resolved;
  }
}
