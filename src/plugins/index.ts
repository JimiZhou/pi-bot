import { AgentPluginRegistry } from "../agent-plugin.js";
import { morningBriefPluginFactory } from "./morning-brief.js";
import { patReplyPluginFactory } from "./pat-reply.js";
import { groupSummaryPluginFactory } from "./group-summary.js";
import { scheduledTaskPluginFactory } from "./scheduled-task.js";
import { autoParticipationPluginFactory, coldChatWarmupPluginFactory } from "./participation-controls.js";
import { personaCommandPluginFactory } from "./persona-command.js";
import { repeaterPluginFactory } from "./repeater.js";
import { redEnvelopeNotifyPluginFactory } from "./red-envelope-notify.js";
import { groupEventNotifyPluginFactory } from "./group-event-notify.js";
import { magnetCodeSearchPluginFactory } from "./magnet-code-search.js";
import { memeGeneratorPluginFactory } from "./meme-generator.js";

export function createBuiltInAgentPluginRegistry(): AgentPluginRegistry {
  return new AgentPluginRegistry()
    .register(morningBriefPluginFactory)
    .register(patReplyPluginFactory)
    .register(groupSummaryPluginFactory)
    .register(scheduledTaskPluginFactory)
    .register(autoParticipationPluginFactory)
    .register(coldChatWarmupPluginFactory)
    .register(repeaterPluginFactory)
    .register(redEnvelopeNotifyPluginFactory)
    .register(groupEventNotifyPluginFactory)
    .register(magnetCodeSearchPluginFactory)
    .register(memeGeneratorPluginFactory)
    .register(personaCommandPluginFactory);
}

export { MorningBriefPlugin, morningBriefPluginFactory } from "./morning-brief.js";
export { PatReplyPlugin, patReplyPluginFactory } from "./pat-reply.js";
export { GroupSummaryPlugin, groupSummaryPluginFactory, isGroupSummaryRequest } from "./group-summary.js";
export {
  ScheduledTaskPlugin,
  createScheduledTaskToolProvider,
  isScheduledTaskIntent,
  scheduledTaskPluginFactory,
} from "./scheduled-task.js";
export { autoParticipationPluginFactory, coldChatWarmupPluginFactory } from "./participation-controls.js";
export { RepeaterPlugin, repeaterPluginFactory } from "./repeater.js";
export { RedEnvelopeNotifyPlugin, redEnvelopeNotifyPluginFactory } from "./red-envelope-notify.js";
export { GroupEventNotifyPlugin, groupEventNotifyPluginFactory } from "./group-event-notify.js";
export {
  MagnetCodeSearchPlugin,
  magnetCodeSearchPluginFactory,
  parseCatalogCode,
  searchMagnets,
} from "./magnet-code-search.js";
export {
  MemeGeneratorPlugin,
  compressForChat,
  memeGeneratorPluginFactory,
  parseMemeCommand,
  type MemeCommand,
  type MemeGeneratorSettings,
} from "./meme-generator.js";
export { BUILT_IN_PLUGIN_DEFINITIONS, builtInPluginDefinition, withImplicitBuiltInPlugins } from "./catalog.js";
export {
  PersonaCommandPlugin,
  parseManagementCommand,
  parsePersonaCommand,
  personaCommandPluginFactory,
} from "./persona-command.js";
