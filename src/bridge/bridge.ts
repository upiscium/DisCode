import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  MessageFlags,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
} from "discord.js";
import type { AppConfig } from "../config.js";
import { prepareDiscordAttachments } from "../discord/attachments.js";
import { openCodeCommand } from "../discord/commands.js";
import { chunkDiscordText, renderAssistantResult, sanitizeThreadName } from "../discord/format.js";
import { renderHealthDiagnostic } from "../discord/health.js";
import { parseQuestionAnswers, renderQuestionAsk } from "../discord/question.js";
import { renderSessionStatus } from "../discord/status.js";
import type { DirectoryPolicy } from "../domain/directory-policy.js";
import type { SessionBinding } from "../domain/session-binding.js";
import { OpenCodeSseMonitor, probeOpenCodeHealth } from "../opencode/diagnostics.js";
import type {
  OpenCodeEvent,
  OpenCodeGateway,
  OpenCodePermissionResponse,
  OpenCodeQuestionRequest,
} from "../opencode/gateway.js";
import type { StateStore } from "../state/state-store.js";
import {
  executeCloseMutation,
  executeUnbindMutation,
  lifecycleBlockReason,
  renderLifecycleBlock,
} from "./session-lifecycle.js";
import { SessionHeaderManager } from "./session-header-manager.js";

const PERMISSION_PREFIX = "ocperm";
const QUESTION_PREFIX = "ocquestion";

export class Bridge {
  readonly #config: AppConfig;
  readonly #policy: DirectoryPolicy;
  readonly #state: StateStore;
  readonly #opencode: OpenCodeGateway;
  readonly #discord: Client;
  readonly #abortController = new AbortController();
  readonly #seenPermissions = new Set<string>();
  readonly #pendingQuestions = new Map<string, OpenCodeQuestionRequest>();
  readonly #sseMonitor = new OpenCodeSseMonitor();
  readonly #sessionHeaders: SessionHeaderManager;

