export class AgentPluginRegistry {
    #factories = new Map();
    register(factory) {
        if (!factory.type.trim())
            throw new Error("Agent plugin factory type cannot be empty");
        if (this.#factories.has(factory.type))
            throw new Error(`Duplicate agent plugin type: ${factory.type}`);
        this.#factories.set(factory.type, factory);
        return this;
    }
    create(config, context) {
        const factory = this.#factories.get(config.type);
        if (!factory)
            throw new Error(`Unknown agent plugin type: ${config.type}`);
        const plugin = factory.create(config, context);
        if (plugin.id !== config.id || plugin.type !== config.type) {
            throw new Error(`Agent plugin ${config.id} returned an invalid identity`);
        }
        return plugin;
    }
}
//# sourceMappingURL=agent-plugin.js.map