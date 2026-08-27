import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LoggerLike } from "../logging/logger.js";
import type { MetricsExporterLike } from "./prometheus.js";

export type MetricsServerOptions = Readonly<{
  enabled: boolean;
  host: string;
  port: number;
  exporter: MetricsExporterLike;
  logger: LoggerLike;
}>;

export class MetricsServer {
  readonly #enabled: boolean;
  readonly #host: string;
  readonly #port: number;
  readonly #exporter: MetricsExporterLike;
  readonly #logger: LoggerLike;
  #server: Server | undefined;

  constructor(options: MetricsServerOptions) {
    this.#enabled = options.enabled;
    this.#host = options.host;
    this.#port = options.port;
    this.#exporter = options.exporter;
    this.#logger = options.logger;
  }

  async start(): Promise<void> {
    if (!this.#enabled || this.#server) return;

    const server = createServer(async (request, response) => {
      const pathname = request.url ? new URL(request.url, "http://metrics.local").pathname : "/";
      if (request.method !== "GET" || pathname !== "/metrics") {
        response.statusCode = 404;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Not Found\n");
        return;
      }

      try {
        const snapshot = await this.#exporter.scrape();
        response.statusCode = 200;
        response.setHeader("Content-Type", snapshot.contentType);
        response.end(snapshot.body);
      } catch (error) {
        this.#logger.error("metrics.scrape_failed", "Metrics scrape failed", {}, error);
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Metrics unavailable\n");
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#port, this.#host);
    }).catch((error) => {
      this.#logger.error("metrics.bind_failed", "Metrics listener failed to bind", {}, error);
      server.close();
      throw error;
    });

    this.#server = server;
    const address = server.address();
    this.#logger.info("metrics.started", "Metrics listener started", {
      metrics_port: typeof address === "object" && address ? address.port : this.#port,
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.#logger.info("metrics.stopped", "Metrics listener stopped");
  }

  address(): AddressInfo | string | null {
    return this.#server?.address() ?? null;
  }
}
