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
import type { SessionBinding } from "../domain/session-binding.js";
import { type LoggerLike, noopLogger } from "../logging/logger.js";
import { probeOpenCodeHostsHealth } from "../opencode/diagnostics.js";
import type {
  OpenCodeEvent,
  OpenCodePermissionResponse,
  OpenCodeQuestionRequest,
} from "../opencode/gateway.js";
import type {
  OpenCodeHostRuntime,
  OpenCodeHostRuntimeRegistry,
} from "../opencode/host-runtime-registry.js";
import type { StateStore } from "../state/state-store.js";
import { SessionHeaderManager } from "./session-header-manager.js";
import {
  executeCloseMutation,
  executeUnbindMutation,
  lifecycleBlockReason,
  renderLifecycleBlock,
} from "./session-lifecycle.js";

const PERMISSION_PREFIX = "ocperm";
const QUESTION_PREFIX = "ocquestion";

export class Bridge {
  readonly #config: AppConfig;
  readonly #state: StateStore;
  readonly #hosts: OpenCodeHostRuntimeRegistry;
  readonly #logger: LoggerLike;
  readonly #discord: Client;
  readonly #abortController = new AbortController();
  readonly #seenPermissions = new Set<string>();
  readonly #pendingQuestions = new Map<string, OpenCodeQuestionRequest>();
  readonly #sessionHeaders: SessionHeaderManager;

