import type { AssistantStreamingPublisher } from "../bridge/assistant-streaming-publisher.js";
import { ObservedOpenCodeGateway } from "./observed-gateway.js";

export class StreamingOpenCodeGateway extends ObservedOpenCodeGateway {
  constructor(options: {
    baseUrl: string;
    username: string;
    password?: string;
    publisher: AssistantStreamingPublisher;
  }) {
    super({
      baseUrl: options.baseUrl,
      username: options.username,
      ...(options.password ? { password: options.password } : {}),
      observers: [options.publisher],
    });
  }
}
