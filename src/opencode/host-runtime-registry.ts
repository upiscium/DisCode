import type { OpenCodeHostConfig } from "../domain/host-registry.js";
import type { OpenCodeSseMonitor } from "./diagnostics.js";
import type { ObservedOpenCodeGateway } from "./observed-gateway.js";
import type { OpenCodeTodoGateway } from "./todo-gateway.js";

export type OpenCodeHostRuntime = Readonly<{
  id: string;
  config: OpenCodeHostConfig;
  authorizeDirectory: (directory: string) => Promise<string>;
  gateway: ObservedOpenCodeGateway;
  todo: OpenCodeTodoGateway;
  sseMonitor: OpenCodeSseMonitor;
}>;

export class OpenCodeHostRuntimeRegistry {
  readonly #defaultHostId: string;
  readonly #hosts: ReadonlyMap<string, OpenCodeHostRuntime>;

  constructor(defaultHostId: string, hosts: readonly OpenCodeHostRuntime[]) {
    const entries = new Map<string, OpenCodeHostRuntime>();
    for (const host of hosts) {
      if (entries.has(host.id)) throw new Error(`Duplicate OpenCode runtime host: ${host.id}`);
      entries.set(host.id, host);
    }
    if (!entries.has(defaultHostId)) {
      throw new Error(`Default OpenCode runtime host is not registered: ${defaultHostId}`);
    }
    this.#defaultHostId = defaultHostId;
    this.#hosts = entries;
  }

  defaultHost(): OpenCodeHostRuntime {
    return this.get(this.#defaultHostId);
  }

  get(id: string): OpenCodeHostRuntime {
    const host = this.#hosts.get(id);
    if (!host) throw new Error(`Unknown OpenCode host: ${id}`);
    return host;
  }

  has(id: string): boolean {
    return this.#hosts.has(id);
  }

  list(): readonly OpenCodeHostRuntime[] {
    return Object.freeze([...this.#hosts.values()]);
  }
}
