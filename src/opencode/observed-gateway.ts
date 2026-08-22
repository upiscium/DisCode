import { type BridgeGlobalEvent, type OpenCodeEvent, OpenCodeGateway } from "./gateway.js";

export type OpenCodeEventObserver = {
  handleEvent(
    event: OpenCodeEvent,
    gateway: Pick<OpenCodeGateway, "latestAssistantResult">,
  ): Promise<void>;
  stop(): void;
};

export class ObservedOpenCodeGateway extends OpenCodeGateway {
  readonly #observers: readonly OpenCodeEventObserver[];

  constructor(options: {
    baseUrl: string;
    username: string;
    password?: string;
    observers: readonly OpenCodeEventObserver[];
  }) {
    super(options);
    this.#observers = options.observers;
  }

  override async *events(signal?: AbortSignal): AsyncGenerator<BridgeGlobalEvent> {
    try {
      for await (const event of super.events(signal)) {
        for (const observer of this.#observers) {
          try {
            await observer.handleEvent(event.payload, this);
          } catch (error) {
            console.error(`OpenCode event observer failed for ${event.payload.type}`, error);
          }
        }
        yield event;
      }
    } finally {
      for (const observer of this.#observers) {
        try {
          observer.stop();
        } catch (error) {
          console.error("OpenCode event observer shutdown failed", error);
        }
      }
    }
  }
}
