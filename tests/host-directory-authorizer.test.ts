import { describe, expect, it, vi } from "vitest";
import type { OpenCodeHostConfig } from "../src/domain/host-registry.js";
import { createHostDirectoryAuthorizer } from "../src/opencode/host-directory-authorizer.js";

function host(
  homeDirectory?: string,
  allowedRoots: readonly string[] = ["/remote/root"],
): OpenCodeHostConfig {
  return {
    id: "remote",
    baseUrl: "https://remote.example.test",
    username: "opencode",
    allowedRoots,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  };
}

describe("createHostDirectoryAuthorizer", () => {
  it("expands home forms before sending them to the remote resolver", async () => {
    const seen: string[] = [];
    const resolver = async (directory: string): Promise<string> => {
      seen.push(directory);
      return directory;
    };
    const authorize = createHostDirectoryAuthorizer(host("/remote/root/user"), resolver);

    expect(await authorize("~")).toBe("/remote/root/user");
    expect(await authorize("~/nested/project")).toBe("/remote/root/user/nested/project");
    expect(seen).toEqual(["/remote/root", "/remote/root/user", "/remote/root/user/nested/project"]);
  });

  it("isolates home directories between host authorizers", async () => {
    const resolver = async (directory: string): Promise<string> => directory;
    const alice = createHostDirectoryAuthorizer(host("/remote/alice", ["/remote/alice"]), resolver);
    const bob = createHostDirectoryAuthorizer(host("/remote/bob", ["/remote/bob"]), resolver);

    await expect(alice("~/project")).resolves.toBe("/remote/alice/project");
    await expect(bob("~/project")).resolves.toBe("/remote/bob/project");
  });

  it("passes absolute input through without requiring a home", async () => {
    const resolver = vi.fn(async (directory: string): Promise<string> => directory);
    const authorize = createHostDirectoryAuthorizer(host(), resolver);

    await expect(authorize("/remote/root/project")).resolves.toBe("/remote/root/project");
    expect(resolver).toHaveBeenLastCalledWith("/remote/root/project");
  });

  it("leaves relative and shell-like inputs for downstream absolute validation", async () => {
    const resolver = async (directory: string): Promise<string> => {
      if (!directory.startsWith("/"))
        throw new Error("OpenCode directory must be an absolute path");
      return directory;
    };
    const authorize = createHostDirectoryAuthorizer(host("/remote/root/user"), resolver);

    await expect(authorize("relative/project")).rejects.toThrow(/absolute path/);
    await expect(authorize("$HOME/project")).rejects.toThrow(/absolute path/);
  });

  it("fails closed for tilde input without a home", async () => {
    const resolver = vi.fn(async (directory: string): Promise<string> => directory);
    const authorize = createHostDirectoryAuthorizer(host(), resolver);

    await expect(authorize("~/project")).rejects.toThrow(/not configured/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects expanded directories outside the configured root", async () => {
    const authorize = createHostDirectoryAuthorizer(
      host("/remote/other"),
      async (directory) => directory,
    );

    await expect(authorize("~/project")).rejects.toThrow(/outside configured allowed roots/);
  });

  it("rejects a remote canonical symlink escape", async () => {
    const resolver = async (directory: string): Promise<string> =>
      directory === "/remote/root/user/project" ? "/remote/private/project" : directory;
    const authorize = createHostDirectoryAuthorizer(host("/remote/root/user"), resolver);

    await expect(authorize("~/project")).rejects.toThrow(/outside configured allowed roots/);
  });

  it("retries after policy initialization fails", async () => {
    let rootAttempt = 0;
    const resolver = async (directory: string): Promise<string> => {
      if (directory === "/remote/root" && rootAttempt++ === 0) throw new Error("temporary failure");
      return directory;
    };
    const authorize = createHostDirectoryAuthorizer(host("/remote/root/user"), resolver);

    await expect(authorize("~/project")).rejects.toThrow("temporary failure");
    await expect(authorize("~/project")).resolves.toBe("/remote/root/user/project");
  });
});
