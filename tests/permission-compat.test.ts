import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBridgeGlobalEvent, OpenCodeGateway } from "../src/opencode/gateway.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenCode permission compatibility", () => {
  it("normalizes current permission.asked into the legacy bridge shape", () => {
    const event = normalizeBridgeGlobalEvent({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["printf 'ok\\n'"],
          metadata: {},
          always: ["printf *"],
          tool: { messageID: "msg_1", callID: "call_1" },
        },
      },
    });

    expect(event.payload.type).toBe("permission.updated");
    if (event.payload.type !== "permission.updated") throw new Error("unexpected event type");
    expect(event.payload.properties).toMatchObject({
      id: "per_1",
      sessionID: "ses_1",
      type: "bash",
      title: "bash",
      pattern: ["printf 'ok\\n'"],
      messageID: "msg_1",
      callID: "call_1",
    });
  });

  it("normalizes current permission.replied into the legacy bridge shape", () => {
    const event = normalizeBridgeGlobalEvent({
      directory: "/repo",
      payload: {
        type: "permission.replied",
        properties: {
          sessionID: "ses_1",
          requestID: "per_1",
          reply: "once",
        },
      },
    });

    expect(event.payload).toEqual({
      type: "permission.replied",
      properties: {
        sessionID: "ses_1",
        permissionID: "per_1",
        response: "once",
      },
    });
  });

  it("keeps legacy permission events unchanged", () => {
    const legacy = {
      directory: "/repo",
      payload: {
        type: "permission.updated",
        properties: {
          id: "per_old",
          type: "bash",
          pattern: "git push",
          sessionID: "ses_old",
          messageID: "msg_old",
          title: "bash",
          metadata: {},
          time: { created: 1 },
        },
      },
    };

    expect(normalizeBridgeGlobalEvent(legacy)).toEqual(legacy);
  });

  it("uses the current permission reply endpoint before legacy fallback", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response("true", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });
    await gateway.replyPermission("/repo", "ses_1", "per_1", "once");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe(
      "http://127.0.0.1:4096/permission/per_1/reply?directory=%2Frepo",
    );
    expect(call?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ reply: "once" }),
    });
  });
});