  constructor(options: {
    config: AppConfig;
    policy: DirectoryPolicy;
    state: StateStore;
    opencode: OpenCodeGateway;
  }) {
    this.#config = options.config;
    this.#policy = options.policy;
    this.#state = options.state;
    this.#opencode = options.opencode;
    this.#discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.#sessionHeaders = new SessionHeaderManager({
      discord: this.#discord,
      state: this.#state,
      opencode: this.#opencode,
    });
  }

  async start(): Promise<void> {
    await this.#registerCommands();
    this.#discord.on("interactionCreate", (interaction) => {
      void this.#handleInteraction(interaction).catch((error) =>
        this.#handleInteractionFailure(interaction, error),
      );
    });
    this.#discord.on("messageCreate", (message) => {
      void this.#handleMessage(message).catch(async (error) => {
        console.error("Discord message handling failed", error);
        await message
          .reply(`Bridge error: ${truncate(errorMessage(error), 1600)}`)
          .catch(() => undefined);
      });
    });
    this.#discord.once(Events.ClientReady, (client) => {
      console.log(`Discord connected as ${client.user.tag}`);
    });

    await this.#discord.login(this.#config.discordToken);
    void this.#consumeOpenCodeEvents().catch((error) => {
      if (!this.#abortController.signal.aborted) {
        console.error("OpenCode event consumer stopped unexpectedly", error);
      }
    });
    await this.#reconcilePendingQuestions();
    await this.#reconcileSessionHeaders();
  }

  async stop(): Promise<void> {
    this.#abortController.abort();
    this.#discord.destroy();
  }

  async #handleInteractionFailure(interaction: Interaction, error: unknown): Promise<void> {
    console.error("Discord interaction failed", error);
    if (!interaction.isRepliable()) return;
    const content = `Bridge error: ${truncate(errorMessage(error), 1600)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }

  async #registerCommands(): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(this.#config.discordToken);
    await rest.put(
      Routes.applicationGuildCommands(this.#config.discordClientId, this.#config.discordGuildId),
      {
        body: [openCodeCommand.toJSON()],
      },
    );
  }

  #authorized(userId: string): boolean {
    return this.#config.allowedUserIds.has(userId);
  }

  async #handleInteraction(interaction: Interaction): Promise<void> {
    if (!this.#authorized(interaction.user.id)) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "This user is not authorized to control OpenCode.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
    if (interaction.guildId !== this.#config.discordGuildId) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "This command is restricted to the configured guild.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(`${PERMISSION_PREFIX}:`)) {
      await this.#handlePermissionButton(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(`${QUESTION_PREFIX}:`)) {
      await this.#handleQuestionButton(interaction);
      return;
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== "oc") return;

    const subcommand = interaction.options.getSubcommand();
    switch (subcommand) {
      case "start":
        await this.#startSession(interaction);
        break;
      case "status":
        await this.#status(interaction);
        break;
      case "abort":
        await this.#abort(interaction);
        break;
      case "close":
        await this.#close(interaction);
        break;
      case "unbind":
        await this.#unbind(interaction);
        break;
      case "health":
        await this.#health(interaction);
        break;
      default:
        await interaction.reply({
          content: `Unknown subcommand: ${subcommand}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  async #startSession(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const requestedDirectory = interaction.options.getString("directory", true);
    const directory = await this.#policy.authorize(requestedDirectory);
    const requestedTitle = interaction.options.getString("title")?.trim();
    const title =
      requestedTitle || directory.split("/").filter(Boolean).at(-1) || "OpenCode session";

    const parent = await this.#discord.channels.fetch(this.#config.discordParentChannelId);
    if (!parent || parent.type !== ChannelType.GuildText) {
      throw new Error("DISCORD_PARENT_CHANNEL_ID must refer to a guild text channel");
    }

    const session = await this.#opencode.createSession(directory, title);
    let thread: ThreadChannel | undefined;
    try {
      thread = await parent.threads.create({
        name: sanitizeThreadName(title),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: `OpenCode session ${session.id}`,
      });

      const binding: SessionBinding = {
        threadId: thread.id,
        parentChannelId: parent.id,
        sessionId: session.id,
        directory,
        title,
        createdBy: interaction.user.id,
        createdAt: new Date().toISOString(),
      };
      await this.#state.put(binding);
      await this.#sessionHeaders.createInitialHeader(binding, thread);
      await interaction.editReply(
        `Created <#${thread.id}> for OpenCode session \`${session.id}\`.`,
      );
      await this.#refreshSessionHeader(binding.sessionId);
    } catch (error) {
      if (thread) {
        await this.#state.remove(thread.id).catch(() => undefined);
        await thread
          .delete("Rolling back failed OpenCode bridge session creation")
          .catch(() => undefined);
      }
      await this.#opencode.deleteSession(directory, session.id).catch((rollbackError) => {
        console.error("Failed to roll back OpenCode session", rollbackError);
      });
      throw error;
    }
  }

  async #health(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const http = await probeOpenCodeHealth({
      baseUrl: this.#config.opencodeBaseUrl,
      username: this.#config.opencodeUsername,
      ...(this.#config.opencodePassword ? { password: this.#config.opencodePassword } : {}),
    });
    await interaction.editReply(renderHealthDiagnostic(http, this.#sseMonitor.status()));
  }

  async #status(interaction: ChatInputCommandInteraction): Promise<void> {
    const binding = this.#state.getByThread(interaction.channelId);
    if (!binding) {
      await interaction.reply({
        content: "This is not a bound OpenCode thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const status = await this.#opencode.status(binding.directory, binding.sessionId);
    await interaction.reply({
      content: renderSessionStatus({
        sessionId: binding.sessionId,
        status: status?.type ?? "idle",
        directory: binding.directory,
        baseUrl: this.#config.opencodeBaseUrl,
      }),
      flags: MessageFlags.Ephemeral,
    });
  }

  async #abort(interaction: ChatInputCommandInteraction): Promise<void> {
    const binding = this.#state.getByThread(interaction.channelId);
    if (!binding) {
      await interaction.reply({
        content: "This is not a bound OpenCode thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.#opencode.abort(binding.directory, binding.sessionId);
    await interaction.reply({
      content: `Abort requested for \`${binding.sessionId}\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  async #close(interaction: ChatInputCommandInteraction): Promise<void> {
    const binding = this.#state.getByThread(interaction.channelId);
    if (!binding) {
      await interaction.reply({
        content: "This is not a bound OpenCode thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await this.#opencode.status(binding.directory, binding.sessionId);
    const blocker = lifecycleBlockReason(
      status?.type,
      this.#pendingQuestions.has(binding.sessionId),
    );
    if (blocker) {
      await interaction.editReply(renderLifecycleBlock(blocker));
      return;
    }

    await executeCloseMutation({
      deleteSession: () => this.#opencode.deleteSession(binding.directory, binding.sessionId),
      removeBinding: () => this.#state.remove(binding.threadId),
    });
    this.#pendingQuestions.delete(binding.sessionId);

    await interaction.editReply(
      `Closed OpenCode session \`${binding.sessionId}\` and removed this Discord binding. Archiving the thread.`,
    );

    try {
      const thread = await this.#fetchThread(binding.threadId);
      if (!thread) throw new Error("Bound Discord thread could not be fetched");
      await thread.setArchived(true, `OpenCode session ${binding.sessionId} closed`);
    } catch (error) {
      await interaction.followUp({
        content: `The OpenCode session was deleted and unbound, but the Discord thread could not be archived: ${truncate(errorMessage(error), 1200)}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  async #unbind(interaction: ChatInputCommandInteraction): Promise<void> {
    const binding = this.#state.getByThread(interaction.channelId);
    if (!binding) {
      await interaction.reply({
        content: "This is not a bound OpenCode thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await this.#opencode.status(binding.directory, binding.sessionId);
    const blocker = lifecycleBlockReason(
      status?.type,
      this.#pendingQuestions.has(binding.sessionId),
    );
    if (blocker) {
      await interaction.editReply(renderLifecycleBlock(blocker));
      return;
    }

    await executeUnbindMutation({
      removeBinding: () => this.#state.remove(binding.threadId),
    });
    this.#pendingQuestions.delete(binding.sessionId);
    await interaction.editReply(
      [
        `Unbound this thread from OpenCode session \`${binding.sessionId}\`.`,
        "The OpenCode session still exists and can continue to be used from the TUI or API.",
        `Directory: \`${escapeInlineCode(binding.directory)}\``,
      ].join("\n"),
    );
  }

  async #handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !this.#authorized(message.author.id)) return;
    if (message.guildId !== this.#config.discordGuildId || !message.channel.isThread()) return;

    const binding = this.#state.getByThread(message.channelId);
    if (!binding) return;

    const text = message.content.trim();
    const hasAttachments = message.attachments.size > 0;
    if (!text && !hasAttachments) return;

    const pendingQuestion = this.#pendingQuestions.get(binding.sessionId);
    if (pendingQuestion) {
      if (hasAttachments) {
        await message.reply("Attachments cannot answer a pending Ask. Send a text-only answer.");
        return;
      }
      try {
        const answers = parseQuestionAnswers(text, pendingQuestion.questions);
        await this.#opencode.replyQuestion(binding.directory, pendingQuestion.id, answers);
        this.#pendingQuestions.delete(binding.sessionId);
        await message.reply(`↩️ Answer sent for Ask \`${pendingQuestion.id}\`.`);
      } catch (error) {
        await message.reply(`Could not parse the Ask answer: ${errorMessage(error)}`);
      }
      return;
    }

    const status = await this.#opencode.status(binding.directory, binding.sessionId);
    if (status?.type === "busy" || status?.type === "retry") {
      await message.reply(
        `OpenCode is currently **${status.type}**. Wait for the current turn to finish or use \`/oc abort\`.`,
      );
      return;
    }

    if (hasAttachments) {
      try {
        const files = await prepareDiscordAttachments(
          [...message.attachments.values()].map((attachment) => ({
            name: attachment.name,
            size: attachment.size,
            contentType: attachment.contentType,
            url: attachment.url,
          })),
        );
        await this.#opencode.promptAsyncWithFiles(
          binding.directory,
          binding.sessionId,
          text,
          files,
        );
      } catch (error) {
        await message.reply(`Attachment rejected: ${truncate(errorMessage(error), 1500)}`);
        return;
      }
    } else {
      await this.#opencode.promptAsync(binding.directory, binding.sessionId, text);
    }
    await message.react("⏳").catch(() => undefined);
  }

  async #consumeOpenCodeEvents(): Promise<void> {
    for await (const globalEvent of this.#opencode.events(this.#abortController.signal)) {
      this.#sseMonitor.observe();
      await this.#handleOpenCodeEvent(globalEvent.payload, globalEvent.directory).catch((error) => {
        console.error(`Failed to handle OpenCode event ${globalEvent.payload.type}`, error);
      });
    }
  }

  async #handleOpenCodeEvent(event: OpenCodeEvent, directory: string): Promise<void> {
    switch (event.type) {
      case "message.updated":
        if (event.properties.info.role === "user") {
          await this.#refreshSessionHeader(event.properties.info.sessionID);
        }
        break;
      case "vcs.branch.updated":
        await this.#refreshHeadersForDirectory(directory);
        break;
      case "permission.updated":
        await this.#publishPermission(event);
        break;
      case "permission.replied":
        this.#seenPermissions.delete(event.properties.permissionID);
        break;
      case "question.asked":
        await this.#publishQuestion(event.properties);
        break;
      case "question.replied":
      case "question.rejected": {
        const pending = this.#pendingQuestions.get(event.properties.sessionID);
        if (pending?.id === event.properties.requestID) {
          this.#pendingQuestions.delete(event.properties.sessionID);
        }
        break;
      }
      case "session.idle":
        await this.#publishResult(event.properties.sessionID);
        break;
      case "session.error":
        if (event.properties.sessionID) {
          await this.#publishSessionError(event.properties.sessionID, event.properties.error);
        }
        break;
      default:
        break;
    }
  }

  async #refreshSessionHeader(sessionId: string): Promise<void> {
    try {
      await this.#sessionHeaders.refreshSession(sessionId);
    } catch (error) {
      console.error(`Failed to refresh Discord session header for ${sessionId}`, error);
    }
  }

  async #refreshHeadersForDirectory(directory: string): Promise<void> {
    for (const binding of this.#state.list()) {
      if (binding.directory !== directory) continue;
      await this.#refreshSessionHeader(binding.sessionId);
    }
  }

  async #reconcileSessionHeaders(): Promise<void> {
    for (const binding of this.#state.list()) {
      await this.#refreshSessionHeader(binding.sessionId);
    }
  }

  async #reconcilePendingQuestions(): Promise<void> {
    const directories = [...new Set(this.#state.list().map((binding) => binding.directory))];
    for (const directory of directories) {
      try {
        const questions = await this.#opencode.listQuestions(directory);
        for (const question of questions) {
          if (this.#state.getBySession(question.sessionID)) {
            await this.#publishQuestion(question);
          }
        }
      } catch (error) {
        console.error(`Failed to reconcile pending OpenCode questions for ${directory}`, error);
      }
    }
  }

  async #publishQuestion(request: OpenCodeQuestionRequest): Promise<void> {
    const current = this.#pendingQuestions.get(request.sessionID);
    if (current?.id === request.id) return;
    const binding = this.#state.getBySession(request.sessionID);
    if (!binding) return;
    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;

    this.#pendingQuestions.set(request.sessionID, request);
    const rendered = renderQuestionAsk(request);
    const chunks = chunkDiscordText(rendered, 1750);
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      if (!isLast) {
        await thread.send(chunk);
        continue;
      }
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(questionCustomId(request.sessionID, request.id))
          .setLabel("Reject Ask")
          .setStyle(ButtonStyle.Danger),
      );
      await thread.send({ content: chunk, components: [row] });
    }
  }

  async #handleQuestionButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseQuestionCustomId(interaction.customId);
    if (!parsed) return;
    const binding = this.#state.getBySession(parsed.sessionId);
    const pending = this.#pendingQuestions.get(parsed.sessionId);
    if (
      !binding ||
      binding.threadId !== interaction.channelId ||
      pending?.id !== parsed.requestId
    ) {
      await interaction.reply({
        content: "This Ask is no longer pending for this thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.#opencode.rejectQuestion(binding.directory, parsed.requestId);
    this.#pendingQuestions.delete(parsed.sessionId);
    await interaction.update({
      content: `${interaction.message.content}\n\nRejected by <@${interaction.user.id}>.`,
      components: [],
    });
  }

  async #publishPermission(
    event: Extract<OpenCodeEvent, { type: "permission.updated" }>,
  ): Promise<void> {
    const permission = event.properties;
    if (this.#seenPermissions.has(permission.id)) return;
    const binding = this.#state.getBySession(permission.sessionID);
    if (!binding) return;

    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(permissionCustomId("once", permission.sessionID, permission.id))
        .setLabel("Allow once")
        .setStyle(ButtonStyle.Success),
    );
    if (this.#config.allowPermissionAlways) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(permissionCustomId("always", permission.sessionID, permission.id))
          .setLabel("Allow always")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(permissionCustomId("reject", permission.sessionID, permission.id))
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger),
    );

    const pattern = Array.isArray(permission.pattern)
      ? permission.pattern.join(", ")
      : permission.pattern;
    await thread.send({
      content: [
        "⚠️ **OpenCode permission requested**",
        `Title: ${truncate(permission.title, 500)}`,
        `Type: \`${escapeInlineCode(permission.type)}\``,
        ...(pattern ? [`Pattern: \`${escapeInlineCode(truncate(pattern, 900))}\``] : []),
      ].join("\n"),
      components: [row],
    });
    this.#seenPermissions.add(permission.id);
  }

  async #handlePermissionButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parsePermissionCustomId(interaction.customId);
    if (!parsed) return;
    if (parsed.response === "always" && !this.#config.allowPermissionAlways) {
      await interaction.reply({
        content: "Persistent permission approval is disabled.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const binding = this.#state.getBySession(parsed.sessionId);
    if (!binding || binding.threadId !== interaction.channelId) {
      await interaction.reply({
        content: "This permission request is no longer bound to this thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await this.#opencode.replyPermission(
      binding.directory,
      parsed.sessionId,
      parsed.permissionId,
      parsed.response,
    );
    this.#seenPermissions.delete(parsed.permissionId);
    await interaction.update({
      content: `${interaction.message.content}\n\nResolved by <@${interaction.user.id}>: **${parsed.response}**`,
      components: [],
    });
  }

  async #publishResult(sessionId: string): Promise<void> {
    const binding = this.#state.getBySession(sessionId);
    if (!binding) return;
    const result = await this.#opencode.latestAssistantResult(binding.directory, sessionId);
    if (!result || result.messageId === binding.lastPublishedAssistantMessageId) return;

    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;
    const rendered = renderAssistantResult(result.parts);
    const chunks = chunkDiscordText(rendered, 1800);
    for (const [index, chunk] of chunks.entries()) {
      await thread.send(index === 0 ? `✅ **Result**\n${chunk}` : chunk);
    }
    await this.#state.updateLastPublished(binding.threadId, result.messageId);
  }

  async #publishSessionError(sessionId: string, error: unknown): Promise<void> {
    const binding = this.#state.getBySession(sessionId);
    if (!binding) return;
    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;
    const details = errorMessage(error);
    await thread.send(`❌ **OpenCode session error**\n${truncate(details, 1800)}`);
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}

function permissionCustomId(
  response: OpenCodePermissionResponse,
  sessionId: string,
  permissionId: string,
): string {
  return `${PERMISSION_PREFIX}:${response}:${sessionId}:${permissionId}`;
}

function parsePermissionCustomId(
  customId: string,
): { response: OpenCodePermissionResponse; sessionId: string; permissionId: string } | undefined {
  const [prefix, response, sessionId, permissionId, ...extra] = customId.split(":");
  if (prefix !== PERMISSION_PREFIX || extra.length > 0 || !sessionId || !permissionId)
    return undefined;
  if (response !== "once" && response !== "always" && response !== "reject") return undefined;
  return { response, sessionId, permissionId };
}

function questionCustomId(sessionId: string, requestId: string): string {
  return `${QUESTION_PREFIX}:reject:${sessionId}:${requestId}`;
}

function parseQuestionCustomId(
  customId: string,
): { sessionId: string; requestId: string } | undefined {
  const [prefix, action, sessionId, requestId, ...extra] = customId.split(":");
  if (
    prefix !== QUESTION_PREFIX ||
    action !== "reject" ||
    extra.length > 0 ||
    !sessionId ||
    !requestId
  ) {
    return undefined;
  }
  return { sessionId, requestId };
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "ˋ").replace(/\r?\n/g, " ");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function errorMessage(error: unknown): string {
  if (!error) return "Unknown OpenCode error";
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
