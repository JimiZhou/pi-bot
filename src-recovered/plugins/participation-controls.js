/**
 * Marker plugins for per-bot and per-chatroom participation policy.
 * The hot path is intentionally implemented as a Core/Supervisor gate; these
 * plugins own configuration identity without adding another model call.
 */
class ParticipationControlPlugin {
    id;
    type;
    constructor(config, _context) {
        this.id = config.id;
        this.type = config.type;
    }
    tick() {
        // Policy-only plugin; scheduled work remains in AgentSupervisor.
    }
}
export const autoParticipationPluginFactory = {
    type: "auto-participation",
    create: (config, context) => new ParticipationControlPlugin(config, context),
};
export const coldChatWarmupPluginFactory = {
    type: "cold-chat-warmup",
    create: (config, context) => new ParticipationControlPlugin(config, context),
};
//# sourceMappingURL=participation-controls.js.map