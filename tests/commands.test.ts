import { describe, expect, it } from "vitest";
import { openCodeCommand } from "../src/discord/commands.js";

type CommandJson = {
  options?: Array<{
    name: string;
    options?: Array<{
      name: string;
      required?: boolean;
      autocomplete?: boolean;
    }>;
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

  it("registers optional model and agent autocomplete on /oc start", () => {
    const json = openCodeCommand.toJSON() as CommandJson;
    const start = json.options?.find((option) => option.name === "start");
    const model = start?.options?.find((option) => option.name === "model");
    const agent = start?.options?.find((option) => option.name === "agent");

    expect(model).toMatchObject({ required: false, autocomplete: true });
    expect(agent).toMatchObject({ required: false, autocomplete: true });
  });

  it("registers bound-thread model and agent selection subcommands", () => {
    const json = openCodeCommand.toJSON() as CommandJson;
    const modelCommand = json.options?.find((option) => option.name === "model");
    const agentCommand = json.options?.find((option) => option.name === "agent");

    expect(modelCommand?.options?.find((option) => option.name === "model")).toMatchObject({
      required: true,
      autocomplete: true,
    });
    expect(agentCommand?.options?.find((option) => option.name === "agent")).toMatchObject({
      required: true,
      autocomplete: true,
    });
  });

  it("registers schema-only subagent commands", () => {
    const json = openCodeCommand.toJSON() as CommandJson;
    const subagents = json.options?.find((option) => option.name === "subagents");
    const subagent = json.options?.find((option) => option.name === "subagent");

    expect(subagents).toBeDefined();
    expect(subagents?.options ?? []).toHaveLength(0);
    expect(subagent?.options).toEqual([
      expect.objectContaining({
        name: "child",
        required: true,
        autocomplete: true,
      }),
    ]);
  });

  it("does not expose authority override options on subagent commands", () => {
    const json = openCodeCommand.toJSON() as CommandJson;
    const subagentCommands = json.options?.filter((option) =>
      ["subagents", "subagent"].includes(option.name),
    );
    const authorityOverrideOptions = ["host", "session", "directory", "model", "agent"];

    for (const command of subagentCommands ?? []) {
      for (const option of command.options ?? []) {
        expect(authorityOverrideOptions).not.toContain(option.name);
      }
    }
  });
});
