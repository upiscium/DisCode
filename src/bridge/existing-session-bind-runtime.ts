import {
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
} from "discord.js";
import { sanitizeThreadName } from "../discord/format.js";
import { renderCanonicalIdentifier } from "../discord/identifier.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { LoggerLike } from "../logging/logger.js";
import type { ExistingSessionScope } from "../opencode/existing-session-discovery.js";
import type { ExistingSession } from "../opencode/existing-session-gateway.js";
import { runManagedPanelMutation } from "./session-lifecycle.js";

type Host = Readonly<{
  id: string;
  authorizeDirectory(directory: string): Promise<string>;
  existingSessions: { getSession(directory: string, id: string): Promise<ExistingSession> };
}>;

type Hosts = Readonly<{
  has(id: string): boolean;
  get(id: string): Host;
  defaultHost(): Host;
}>;

type State = {
  getBySession(hostId: string, sessionId: string): SessionBinding | undefined;
  claimBindingIfSessionUnbound(binding: SessionBinding): Promise<boolean>;
  removeBindingIfMatches(threadId: string, hostId: string, sessionId: string): Promise<boolean>;
};

type Discord = { channels: { fetch(id: string): Promise<unknown> } };

type Parent = {
  id: string;
  type: ChannelType.GuildText;
  threads: { create(options: unknown): Promise<ThreadChannel> };
};

type Headers = {
  createInitialHeader(binding: SessionBinding, thread: ThreadChannel): Promise<void>;
  refreshSession(hostId: string, sessionId: string): Promise<void>;
};

type Panels = {
  refreshInitial(binding: SessionBinding): Promise<void>;
  runBindingMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T>;
};

type BindResult =
  | { kind: "bound"; binding: SessionBinding }
  | { kind: "already-bound" }
  | { kind: "failed" };

const FAILED = "Unable to bind that OpenCode session right now.";
const INELIGIBLE = "That OpenCode session is not eligible for binding.";
const ALREADY_BOUND = "That OpenCode session is already bound.";
const UNKNOWN_HOST = "Unknown configured OpenCode host.";
const FALLBACK_TITLE = "OpenCode session";
const MAX_LOG_IDENTIFIER = 256;

/** Owns existing-session bind authority, Discord mutation, and compensation. */
export class ExistingSessionBindRuntime {
  readonly #hosts: Hosts;
  readonly #state: State;
  readonly #discord: Discord;
  readonly #parentChannelId: string;
  readonly #headers: Headers;
  readonly #todos: Panels;
  readonly #subagents: Panels & { forgetBinding(binding: SessionBinding): void };
  readonly #logger: LoggerLike;
  readonly #invalidate: (scope: ExistingSessionScope) => void;
  readonly #now: () => Date;
  readonly #serial = new Map<string, Promise<void>>();

  constructor(options: {
    hosts: Hosts;
    state: State;
    discord: Discord;
    config: { discordParentChannelId: string };
    headers: Headers;
    todos: Panels;
    subagents: Panels & { forgetBinding(binding: SessionBinding): void };
    logger: LoggerLike;
    invalidate: (scope: ExistingSessionScope) => void;
    now?: () => Date;
  }) {
    this.#hosts = options.hosts;
    this.#state = options.state;
    this.#discord = options.discord;
    this.#parentChannelId = options.config.discordParentChannelId;
    this.#headers = options.headers;
    this.#todos = options.todos;
    this.#subagents = options.subagents;
    this.#logger = options.logger;
    this.#invalidate = options.invalidate;
    this.#now = options.now ?? (() => new Date());
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const host = this.#host(interaction.options.getString("host"));
    if (!host) {
      await interaction.editReply(UNKNOWN_HOST);
      return;
    }

    let directory: string;
    let selector: string;
    let first: ExistingSession;
    try {
      directory = await host.authorizeDirectory(interaction.options.getString("directory", true));
      selector = interaction.options.getString("session", true).trim();
      first = await host.existingSessions.getSession(directory, selector);
    } catch {
      await interaction.editReply(FAILED);
      return;
    }

    if (!eligible(first, host.id, directory, selector)) {
      await interaction.editReply(INELIGIBLE);
      return;
    }

    const result = await this.#inSessionLock(host.id, selector, () =>
      this.#bindCurrent(interaction, host, directory, selector, first),
    );
    if (result.kind === "already-bound") {
      await interaction.editReply(ALREADY_BOUND);
      return;
    }
    if (result.kind === "failed") {
      await interaction.editReply(FAILED);
      return;
    }

