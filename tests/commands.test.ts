import { describe, expect, it } from "vitest";
import { openCodeCommand } from "../src/discord/commands.js";

describe("/oc command registration", () => {
  it("registers close and unbind lifecycle subcommands", () => {
    const json = openCodeCommand.toJSON();
    const names = json.options?.map((option) => option.name) ?? [];

    expect(names).toContain("close");
    expect(names).toContain("unbind");
  });
});
