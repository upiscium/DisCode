import { type LoggerLike, noopLogger } from "../logging/logger.js";
import {
  type BridgeGlobalEvent,
  type OpenCodeEvent,
  type OpenCodeEventStreamLifecycleHook,
  OpenCodeGateway,
} from "./gateway.js";

export type OpenCodeEventObserver = {
  handleEvent(
    event: OpenCodeEvent,
    gateway: Pick<OpenCodeGateway, "latestAssistantResult">,
  ): Promise<void>;
  stop(): void;
};

export class ObservedOpenCodeGateway extends OpenCodeGateway {
  readonly #observers: readonly OpenCodeEventObserver[];
  readonly #logger: LoggerLike;
  readonly #hostId: string | undefined;

  constructor(options: {
    hostId?: string;
    baseUrl: string;
    username: string;
    password?: string;
    observers: readonly OpenCodeEventObserver[];
    logger?: LoggerLike;
  }) {
    super({
      baseUrl: options.baseUrl,
      username: options.username,
      ...(options.password ? { password: options.password } : {}),
      ...(options.hostId ? { hostId: options.hostId } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    this.#observers = options.observers;
    this.#logger = options.logger ?? noopLogger;
    this.#hostId = options.hostId;
  }

  override async *events(
    signal?: AbortSignal,
    onLifecycle?: OpenCodeEventStreamLifecycleHook,
  ): AsyncGenerator<BridgeGlobalEvent> {
    try {
      for await (const event of super.events(signal, onLifecycle)) {
        for (const observer of this.#observers) {
          try {
            await observer.handleEvent(event.payload, this);
          } catch (error) {
            this.#logger.error(
              "opencode.observer_failed",
              "OpenCode event observer failed",
              {
                ...(this.#hostId ? { host_id: this.#hostId } : {}),
                opencode_event: event.payload.type,
              },
              error,
            );
          }
        }
        yield event;
      }
    } finally {
      for (const observer of this.#observers) {
        try {
          observer.stop();
        } catch (error) {
          this.#logger.error(
            "opencode.observer_shutdown_failed",
            "OpenCode event observer shutdown failed",
            this.#hostId ? { host_id: this.#hostId } : {},
            error,
          );
        }
      }
    }
  }
}
