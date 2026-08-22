import { describe, expect, it } from "vitest";
import type { OpenCodeEvent } from "../src/opencode/gateway.js";

describe("OpenCode assistant streaming event contract", () => {
  it("uses the 1.18.20/current message.part.delta shape", () => {
    const event = {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "chunk",
      },
    } as unknown as OpenCodeEvent;

    expect(event.type).toBe("message.part.delta");
    if (event.type !== "message.part.delta") throw new Error("unexpected event type");
    expect(event.properties).toEqual({
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "chunk",
    });
  });

  it("uses message.part.updated to distinguish text from reasoning", () => {
    const text = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: {
          id: "prt_text",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "text",
          text: "complete",
        },
        time: 1,
      },
    } as unknown as OpenCodeEvent;
    const reasoning = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: {
          id: "prt_reasoning",
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "reasoning",
          text: "private",
          time: { start: 1 },
        },
        time: 1,
      },
    } as unknown as OpenCodeEvent;

    expect(text.type).toBe("message.part.updated");
    expect(reasoning.type).toBe("message.part.updated");
    if (text.type !== "message.part.updated" || reasoning.type !== "message.part.updated") {
      throw new Error("unexpected event type");
    }
    expect(text.properties.part.type).toBe("text");
    expect(reasoning.properties.part.type).toBe("reasoning");
  });
});
