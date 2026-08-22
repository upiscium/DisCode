import { SlashCommandBuilder } from "discord.js";

export const openCodeCommand = new SlashCommandBuilder()
  .setName("oc")
  .setDescription("Control an OpenCode session")
  .addSubcommand((command) =>
    command
      .setName("start")
      .setDescription("Create an OpenCode session and Discord thread")
      .addStringOption((option) =>
        option.setName("directory").setDescription("Absolute repository directory").setRequired(true),
      )
      .addStringOption((option) => option.setName("title").setDescription("Optional session title")),
  )
  .addSubcommand((command) => command.setName("status").setDescription("Show this thread's OpenCode status"))
  .addSubcommand((command) => command.setName("abort").setDescription("Abort this thread's OpenCode session"));
