import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  event: vi.fn(),
}));

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: vi.fn(() => ({ global: { event: mocks.event } })),
}));

import { OpenCodeGateway } from "../src/opencode/gateway.js";
import { ObservedOpenCodeGateway } from "../src/opencode/observed-gateway.js";

const event = (type: string) => ({
  directory: "/workspace",
  payload: { type, properties: {} },
});

describe("OpenCodeGateway event stream lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.event.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the hook before each subscription's events, marking reconnects", async () => {
    async function* disconnectedStream() {
      yield event("first");
      throw new Error("disconnected");
    }
    async function* reconnectedStream() {
      yield event("second");
    }
    mocks.event
      .mockResolvedValueOnce({ stream: disconnectedStream() })
      .mockResolvedValueOnce({ stream: reconnectedStream() });

    const lifecycle: boolean[] = [];
    const controller = new AbortController();
    const gateway = new OpenCodeGateway({
      baseUrl: "http://localhost:4096",
      username: "test",
    });
    const iterator = gateway.events(controller.signal, ({ reconnected }) => {
      lifecycle.push(reconnected);
      if (reconnected) controller.abort();
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: expect.objectContaining({
        payload: expect.objectContaining({ type: "first" }),
      }),
      done: false,
    });
    const reconnecting = iterator.next();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reconnecting).resolves.toMatchObject({ done: true });
    expect(lifecycle).toEqual([false, true]);
    expect(mocks.event).toHaveBeenCalledTimes(2);
  });

  it("logs hook failures without stopping event consumption", async () => {
    async function* stream() {
      yield event("still-consumed");
    }
    mocks.event.mockResolvedValueOnce({ stream: stream() });
    const warn = vi.fn();
    const gateway = new OpenCodeGateway({
      baseUrl: "http://localhost:4096",
      username: "test",
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });

    await expect(
      gateway
        .events(undefined, () => {
          throw new Error("hook failed");
        })
        .next(),
    ).resolves.toMatchObject({
      value: expect.objectContaining({
        payload: expect.objectContaining({ type: "still-consumed" }),
      }),
      done: false,
    });
    expect(warn).toHaveBeenCalledWith(
      "opencode.stream_lifecycle_failed",
      expect.any(String),
      expect.objectContaining({ reconnected: false }),
      expect.any(Error),
    );
  });

  it("preserves observer ordering while forwarding the lifecycle hook", async () => {
    async function* stream() {
      yield event("observed");
    }
    mocks.event.mockResolvedValueOnce({ stream: stream() });
    const calls: string[] = [];
    const observer = {
      handleEvent: vi.fn(async () => {
        calls.push("observer");
      }),
      stop: vi.fn(),
    };
    const gateway = new ObservedOpenCodeGateway({
      baseUrl: "http://localhost:4096",
      username: "test",
      observers: [observer],
    });
    const iterator = gateway.events(undefined, () => {
      calls.push("lifecycle");
    });

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    expect(calls).toEqual(["lifecycle", "observer"]);
    await iterator.return(undefined);
    expect(observer.stop).toHaveBeenCalledTimes(1);
  });
});
