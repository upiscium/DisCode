import { afterEach, describe, expect, it, vi } from "vitest";
import { type LoggerLike, noopLogger } from "../src/logging/logger.js";
import { probeOpenCodeHostsHealth, setOpenCodeHealthLogger } from "../src/opencode/diagnostics.js";

afterEach(() => {
  setOpenCodeHealthLogger(noopLogger);
});

describe("health probe run options", () => {
  it("suppresses degraded logging for metrics scrapes while observing probe duration", async () => {
    const warn = vi.fn<LoggerLike["warn"]>();
    const observeDuration = vi.fn<(hostId: string, durationSeconds: number) => void>();
    const now = vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(1025);
    setOpenCodeHealthLogger({ ...noopLogger, warn });

    const health = await probeOpenCodeHostsHealth(
      [
        {
          id: "host-2",
          isDefault: false,
          baseUrl: "http://10.12.0.2:4096",
          username: "opencode",
          sse: "disconnected",
        },
      ],
      async () => ({ kind: "unreachable" }),
      {
        emitDegradedLog: false,
        observeDuration,
        now,
      },
    );

    expect(health[0]).toEqual({
      id: "host-2",
      isDefault: false,
      http: { kind: "unreachable" },
      sse: "disconnected",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(observeDuration).toHaveBeenCalledWith("host-2", 0.025);
  });
});