  constructor(options: {
    config: AppConfig;
    state: StateStore;
    hosts: OpenCodeHostRuntimeRegistry;
    logger?: LoggerLike;
  }) {
    this.#config = options.config;
    this.#state = options.state;
    this.#hosts = options.hosts;
    this.#logger = options.logger ?? noopLogger;
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
      gatewayFor: (hostId) => this.#hosts.get(hostId).gateway,
    });
  }

  async start(): Promise<void> {
    this.#logger.info("bridge.starting", "Bridge starting", {
      host_count: this.#hosts.list().length,
    });
    await this.#registerCommands();
    this.#discord.on("interactionCreate", (interaction) => {
      void this.#handleInteraction(interaction).catch((error) =>
        this.#handleInteractionFailure(interaction, error),
      );
    });
    this.#discord.on("messageCreate", (message) => {
      void this.#handleMessage(message).catch(async (error) => {
        this.#logger.error(
          "discord.message_failed",
          "Discord message handling failed",
          { thread_id: message.channelId },
          error,
        );
        await message
          .reply(`Bridge error: ${truncate(errorMessage(error), 1600)}`)
          .catch(() => undefined);
      });
    });
    this.#discord.once(Events.ClientReady, () => {
      this.#logger.info("discord.connected", "Discord client connected");
    });

    await this.#discord.login(this.#config.discordToken);
    for (const runtime of this.#hosts.list()) {
      void this.#consumeOpenCodeEvents(runtime).catch((error) => {
        if (!this.#abortController.signal.aborted) {
          this.#logger.error(
            "opencode.consumer_failed",
            "OpenCode event consumer stopped unexpectedly",
            { host_id: runtime.id },
            error,
          );
        }
      });
    }
    await this.#reconcilePendingQuestions();
    await this.#reconcileSessionHeaders();
    this.#logger.info("bridge.started", "Bridge started", {
      host_count: this.#hosts.list().length,
    });
  }

  async stop(): Promise<void> {
    this.#logger.info("bridge.stopping", "Bridge stopping");
    this.#abortController.abort();
    this.#discord.destroy();
    this.#logger.info("bridge.stopped", "Bridge stopped");
  }

  async #handleInteractionFailure(interaction: Interaction, error: unknown): Promise<void> {
    this.#logger.error(
      "discord.interaction_failed",
      "Discord interaction failed",
      { interaction: interactionKind(interaction) },
      error,
    );
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
    const requestedHostId = interaction.options.getString("host")?.trim();
    if (requestedHostId && !this.#hosts.has(requestedHostId)) {
      await interaction.editReply(
        `Unknown OpenCode host \`${escapeInlineCode(requestedHostId)}\`. Configured hosts: ${this.#hosts
          .list()
          .map((host) => `\`${escapeInlineCode(host.id)}\``)
          .join(", ")}`,
      );
      return;
    }
    const runtime = requestedHostId ? this.#hosts.get(requestedHostId) : this.#hosts.defaultHost();

    const requestedDirectory = interaction.options.getString("directory", true);
    const directory = await runtime.authorizeDirectory(requestedDirectory);
    const requestedTitle = interaction.options.getString("title")?.trim();
    const title =
      requestedTitle || directory.split("/").filter(Boolean).at(-1) || "OpenCode session";

    const parent = await this.#discord.channels.fetch(this.#config.discordParentChannelId);
    if (!parent || parent.type !== ChannelType.GuildText) {
      throw new Error("DISCORD_PARENT_CHANNEL_ID must refer to a guild text channel");
    }

    const session = await runtime.gateway.createSession(directory, title);
    let thread: ThreadChannel | undefined;
    try {
      thread = await parent.threads.create({
        name: sanitizeThreadName(title),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: `OpenCode session ${runtime.id}/${session.id}`,
      });

      const binding: SessionBinding = {
        threadId: thread.id,
        parentChannelId: parent.id,
        hostId: runtime.id,
        sessionId: session.id,
        directory,
        title,
        createdBy: interaction.user.id,
        createdAt: new Date().toISOString(),
      };
      await this.#state.put(binding);
      await this.#sessionHeaders.createInitialHeader(binding, thread);
      await interaction.editReply(
        `Created <#${thread.id}> for OpenCode host \`${runtime.id}\`, session \`${session.id}\`.`,
      );
      await this.#refreshSessionHeader(runtime.id, binding.sessionId);
      this.#logger.info("session.created", "OpenCode session created", {
        host_id: runtime.id,
        session_id: session.id,
        thread_id: thread.id,
      });
    } catch (error) {
      if (thread) {
        await this.#state.remove(thread.id).catch((rollbackError) => {
          this.#logger.error(
            "session.rollback_failed",
            "Failed to roll back Bridge state",
            {
              host_id: runtime.id,
              session_id: session.id,
              thread_id: thread?.id,
              rollback_stage: "state",
            },
            rollbackError,
          );
        });
        await thread
          .delete("Rolling back failed OpenCode bridge session creation")
          .catch((rollbackError) => {
            this.#logger.error(
              "session.rollback_failed",
              "Failed to roll back Discord thread",
              {
                host_id: runtime.id,
                session_id: session.id,
                thread_id: thread?.id,
                rollback_stage: "discord_thread",
              },
              rollbackError,
            );
          });
      }
      await runtime.gateway.deleteSession(directory, session.id).catch((rollbackError) => {
        this.#logger.error(
          "session.rollback_failed",
          "Failed to roll back OpenCode session",
          {
            host_id: runtime.id,
            session_id: session.id,
            ...(thread ? { thread_id: thread.id } : {}),
            rollback_stage: "opencode_session",
          },
          rollbackError,
        );
      });
      throw error;
    }
  }

  async #health(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const defaultHostId = this.#hosts.defaultHost().id;
    const health = await probeOpenCodeHostsHealth(
      this.#hosts.list().map((runtime) => ({
        id: runtime.id,
        isDefault: runtime.id === defaultHostId,
        baseUrl: runtime.config.baseUrl,
        username: runtime.config.username,
        ...(runtime.config.password ? { password: runtime.config.password } : {}),
        sse: runtime.sseMonitor.status(),
      })),
    );
    await interaction.editReply(renderHealthDiagnostic(health));
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
    const runtime = this.#runtimeFor(binding);
    const status = await runtime.gateway.status(binding.directory, binding.sessionId);
    await interaction.reply({
      content: renderSessionStatus({
        hostId: binding.hostId,
        sessionId: binding.sessionId,
        status: status?.type ?? "idle",
        directory: binding.directory,
        baseUrl: runtime.config.baseUrl,
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
    await this.#runtimeFor(binding).gateway.abort(binding.directory, binding.sessionId);
    await interaction.reply({
      content: `Abort requested for \`${binding.hostId}/${binding.sessionId}\`.`,
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
    const runtime = this.#runtimeFor(binding);
    const status = await runtime.gateway.status(binding.directory, binding.sessionId);
    const blocker = lifecycleBlockReason(
      status?.type,
      this.#pendingQuestions.has(sessionKey(binding.hostId, binding.sessionId)),
    );
    if (blocker) {
      await interaction.editReply(renderLifecycleBlock(blocker));
      return;
    }

    await executeCloseMutation({
      deleteSession: () => runtime.gateway.deleteSession(binding.directory, binding.sessionId),
      removeBinding: () => this.#state.remove(binding.threadId),
    });
    this.#pendingQuestions.delete(sessionKey(binding.hostId, binding.sessionId));
    this.#logger.info("session.closed", "OpenCode session closed", {
      host_id: binding.hostId,
      session_id: binding.sessionId,
      thread_id: binding.threadId,
    });

    await interaction.editReply(
      `Closed OpenCode session \`${binding.hostId}/${binding.sessionId}\` and removed this Discord binding. Archiving the thread.`,
    );

    try {
      const thread = await this.#fetchThread(binding.threadId);
      if (!thread) throw new Error("Bound Discord thread could not be fetched");
      await thread.setArchived(
        true,
        `OpenCode session ${binding.hostId}/${binding.sessionId} closed`,
      );
    } catch (error) {
      this.#logger.warn(
        "discord.thread_archive_failed",
        "Discord thread could not be archived after session close",
        {
          host_id: binding.hostId,
          session_id: binding.sessionId,
          thread_id: binding.threadId,
        },
        error,
      );
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
    const runtime = this.#runtimeFor(binding);
    const status = await runtime.gateway.status(binding.directory, binding.sessionId);
    const blocker = lifecycleBlockReason(
      status?.type,
      this.#pendingQuestions.has(sessionKey(binding.hostId, binding.sessionId)),
    );
    if (blocker) {
      await interaction.editReply(renderLifecycleBlock(blocker));
      return;
    }

    await executeUnbindMutation({
      removeBinding: () => this.#state.remove(binding.threadId),
    });
    this.#pendingQuestions.delete(sessionKey(binding.hostId, binding.sessionId));
    this.#logger.info("session.unbound", "Discord thread unbound from OpenCode session", {
      host_id: binding.hostId,
      session_id: binding.sessionId,
      thread_id: binding.threadId,
    });
    await interaction.editReply(
      [
        `Unbound this thread from OpenCode session \`${binding.hostId}/${binding.sessionId}\`.`,
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
    const runtime = this.#runtimeFor(binding);

    const text = message.content.trim();
    const hasAttachments = message.attachments.size > 0;
    if (!text && !hasAttachments) return;

    const pendingKey = sessionKey(binding.hostId, binding.sessionId);
    const pendingQuestion = this.#pendingQuestions.get(pendingKey);
    if (pendingQuestion) {
      if (hasAttachments) {
        await message.reply("Attachments cannot answer a pending Ask. Send a text-only answer.");
        return;
      }
      try {
        const answers = parseQuestionAnswers(text, pendingQuestion.questions);
        await runtime.gateway.replyQuestion(binding.directory, pendingQuestion.id, answers);
        this.#pendingQuestions.delete(pendingKey);
        await message.reply(`↩️ Answer sent for Ask \`${pendingQuestion.id}\`.`);
      } catch (error) {
        await message.reply(`Could not parse the Ask answer: ${errorMessage(error)}`);
      }
      return;
    }

    const status = await runtime.gateway.status(binding.directory, binding.sessionId);
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
        await runtime.gateway.promptAsyncWithFiles(
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
      await runtime.gateway.promptAsync(binding.directory, binding.sessionId, text);
    }
    await message.react("⏳").catch(() => undefined);
  }

  async #consumeOpenCodeEvents(runtime: OpenCodeHostRuntime): Promise<void> {
    for await (const globalEvent of runtime.gateway.events(this.#abortController.signal)) {
      runtime.sseMonitor.observe();
      await this.#handleOpenCodeEvent(runtime.id, globalEvent.payload, globalEvent.directory).catch(
        (error) => {
          this.#logger.error(
            "opencode.event_failed",
            "Failed to handle OpenCode event",
            {
              host_id: runtime.id,
              opencode_event: globalEvent.payload.type,
            },
            error,
          );
        },
      );
    }
  }

  async #handleOpenCodeEvent(
    hostId: string,
    event: OpenCodeEvent,
    directory: string,
  ): Promise<void> {
    switch (event.type) {
      case "message.updated":
        if (event.properties.info.role === "user") {
          await this.#refreshSessionHeader(hostId, event.properties.info.sessionID);
        }
        break;
      case "vcs.branch.updated":
        await this.#refreshHeadersForDirectory(hostId, directory);
        break;
      case "permission.updated":
        await this.#publishPermission(hostId, event);
        break;
      case "permission.replied":
        this.#seenPermissions.delete(permissionKey(hostId, event.properties.permissionID));
        break;
      case "question.asked":
        await this.#publishQuestion(hostId, event.properties);
        break;
      case "question.replied":
      case "question.rejected": {
        const key = sessionKey(hostId, event.properties.sessionID);
        const pending = this.#pendingQuestions.get(key);
        if (pending?.id === event.properties.requestID) {
          this.#pendingQuestions.delete(key);
        }
        break;
      }
      case "session.idle":
        await this.#publishResult(hostId, event.properties.sessionID);
        break;
      case "session.error":
        if (event.properties.sessionID) {
          await this.#publishSessionError(
            hostId,
            event.properties.sessionID,
            event.properties.error,
          );
        }
        break;
      default:
        break;
    }
  }

  async #refreshSessionHeader(hostId: string, sessionId: string): Promise<void> {
    try {
      await this.#sessionHeaders.refreshSession(hostId, sessionId);
    } catch (error) {
      this.#logger.warn(
        "discord.session_header_failed",
        "Failed to refresh Discord session header",
        { host_id: hostId, session_id: sessionId },
        error,
      );
    }
  }

  async #refreshHeadersForDirectory(hostId: string, directory: string): Promise<void> {
    for (const binding of this.#state.list()) {
      if (binding.hostId !== hostId || binding.directory !== directory) continue;
      await this.#refreshSessionHeader(hostId, binding.sessionId);
    }
  }

  async #reconcileSessionHeaders(): Promise<void> {
    for (const binding of this.#state.list()) {
      await this.#refreshSessionHeader(binding.hostId, binding.sessionId);
    }
  }

  async #reconcilePendingQuestions(): Promise<void> {
    for (const runtime of this.#hosts.list()) {
      const directories = [
        ...new Set(
          this.#state
            .list()
            .filter((binding) => binding.hostId === runtime.id)
            .map((binding) => binding.directory),
        ),
      ];
      for (const directory of directories) {
        try {
          const questions = await runtime.gateway.listQuestions(directory);
          for (const question of questions) {
            if (this.#state.getBySession(runtime.id, question.sessionID)) {
              await this.#publishQuestion(runtime.id, question);
            }
          }
        } catch (error) {
          this.#logger.warn(
            "opencode.question_reconcile_failed",
            "Failed to reconcile pending OpenCode questions",
            { host_id: runtime.id },
            error,
          );
        }
      }
    }
  }

  async #publishQuestion(hostId: string, request: OpenCodeQuestionRequest): Promise<void> {
    const key = sessionKey(hostId, request.sessionID);
    const current = this.#pendingQuestions.get(key);
    if (current?.id === request.id) return;
    const binding = this.#state.getBySession(hostId, request.sessionID);
    if (!binding) return;
    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;

    this.#pendingQuestions.set(key, request);
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
    const binding = this.#state.getByThread(interaction.channelId);
    const pending = binding
      ? this.#pendingQuestions.get(sessionKey(binding.hostId, binding.sessionId))
      : undefined;
    if (!binding || binding.sessionId !== parsed.sessionId || pending?.id !== parsed.requestId) {
      await interaction.reply({
        content: "This Ask is no longer pending for this thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.#runtimeFor(binding).gateway.rejectQuestion(binding.directory, parsed.requestId);
    this.#pendingQuestions.delete(sessionKey(binding.hostId, binding.sessionId));
    await interaction.update({
      content: `${interaction.message.content}\n\nRejected by <@${interaction.user.id}>.`,
      components: [],
    });
  }

  async #publishPermission(
    hostId: string,
    event: Extract<OpenCodeEvent, { type: "permission.updated" }>,
  ): Promise<void> {
    const permission = event.properties;
    const seenKey = permissionKey(hostId, permission.id);
    if (this.#seenPermissions.has(seenKey)) return;
    const binding = this.#state.getBySession(hostId, permission.sessionID);
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
    this.#seenPermissions.add(seenKey);
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
    const binding = this.#state.getByThread(interaction.channelId);
    if (!binding || binding.sessionId !== parsed.sessionId) {
      await interaction.reply({
        content: "This permission request is no longer bound to this thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await this.#runtimeFor(binding).gateway.replyPermission(
      binding.directory,
      parsed.sessionId,
      parsed.permissionId,
      parsed.response,
    );
    this.#seenPermissions.delete(permissionKey(binding.hostId, parsed.permissionId));
    await interaction.update({
      content: `${interaction.message.content}\n\nResolved by <@${interaction.user.id}>: **${parsed.response}**`,
      components: [],
    });
  }

  async #publishResult(hostId: string, sessionId: string): Promise<void> {
    const binding = this.#state.getBySession(hostId, sessionId);
    if (!binding) return;
    const result = await this.#hosts
      .get(hostId)
      .gateway.latestAssistantResult(binding.directory, sessionId);
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

  async #publishSessionError(hostId: string, sessionId: string, error: unknown): Promise<void> {
    const binding = this.#state.getBySession(hostId, sessionId);
    if (!binding) return;
    const thread = await this.#fetchThread(binding.threadId);
    if (!thread) return;
    this.#logger.warn("opencode.session_error", "OpenCode session reported an error", {
      host_id: hostId,
      session_id: sessionId,
      thread_id: binding.threadId,
    });
    const details = errorMessage(error);
    await thread.send(`❌ **OpenCode session error**\n${truncate(details, 1800)}`);
  }

  #runtimeFor(binding: SessionBinding): OpenCodeHostRuntime {
    return this.#hosts.get(binding.hostId);
  }

  async #fetchThread(threadId: string): Promise<ThreadChannel | undefined> {
    const channel = await this.#discord.channels.fetch(threadId);
    return channel?.isThread() ? channel : undefined;
  }
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

function permissionKey(hostId: string, permissionId: string): string {
  return `${hostId}:${permissionId}`;
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

function interactionKind(interaction: Interaction): string {
  if (interaction.isChatInputCommand()) return "chat_input";
  if (interaction.isButton()) return "button";
  return "other";
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
