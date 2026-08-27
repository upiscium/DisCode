import { once } from "node:events";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { noopLogger } from "../src/logging/logger.js";
import type { MetricsExporterLike } from "../src/metrics/prometheus.js";
import { MetricsServer } from "../src/metrics/server.js";

const exporter: MetricsExporterLike = {
  scrape: async () => ({
    body: "# HELP test_metric test\n# TYPE test_metric gauge\ntest_metric 1\n",
    contentType: "text/plain; version=0.0.4; charset=utf-8",
  }),
};

describe("MetricsServer", () => {
  it("does not open a listener when metrics are disabled", async () => {
    const server = new MetricsServer({
      enabled: false,
      host: "127.0.0.1",
      port: 9464,
      exporter,
      logger: noopLogger,
    });

    await server.start();
    expect(server.address()).toBeNull();
    await server.stop();
  });

  it("serves only GET /metrics and closes the listener on shutdown", async () => {
    const server = new MetricsServer({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      exporter,
      logger: noopLogger,
    });
    await server.start();
    const address = server.address();
    expect(address).not.toBeNull();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const metricsResponse = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get("content-type")).toContain("text/plain");
    expect(await metricsResponse.text()).toContain("test_metric 1");

    const missingResponse = await fetch(`http://127.0.0.1:${address.port}/other`);
    expect(missingResponse.status).toBe(404);

    await server.stop();
    expect(server.address()).toBeNull();
    await expect(fetch(`http://127.0.0.1:${address.port}/metrics`)).rejects.toThrow();
  });

  it("fails closed when an enabled listener cannot bind", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const error = vi.fn<typeof noopLogger.error>();
    const server = new MetricsServer({
      enabled: true,
      host: "127.0.0.1",
      port: address.port,
      exporter,
      logger: { ...noopLogger, error },
    });

    await expect(server.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(server.address()).toBeNull();
    expect(error).toHaveBeenCalledWith(
      "metrics.bind_failed",
      "Metrics listener failed to bind",
      {},
      expect.anything(),
    );

    blocker.close();
    await once(blocker, "close");
  });

  it("returns a generic 500 response when scrape generation fails", async () => {
    const error = vi.fn<typeof noopLogger.error>();
    const server = new MetricsServer({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      exporter: {
        scrape: async () => {
          throw new Error("SENSITIVE INTERNAL DETAIL");
        },
      },
      logger: { ...noopLogger, error },
    });
    await server.start();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Metrics unavailable\n");
    expect(error).toHaveBeenCalledWith(
      "metrics.scrape_failed",
      "Metrics scrape failed",
      {},
      expect.anything(),
    );

    await server.stop();
  });
});