    const { binding } = result;
    this.#invalidate({ hostId: binding.hostId, canonicalDirectory: binding.directory });
    this.#logger.info("session.bound", "Existing OpenCode session bound", safeFields(binding));
    await interaction
      .editReply(
        `Bound <#${binding.threadId}> to OpenCode host ${renderCanonicalIdentifier(binding.hostId)}, session ${renderCanonicalIdentifier(binding.sessionId)}.`,
      )
      .catch((error) => {
        this.#logger.warn(
          "discord.bind_reply_failed",
          "Committed bind reply could not be edited",
          safeFields(binding),
          error,
        );
      });
  }

  async #bindCurrent(
    interaction: ChatInputCommandInteraction,
    host: Host,
    directory: string,
    selector: string,
    first: ExistingSession,
  ): Promise<BindResult> {
    if (this.#state.getBySession(host.id, selector)) return { kind: "already-bound" };

    let thread: ThreadChannel | undefined;
    let binding: SessionBinding | undefined;
    let claimed = false;
    try {
      const parent = await this.#parent();
      const firstTitle = title(first);
      thread = await parent.threads.create({
        name: sanitizeThreadName(firstTitle),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: "Binding an existing OpenCode session",
      });

      const second = await host.existingSessions.getSession(directory, selector);
      if (!eligible(second, host.id, directory, selector)) throw new BindFailure();
      if (this.#state.getBySession(host.id, selector)) throw new AlreadyBound();

      binding = {
        threadId: thread.id,
        parentChannelId: parent.id,
        hostId: host.id,
        sessionId: selector,
        directory,
        title: title(second),
        createdBy: interaction.user.id,
        createdAt: this.#now().toISOString(),
      };
      claimed = await this.#state.claimBindingIfSessionUnbound(binding);
      if (!claimed) throw new AlreadyBound();

      await this.#headers.createInitialHeader(binding, thread);
      await this.#todos.refreshInitial(binding);
      await this.#subagents.refreshInitial(binding);
      await this.#headers.refreshSession(binding.hostId, binding.sessionId);
      return { kind: "bound", binding };
    } catch (error) {
      if (thread) {
        if (claimed && binding) await this.#rollbackClaim(binding, thread);
        else await this.#deleteThread(thread, host.id, selector);
      }
      return error instanceof AlreadyBound ? { kind: "already-bound" } : { kind: "failed" };
    }
  }

  #host(id: string | null): Host | undefined {
    const selected = id?.trim();
    if (selected) return this.#hosts.has(selected) ? this.#hosts.get(selected) : undefined;
    return this.#hosts.defaultHost();
  }

  async #parent(): Promise<Parent> {
    const channel = await this.#discord.channels.fetch(this.#parentChannelId);
    if (
      !channel ||
      typeof channel !== "object" ||
      (channel as { type?: unknown }).type !== ChannelType.GuildText
    ) {
      throw new BindFailure();
    }
    return channel as Parent;
  }

  async #inSessionLock<T>(
    hostId: string,
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([hostId, sessionId]);
    const previous = this.#serial.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#serial.set(key, settled);
    try {
      return await current;
    } finally {
      if (this.#serial.get(key) === settled) this.#serial.delete(key);
    }
  }

  async #rollbackClaim(binding: SessionBinding, thread: ThreadChannel): Promise<void> {
    try {
      const removed = await runManagedPanelMutation(
        binding.threadId,
        this.#todos,
        this.#subagents,
        () =>
          this.#state.removeBindingIfMatches(binding.threadId, binding.hostId, binding.sessionId),
      );
      if (!removed) {
        this.#logger.error("session.rollback_failed", "Binding rollback was guarded out", {
          ...safeFields(binding),
          rollback_stage: "state",
        });
        return;
      }
      this.#subagents.forgetBinding(binding);
      await this.#deleteThread(thread, binding.hostId, binding.sessionId);
    } catch (error) {
      this.#logger.error(
        "session.rollback_failed",
        "Failed to roll back binding",
        { ...safeFields(binding), rollback_stage: "state" },
        error,
      );
    }
  }

  async #deleteThread(thread: ThreadChannel, hostId: string, sessionId: string): Promise<void> {
    await thread.delete("Rolling back failed OpenCode binding").catch((error) => {
      this.#logger.error(
        "session.rollback_failed",
        "Failed to delete binding thread",
        {
          host_id: safeLogIdentifier(hostId),
          session_id: safeLogIdentifier(sessionId),
          thread_id: safeLogIdentifier(thread.id),
          rollback_stage: "discord_thread",
        },
        error,
      );
    });
  }
}

class BindFailure extends Error {}
class AlreadyBound extends Error {}

function eligible(
  session: ExistingSession,
  hostId: string,
  directory: string,
  selector: string,
): boolean {
  return (
    session.hostId === hostId &&
    session.id === selector &&
    session.directory === directory &&
    session.parentId === undefined &&
    session.archivedAt === undefined
  );
}

function title(session: ExistingSession): string {
  return session.title?.trim() || FALLBACK_TITLE;
}

function safeLogIdentifier(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? "�" : character;
    })
    .join("")
    .slice(0, MAX_LOG_IDENTIFIER);
}

function safeFields(binding: SessionBinding): Record<string, string> {
  return {
    host_id: safeLogIdentifier(binding.hostId),
    session_id: safeLogIdentifier(binding.sessionId),
    thread_id: safeLogIdentifier(binding.threadId),
  };
}
