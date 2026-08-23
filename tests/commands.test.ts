import { describe, expect, it } from "vitest";
import { openCodeCommand } from "../src/discord/commands.js";

type CommandJson = {
  options?: Array<{
    name: string;
    options?: Array<{ name: string; required?: boolean }>;
  }>;
};

describe("/oc command registration", () => {
  it("registers close and unbind lifecycle subcommands", () => {
    const json = openCodeCommand.toJSON();
    const names = json.options?.map((option) => option.name) ?? [];

    expect(names).toContain("close");
    expect(names).toContain("unbind");
  });

  it("registers host as an optional /oc start selector", () => {
    const json = openCodeCommand.toJSON() as CommandJson;
    const start = json.options?.find((option) => option.name === "start");
    const host = start?.options?.find((option) => option.name === "host");

    expect(host).toBeDefined();
    expect(host?.required).not.toBe(true);
  });
});
