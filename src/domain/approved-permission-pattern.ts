import { createHash } from "node:crypto";

const MAX_PATTERN_ITEMS = 32;
const MAX_PATTERN_LENGTH = 4096;
const MAX_PATTERN_TOTAL_LENGTH = 16_384;

export type ApprovedPermissionPattern = Readonly<{
  hostId: string;
  canonicalDirectory: string;
  sessionId: string;
  permissionType: string;
  pattern: readonly string[];
  patternFingerprint: string;
}>;

export type ApprovedPermissionPatternInput = Readonly<{
  hostId: string;
  canonicalDirectory: string;
  sessionId: string;
  permissionType: string;
  pattern: readonly string[];
}>;

export function createApprovedPermissionPattern(
  input: ApprovedPermissionPatternInput,
): ApprovedPermissionPattern | undefined {
  if (!input.hostId || !input.canonicalDirectory || !input.sessionId || !input.permissionType) {
    return undefined;
  }
  const pattern = validExactPattern(input.pattern);
  if (!pattern) return undefined;
  return {
    hostId: input.hostId,
    canonicalDirectory: input.canonicalDirectory,
    sessionId: input.sessionId,
    permissionType: input.permissionType,
    pattern,
    patternFingerprint: fingerprintPattern(pattern),
  };
}

export function normalizeApprovedPermissionPattern(
  value: unknown,
): ApprovedPermissionPattern | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.hostId !== "string" ||
    typeof value.canonicalDirectory !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.permissionType !== "string" ||
    typeof value.patternFingerprint !== "string" ||
    !Array.isArray(value.pattern)
  ) {
    return undefined;
  }
  const candidate = createApprovedPermissionPattern({
    hostId: value.hostId,
    canonicalDirectory: value.canonicalDirectory,
    sessionId: value.sessionId,
    permissionType: value.permissionType,
    pattern: value.pattern,
  });
  if (!candidate || candidate.patternFingerprint !== value.patternFingerprint) return undefined;
  return candidate;
}

export function sameApprovedPermissionPattern(
  left: ApprovedPermissionPattern,
  right: ApprovedPermissionPattern,
): boolean {
  return (
    left.hostId === right.hostId &&
    left.canonicalDirectory === right.canonicalDirectory &&
    left.sessionId === right.sessionId &&
    left.permissionType === right.permissionType &&
    left.patternFingerprint === right.patternFingerprint &&
    sameExactPattern(left.pattern, right.pattern)
  );
}

export function samePermissionPatternAuthority(
  left: Readonly<{ permissionType: string; pattern: readonly string[] }>,
  right: Readonly<{ permissionType: string; pattern: readonly string[] }>,
): boolean {
  return left.permissionType === right.permissionType && sameExactPattern(left.pattern, right.pattern);
}

export function validExactPattern(value: readonly unknown[]): readonly string[] | undefined {
  if (value.length === 0 || value.length > MAX_PATTERN_ITEMS) return undefined;
  let total = 0;
  const pattern: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_PATTERN_LENGTH) {
      return undefined;
    }
    total += item.length;
    if (total > MAX_PATTERN_TOTAL_LENGTH) return undefined;
    pattern.push(item);
  }
  return pattern;
}

function sameExactPattern(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fingerprintPattern(pattern: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(pattern), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
