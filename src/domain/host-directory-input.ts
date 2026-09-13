import { posix } from "node:path";

const UNSUPPORTED_TILDE_MESSAGE = 'Only "~" and "~/..." directory forms are supported.';

function normalizePosixDirectory(directory: string): string {
  const normalized = posix.normalize(directory);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function validateHomeDirectory(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty absolute POSIX path`);
  }
  const directory = value.trim();
  if (directory.includes("\0") || !posix.isAbsolute(directory)) {
    throw new Error(`${label} must be a non-empty absolute POSIX path`);
  }
  return normalizePosixDirectory(directory);
}

export function expandHostDirectoryInput(directory: string, homeDirectory?: string): string {
  if (directory === "~" || directory.startsWith("~/")) {
    if (!homeDirectory) {
      throw new Error("Cannot expand home-directory input: host home directory is not configured");
    }
    if (directory === "~") return homeDirectory;

    const suffix = directory.slice(2);
    return normalizePosixDirectory(posix.join(homeDirectory, suffix));
  }
  if (directory.startsWith("~")) throw new Error(UNSUPPORTED_TILDE_MESSAGE);
  return directory;
}
