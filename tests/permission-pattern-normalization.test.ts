import { describe, expect, it } from "vitest";
import { normalizeBridgeGlobalEvent } from "../src/opencode/gateway.js";

describe("permission pattern normalization", () => {
  it("preserves an exact current upstream pattern array", () => {
    const event = normalizeBridgeGlobalEvent({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: {
          id: "per-1",
          sessionID: "ses-1",
          permission: "bash",
          patterns: ["ssh *", "scp *"],
        },
      },
    });

    expect(event.payload.type).toBe("permission.updated");
    if (event.payload.type !== "permission.updated") throw new Error("unexpected event type");
    expect(event.payload.properties.pattern).toEqual(["ssh *", "scp *"]);
  });

  it("does not silently filter non-string pattern elements", () => {
    const event = normalizeBridgeGlobalEvent({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: {
          id: "per-1",
          sessionID: "ses-1",
          permission: "bash",
          patterns: ["ssh *", 42],
        },
      },
    });

    expect(event.payload.type).toBe("permission.updated");
    if (event.payload.type !== "permission.updated") throw new Error("unexpected event type");
    expect(event.payload.properties.pattern).toEqual([]);
  });

  it("fails closed when pattern data is absent or not an array", () => {
    for (const patterns of [undefined, "ssh *", null]) {
      const event = normalizeBridgeGlobalEvent({
        directory: "/repo",
        payload: {
          type: "permission.asked",
          properties: {
            id: "per-1",
            sessionID: "ses-1",
            permission: "bash",
            patterns,
          },
        },
      });
      expect(event.payload.type).toBe("permission.updated");
      if (event.payload.type !== "permission.updated") throw new Error("unexpected event type");
      expect(event.payload.properties.pattern).toEqual([]);
    }
  });
});
