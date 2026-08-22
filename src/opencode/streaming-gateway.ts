import type { AssistantStreamingPublisher } from "../bridge/assistant-streaming-publisher.js";
import { OpenCodeGateway, type BridgeGlobalEvent } from "./gateway.js";

export class StreamingOpenCodeGateway extends OpenCodeGateway {
  readonly #publisher: AssistantStreamingPublisher;

  constructor(options: {
    baseUrl: string;
    username: string;
    password?: string;
    publisher: AssistantStreamingPublisher;
  }) {
    super(options);
    this.#publisher = options.publisher;
  }

  override async *events(signal?: AbortSignal): AsyncGenerator<BridgeGlobalEvent> {
    try {
      for await (const event of super.events(signal)) {
        try {
          await this.#publisher.handleEvent(event.payload, this);
        } catch (error) {
          console.error(`Assistant streaming event handling failed for ${event.payload.type}`, error);
        }
        yield event;
      }
    } finally {
      this.#publisher.stop();
    }
  }
}
