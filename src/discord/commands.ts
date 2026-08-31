import { SlashCommandBuilder } from "discord.js";

export const openCodeCommand = new SlashCommandBuilder()
  .setName("oc")
  .setDescription("Control an OpenCode session")
  .addSubcommand((command) =>
    command
      .setName("start")
      .setDescription("Create an OpenCode session and Discord thread")
      .addStringOption((option) =>
        option
          .setName("directory")
          .setDescription("Absolute repository directory")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("host")
          .setDescription("Configured OpenCode host ID (defaults to the configured default host)"),
      )
      .addStringOption((option) =>
        option
          .setName("model")
          .setDescription("OpenCode model for Discord-origin prompts")
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("agent")
          .setDescription("OpenCode agent for Discord-origin prompts")
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option.setName("title").setDescription("Optional session title"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("sessions")
      .setDescription("List OpenCode sessions for a directory")
      .addStringOption((option) =>
        option
          .setName("directory")
          .setDescription("Absolute repository directory")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("host")
          .setDescription("Configured OpenCode host ID (defaults to the configured default host)"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("bind")
      .setDescription("Bind an existing OpenCode session to a Discord thread")
      .addStringOption((option) =>
        option
          .setName("directory")
          .setDescription("Absolute repository directory")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("session")
          .setDescription("OpenCode session to bind")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("host")
          .setDescription("Configured OpenCode host ID (defaults to the configured default host)"),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("model")
      .setDescription("Set this thread's OpenCode model preference")
      .addStringOption((option) =>
        option
          .setName("model")
          .setDescription("OpenCode model for subsequent Discord-origin prompts")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("agent")
      .setDescription("Set this thread's OpenCode agent preference")
      .addStringOption((option) =>
        option
          .setName("agent")
          .setDescription("OpenCode agent for subsequent Discord-origin prompts")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((command) =>
    command.setName("todo").setDescription("Show this thread's current OpenCode TODO list"),
  )
  .addSubcommand((command) =>
    command.setName("status").setDescription("Show this thread's OpenCode status"),
  )
  .addSubcommand((command) =>
    command.setName("abort").setDescription("Abort this thread's OpenCode session"),
  )
  .addSubcommand((command) =>
    command
      .setName("close")
      .setDescription("Delete this OpenCode session, unbind, and archive the thread"),
  )
  .addSubcommand((command) =>
    command
      .setName("unbind")
      .setDescription("Detach this Discord thread without deleting the OpenCode session"),
  )
  .addSubcommand((command) =>
    command.setName("health").setDescription("Show health for all configured OpenCode hosts"),
  )
  .addSubcommand((command) =>
    command.setName("subagents").setDescription("List available OpenCode subagents"),
  )
  .addSubcommand((command) =>
    command
      .setName("subagent")
      .setDescription("Select an OpenCode subagent")
      .addStringOption((option) =>
        option
          .setName("child")
          .setDescription("OpenCode subagent to select")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );
