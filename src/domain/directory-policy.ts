import { realpath, stat } from "node:fs/promises";
import { relative } from "node:path";

export class DirectoryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryPolicyError";
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export class DirectoryPolicy {
  readonly #roots: readonly string[];

  private constructor(roots: readonly string[]) {
    this.#roots = roots;
  }

  static async create(configuredRoots: readonly string[]): Promise<DirectoryPolicy> {
    const roots = await Promise.all(
      configuredRoots.map(async (root) => {
        const resolved = await realpath(root);
        const metadata = await stat(resolved);
        if (!metadata.isDirectory()) {
          throw new DirectoryPolicyError(`Allowed root is not a directory: ${root}`);
        }
        return resolved;
      }),
    );
    return new DirectoryPolicy([...new Set(roots)]);
  }

  async authorize(requestedDirectory: string): Promise<string> {
    const resolved = await realpath(requestedDirectory).catch(() => {
      throw new DirectoryPolicyError(`Directory does not exist: ${requestedDirectory}`);
    });
    const metadata = await stat(resolved);
    if (!metadata.isDirectory()) {
      throw new DirectoryPolicyError(`Path is not a directory: ${requestedDirectory}`);
    }
    if (!this.#roots.some((root) => isInside(root, resolved))) {
      throw new DirectoryPolicyError(`Directory is outside OPENCODE_ALLOWED_ROOTS: ${resolved}`);
    }
    return resolved;
  }
}
