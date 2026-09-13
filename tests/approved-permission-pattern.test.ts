import { describe, expect, it } from "vitest";
import {
  createApprovedPermissionPattern,
  normalizeApprovedPermissionPattern,
  sameApprovedPermissionPattern,
  samePermissionPatternAuthority,
  validExactPattern,
} from "../src/domain/approved-permission-pattern.js";

const scope = {
  hostId: "host-1",
  canonicalDirectory: "/repo",
  sessionId: "ses_1",
  permissionType: "bash",
};

describe("approved permission pattern identity", () => {
  it("uses exact opaque pattern array identity", () => {
    const left = createApprovedPermissionPattern({ ...scope, pattern: ["ssh *"] });
    const same = createApprovedPermissionPattern({ ...scope, pattern: ["ssh *"] });
    const whitespace = createApprovedPermissionPattern({ ...scope, pattern: ["ssh  *"] });
    const changed = createApprovedPermissionPattern({ ...scope, pattern: ["ssh -p *"] });

    expect(left).toBeDefined();
    expect(sameApprovedPermissionPattern(left!, same!)).toBe(true);
    expect(sameApprovedPermissionPattern(left!, whitespace!)).toBe(false);
    expect(sameApprovedPermissionPattern(left!, changed!)).toBe(false);
  });

  it("does not interpret regex, glob, shell, or environment syntax", () => {
    const values = ["^ssh .*$", "ssh *", "$(touch /tmp/x)", "$HOME/*", "a[0-9]+"];
    for (const value of values) {
      const approval = createApprovedPermissionPattern({ ...scope, pattern: [value] });
      expect(approval?.pattern).toEqual([value]);
    }
  });

  it("keeps pattern order as part of identity", () => {
    expect(
      samePermissionPatternAuthority(
        { permissionType: "bash", pattern: ["one", "two"] },
        { permissionType: "bash", pattern: ["two", "one"] },
      ),
    ).toBe(false);
  });

  it("fails closed for missing, empty, non-string, or oversized patterns", () => {
    expect(validExactPattern([])).toBeUndefined();
    expect(validExactPattern([""])).toBeUndefined();
    expect(validExactPattern(["ok", 42] as unknown[])).toBeUndefined();
    expect(validExactPattern(["x".repeat(4097)])).toBeUndefined();
    expect(validExactPattern(Array.from({ length: 33 }, () => "x"))).toBeUndefined();
  });

  it("rejects persisted entries whose fingerprint does not match exact content", () => {
    const approval = createApprovedPermissionPattern({ ...scope, pattern: ["ssh *"] });
    expect(approval).toBeDefined();
    expect(normalizeApprovedPermissionPattern(approval)).toEqual(approval);
    expect(
      normalizeApprovedPermissionPattern({
        ...approval,
        pattern: ["scp *"],
      }),
    ).toBeUndefined();
  });
});
