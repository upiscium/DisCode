import { describe, expect, it } from "vitest";
import { HostRegistry } from "../src/domain/host-registry.js";

const host = {
  id: "local",
  baseUrl: "http://127.0.0.1:4096",
  username: "opencode",
  password: "top-secret",
  allowedRoots: ["/repo"],
} as const;

describe("HostRegistry", () => {
  it("resolves the default host and stable IDs", () => {
    const registry = new HostRegistry("local", [host]);
    expect(registry.defaultHost().id).toBe("local");
    expect(registry.get("local").baseUrl).toBe("http://127.0.0.1:4096");
    expect(registry.has("local")).toBe(true);
    expect(registry.list().map((item) => item.id)).toEqual(["local"]);
  });

  it("rejects invalid, duplicate, and missing default host IDs", () => {
    expect(() => new HostRegistry("LOCAL", [{ ...host, id: "LOCAL" }])).toThrow(
      /Invalid OpenCode host ID/,
    );
    expect(() => new HostRegistry("local", [host, { ...host }])).toThrow(
      /Duplicate OpenCode host ID/,
    );
    expect(() => new HostRegistry("missing", [host])).toThrow(
      /Default OpenCode host is not registered/,
    );
  });

  it("does not serialize resolved credentials", () => {
    const registry = new HostRegistry("local", [host]);
    const serialized = JSON.stringify(registry);
    expect(serialized).toContain('"defaultHost":"local"');
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("password");
  });
});
