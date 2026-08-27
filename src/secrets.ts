import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export type SecretEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  readFile?: (path: string) => string;
};

export function resolveSecretsFilePath(
  input: string,
  options: Pick<SecretEnvironmentOptions, "cwd" | "home"> = {},
): string {
  const value = input.trim();
  if (!value) throw new Error("OCB_SECRETS_FILE must not be empty");

  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  if (value.startsWith("~")) {
    throw new Error("OCB_SECRETS_FILE supports '~' only as '~' or '~/...'");
  }
  return resolve(cwd, value);
}

export function loadSecretEnvironment(options: SecretEnvironmentOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const configured = env.OCB_SECRETS_FILE?.trim();
  if (!configured) return undefined;

  const path = resolveSecretsFilePath(configured, options);
  const readFile = options.readFile ?? ((target: string) => readFileSync(target, "utf8"));

  let content: string;
  try {
    content = readFile(path);
  } catch {
    throw new Error(`Failed to read OCB_SECRETS_FILE: ${path}`);
  }

  validateSecretEnvironmentSyntax(content, path);

  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(content);
  } catch {
    throw new Error(`Failed to parse OCB_SECRETS_FILE: ${path}`);
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key]?.trim() === "") {
      env[key] = value;
    }
  }

  return path;
}

function validateSecretEnvironmentSyntax(content: string, path: string): void {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]?.trim() ?? "";
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    if (!/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
      throw new Error(`Invalid OCB_SECRETS_FILE syntax at ${path}:${index + 1}`);
    }
  }
}
