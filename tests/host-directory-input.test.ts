import { describe, expect, it } from "vitest";
import { expandHostDirectoryInput } from "../src/domain/host-directory-input.js";

describe("expandHostDirectoryInput", () => {
  function thrownMessage(action: () => unknown): string {
    try {
      action();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("Expected action to throw");
  }

  it("expands supported forms with deterministic POSIX normalization", () => {
    expect(expandHostDirectoryInput("~", "/srv/user")).toBe("/srv/user");
    expect(expandHostDirectoryInput("~/repo", "/srv/user")).toBe("/srv/user/repo");
    expect(expandHostDirectoryInput("~/nested/repo", "/srv/user")).toBe("/srv/user/nested/repo");
    expect(expandHostDirectoryInput("~/repo/", "/srv/user")).toBe("/srv/user/repo");
    expect(expandHostDirectoryInput("~/", "/srv/user")).toBe("/srv/user");
    expect(expandHostDirectoryInput("~", "/")).toBe("/");
    expect(expandHostDirectoryInput("~/", "/")).toBe("/");
    expect(expandHostDirectoryInput("/already/canonical", "/srv/user")).toBe("/already/canonical");
    expect(expandHostDirectoryInput("foo~/repo", "/srv/user")).toBe("foo~/repo");
  });

  it("rejects unsupported tilde forms with bounded errors", () => {
    for (const input of ["~root", "~otheruser/path", "~foo/bar", "~~", "~\\repo"]) {
      const message = thrownMessage(() => expandHostDirectoryInput(input, "/srv/user"));
      expect(message).toBe('Only "~" and "~/..." directory forms are supported.');
      expect(message.length).toBeLessThan(64);
      expect(message).not.toContain(input);
    }
  });

  it("fails closed when a supported form has no configured home", () => {
    for (const input of ["~/secret", "~otheruser/path"]) {
      const message = thrownMessage(() => expandHostDirectoryInput(input, undefined));
      expect(message).toMatch(/not configured|Only/);
      expect(message).not.toContain(input);
    }
    expect(() => expandHostDirectoryInput("~/secret", undefined)).toThrow(/not configured/);
  });

  it("does not shell-expand relative or shell-like inputs", () => {
    for (const input of [
      "relative/path",
      "$HOME/repo",
      "$" + "{HOME}/repo",
      "$USER/repo",
      "$(echo /tmp)/repo",
      "`echo /tmp`/repo",
      "foo~/repo",
    ]) {
      expect(expandHostDirectoryInput(input, "/srv/user")).toBe(input);
    }
    expect(() => expandHostDirectoryInput("~/repo", undefined)).toThrow(/not configured/);
  });

  it("never falls back to the Bridge process HOME", () => {
    const previousHome = process.env.HOME;
    process.env.HOME = "/bridge/home";
    try {
      expect(() => expandHostDirectoryInput("~/repo", undefined)).toThrow(/not configured/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
