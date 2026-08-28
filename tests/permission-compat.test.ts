import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBridgeGlobalEvent,
  normalizeOpenCodePermissionRequest,
  OpenCodeGateway,
} from "../src/opencode/gateway.js";

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

  it("normalizes pending permission list entries without metadata/tool payloads", () => {
    expect(
      normalizeOpenCodePermissionRequest({
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["git status"],
        metadata: { secret: "RAW_METADATA_SENTINEL" },
        tool: { input: "RAW_TOOL_SENTINEL" },
      }),
    ).toEqual({
      id: "per_1",
      sessionID: "ses_1",
      type: "bash",
      title: "bash",
      pattern: ["git status"],
    });
  });

  it("rejects malformed pending permission list entries", () => {
    expect(
      normalizeOpenCodePermissionRequest({
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["ok", 42],
      }),
    ).toBeUndefined();
  });

  it("lists pending permissions with directory query and existing Basic auth", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return Response.json([
        {
          id: "per_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["git status"],
          metadata: { private: "RAW_METADATA_SENTINEL" },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "PASSWORD_SENTINEL",
    });
    await expect(gateway.listPermissions("/repo with space")).resolves.toEqual([
      {
        id: "per_1",
        sessionID: "ses_1",
        type: "bash",
        title: "bash",
        pattern: ["git status"],
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe("http://127.0.0.1:4096/permission?directory=%2Frepo+with+space");
    expect(call?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from("opencode:PASSWORD_SENTINEL").toString("base64")}`,
      },
    });
  });

  it("fails closed when the pending permission list response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ id: "per_1" }])),
    );
    const gateway = new OpenCodeGateway({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });

    await expect(gateway.listPermissions("/repo")).rejects.toThrow(/invalid permission request/);
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
