export type OpenCodeHostConfig = Readonly<{
  id: string;
  baseUrl: string;
  username: string;
  password?: string;
  allowedRoots: readonly string[];
}>;

const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class HostRegistry {
  readonly #defaultHostId: string;
  readonly #hosts: ReadonlyMap<string, OpenCodeHostConfig>;

  constructor(defaultHostId: string, hosts: readonly OpenCodeHostConfig[]) {
    if (hosts.length === 0) {
      throw new Error("Host registry must contain at least one host");
    }

    const entries = new Map<string, OpenCodeHostConfig>();
    for (const host of hosts) {
      if (!HOST_ID_PATTERN.test(host.id)) {
        throw new Error(`Invalid OpenCode host ID: ${host.id}`);
      }
      if (entries.has(host.id)) {
        throw new Error(`Duplicate OpenCode host ID: ${host.id}`);
      }
      if (host.allowedRoots.length === 0) {
        throw new Error(`OpenCode host ${host.id} must contain at least one allowed root`);
      }

      const frozenHost: OpenCodeHostConfig = Object.freeze({
        ...host,
        allowedRoots: Object.freeze([...host.allowedRoots]),
      });
      entries.set(host.id, frozenHost);
    }

    if (!entries.has(defaultHostId)) {
      throw new Error(`Default OpenCode host is not registered: ${defaultHostId}`);
    }

    this.#defaultHostId = defaultHostId;
    this.#hosts = entries;
  }

  defaultHost(): OpenCodeHostConfig {
    return this.get(this.#defaultHostId);
  }

  get(id: string): OpenCodeHostConfig {
    const host = this.#hosts.get(id);
    if (!host) throw new Error(`Unknown OpenCode host: ${id}`);
    return host;
  }

  has(id: string): boolean {
    return this.#hosts.has(id);
  }

  list(): readonly OpenCodeHostConfig[] {
    return Object.freeze([...this.#hosts.values()]);
  }

  toJSON(): { defaultHost: string; hosts: Array<Omit<OpenCodeHostConfig, "password">> } {
    return {
      defaultHost: this.#defaultHostId,
      hosts: [...this.#hosts.values()].map(({ password: _password, ...host }) => ({ ...host })),
    };
  }
}
