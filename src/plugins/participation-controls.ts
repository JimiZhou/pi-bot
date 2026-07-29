import type { AgentPlugin, AgentPluginContext, AgentPluginFactory } from "../agent-plugin.js";
import type { BotPluginConfig } from "../config.js";

/**
 * Marker plugins for per-bot and per-chatroom participation policy.
 * The hot path is intentionally implemented as a Core/Supervisor gate; these
 * plugins own configuration identity without adding another model call.
 */
class ParticipationControlPlugin implements AgentPlugin {
  readonly id: string;
  readonly type: string;

  constructor(config: BotPluginConfig, _context: AgentPluginContext) {
    this.id = config.id;
    this.type = config.type;
  }

  tick(): void {
    // Policy-only plugin; scheduled work remains in AgentSupervisor.
  }
}

export const autoParticipationPluginFactory: AgentPluginFactory = {
  type: "auto-participation",
  create: (config, context) => new ParticipationControlPlugin(config, context),
};

export const coldChatWarmupPluginFactory: AgentPluginFactory = {
  type: "cold-chat-warmup",
  create: (config, context) => new ParticipationControlPlugin(config, context),
};
