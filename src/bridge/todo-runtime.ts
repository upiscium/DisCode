import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { SessionBinding } from "../domain/session-binding.js";
import type { LoggerLike } from "../logging/logger.js";
import { normalizeOpenCodeTodoUpdated } from "../opencode/todo-gateway.js";
import type { StateStore } from "../state/state-store.js";
import type { TodoPanelManager } from "./todo-panel-manager.js";

type TodoPanels = Pick<TodoPanelManager, "refreshBinding" | "runExclusive" | "updateFromEvent">;

export class TodoRuntime {
  readonly #state: StateStore;
  readonly #panels: TodoPanels;
  readonly #logger: LoggerLike;

  constructor(options: { state: StateStore; panels: TodoPanels; logger: LoggerLike }) {
    this.#state = options.state;
    this.#panels = options.panels;
    this.#logger = options.logger;
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const binding = this.#state.getByThread(interaction.channelId);
    if (!binding) {
      await interaction.reply({
        content: "This is not a bound OpenCode thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await this.#panels.refreshBinding(binding);
    await interaction.editReply("TODO panel refreshed from current OpenCode state.");
  }

  async applyEvent(hostId: string, directory: string, properties: unknown): Promise<void> {
    const update = normalizeOpenCodeTodoUpdated(properties);
    if (!update) return;
    await this.#panels.updateFromEvent(hostId, directory, update.sessionID, update.todos);
  }

  async refreshInitial(binding: SessionBinding): Promise<void> {
    await this.#refreshBounded(binding, "initial");
  }

  async reconcileStartup(): Promise<void> {
    for (const binding of this.#state.list()) {
      await this.#refreshBounded(binding, "startup");
    }
  }

  async reconcileHost(hostId: string): Promise<void> {
    for (const binding of this.#state.list()) {
      if (binding.hostId !== hostId) continue;
      await this.#refreshBounded(binding, "reconnect");
    }
  }

  runBindingMutation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return this.#panels.runExclusive(threadId, operation);
  }

  async #refreshBounded(binding: SessionBinding, trigger: string): Promise<void> {
    try {
      await this.#panels.refreshBinding(binding);
    } catch (error) {
      this.#logger.warn(
        "discord.todo_panel_failed",
        "Failed to refresh Discord TODO panel",
        {
          host_id: binding.hostId,
          session_id: binding.sessionId,
          thread_id: binding.threadId,
          trigger,
        },
        error,
      );
    }
  }
}
