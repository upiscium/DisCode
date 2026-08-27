import { describe, expect, it } from "vitest";
import { hasPendingPermissionRequest } from "../src/bridge/permission-publication.js";
import type { OpenCodePermissionRequest } from "../src/opencode/gateway.js";

const current: OpenCodePermissionRequest[] = [
  {
    id: "per_current",
    sessionID: "ses_1",
    type: "bash",
    title: "bash",
    pattern: ["git status"],
  },
  {
    id: "per_same_id",
    sessionID: "ses_other",
    type: "bash",
    title: "bash",
    pattern: ["git diff"],
  },
];

describe("permission button pending-state validation", () => {
  it("accepts only an exact current session/request pair", () => {
    expect(hasPendingPermissionRequest(current, "ses_1", "per_current")).toBe(true);
    expect(hasPendingPermissionRequest(current, "ses_1", "per_missing")).toBe(false);
    expect(hasPendingPermissionRequest(current, "ses_1", "per_same_id")).toBe(false);
    expect(hasPendingPermissionRequest([], "ses_1", "per_current")).toBe(false);
  });
});
