import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PERSONA_PROFILE, parseBotConfig, parseGlobalSettings, parseKnowledgeProviderProfile, parseMcpServerProfile, parseModelProfile, parsePersonaProfile, parseProviderProfile, } from "./config.js";
import { nextScheduledTaskRun, validateScheduledTaskSchedule, } from "../scheduled-task.js";
/** Small control-plane database. Bot transcripts remain in separate per-bot SQLite files. */
export class AdminStore {
    #database;
    #secretKey;
    constructor(path, options = {}) {
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true });
        if (path !== ":memory:" && !options.secretKey) {
            throw new Error("AdminStore requires a secretKey for persistent databases");
        }
        const secretKey = options.secretKey ?? randomBytes(32);
        if (secretKey.byteLength !== 32)
            throw new Error("AdminStore secretKey must contain exactly 32 bytes");
        this.#secretKey = Buffer.from(secretKey);
        this.#database = new DatabaseSync(path);
        this.#database.exec("PRAGMA journal_mode = WAL");
        this.#database.exec("PRAGMA synchronous = NORMAL");
        this.#database.exec("PRAGMA busy_timeout = 5000");
        this.#database.exec(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        secret_blob TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS persona_profiles (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_persona_overrides (
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        persona_profile_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_persona_profile_idx
        ON conversation_persona_overrides(persona_profile_id, bot_id);
      CREATE TABLE IF NOT EXISTS conversation_voice_modes (
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('voice', 'whisper')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS knowledge_provider_profiles (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        secret_blob TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_server_profiles (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        secret_blob TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_configs (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        scope TEXT NOT NULL,
        bot_id TEXT,
        event TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_logs_created_idx ON admin_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS admin_logs_bot_idx ON admin_logs(bot_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS admin_logs_level_idx ON admin_logs(level, created_at DESC);
      CREATE TABLE IF NOT EXISTS proactive_claims (
        claim_key TEXT PRIMARY KEY,
        canonical_conversation_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        ambient INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proactive_claims_conversation_idx
        ON proactive_claims(canonical_conversation_id, ambient, created_at DESC);
      CREATE INDEX IF NOT EXISTS proactive_claims_bot_idx
        ON proactive_claims(bot_id, ambient, created_at DESC);
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        conversation_title TEXT,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        title TEXT NOT NULL,
        task_content TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        timezone_offset_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        next_run_at INTEGER,
        locked_until INTEGER,
        last_run_at INTEGER,
        last_status TEXT NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx
        ON scheduled_tasks(bot_id, enabled, next_run_at, locked_until);
      CREATE INDEX IF NOT EXISTS scheduled_tasks_conversation_idx
        ON scheduled_tasks(conversation_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS scheduled_task_drafts (
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, conversation_id, creator_id)
      );
      CREATE INDEX IF NOT EXISTS scheduled_task_drafts_expiry_idx
        ON scheduled_task_drafts(expires_at);
      CREATE TABLE IF NOT EXISTS emojis (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        asset_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('analyzing', 'ready', 'failed')),
        enabled INTEGER NOT NULL DEFAULT 1,
        is_thinking INTEGER NOT NULL DEFAULT 0,
        source_conversation_id TEXT,
        source_sender_id TEXT,
        source_message_id TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(bot_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS emojis_bot_idx ON emojis(bot_id, enabled, status, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS emojis_thinking_idx ON emojis(bot_id) WHERE is_thinking = 1;
      CREATE TABLE IF NOT EXISTS group_member_snapshots (
        conversation_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        nickname TEXT,
        display_name TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        first_observed_at INTEGER NOT NULL,
        last_observed_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, member_id)
      );
      CREATE INDEX IF NOT EXISTS group_member_snapshots_room_idx
        ON group_member_snapshots(conversation_id, active, last_observed_at DESC);
      CREATE TABLE IF NOT EXISTS group_room_availability (
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        consecutive_unavailable INTEGER NOT NULL DEFAULT 0,
        inactive INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS group_room_availability_inactive_idx
        ON group_room_availability(bot_id, inactive, updated_at DESC);
        `);
        this.#migrateLegacyModelProfiles();
        this.#deduplicateEmojisByHash();
        if (!this.#database.prepare("SELECT 1 FROM admin_settings WHERE id = 'global'").get()) {
            this.saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS);
        }
        if (!this.getPersonaProfile(DEFAULT_PERSONA_PROFILE.id)) {
            this.savePersonaProfile(DEFAULT_PERSONA_PROFILE);
        }
        const settings = this.getGlobalSettings();
        if (!settings.defaultPersonaProfileId) {
            this.saveGlobalSettings({ ...settings, defaultPersonaProfileId: DEFAULT_PERSONA_PROFILE.id });
        }
    }
    close() {
        this.#database.close();
    }
    getGlobalSettings() {
        const row = this.#database
            .prepare("SELECT config_json FROM admin_settings WHERE id = 'global'")
            .get();
        return row ? parseGlobalSettings(parseJson(row.config_json, "global settings")) : { ...DEFAULT_GLOBAL_SETTINGS };
    }
    saveGlobalSettings(value) {
        const settings = parseGlobalSettings(value);
        this.#database
            .prepare(`INSERT INTO admin_settings (id, config_json, updated_at) VALUES ('global', ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
            .run(JSON.stringify(settings), Date.now());
        return settings;
    }
    listProviderProfiles() {
        const rows = this.#database
            .prepare("SELECT id, config_json, secret_blob FROM provider_profiles ORDER BY id")
            .all();
        return rows.map((row) => this.#providerSummary(row));
    }
    getProviderProfile(id) {
        const row = this.#database
            .prepare("SELECT id, config_json, secret_blob FROM provider_profiles WHERE id = ?")
            .get(id);
        return row ? this.#providerSummary(row) : undefined;
    }
    saveProviderProfile(value, apiKeyUpdate) {
        const profile = parseProviderProfile(value);
        const existing = this.#database
            .prepare("SELECT secret_blob FROM provider_profiles WHERE id = ?")
            .get(profile.id);
        const secretBlob = apiKeyUpdate === undefined
            ? (existing?.secret_blob ?? null)
            : apiKeyUpdate === null
                ? null
                : this.#encryptApiKey(profile.id, normalizeApiKey(apiKeyUpdate));
        const now = Date.now();
        this.#database
            .prepare(`INSERT INTO provider_profiles (id, config_json, secret_blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json,
           secret_blob = excluded.secret_blob, updated_at = excluded.updated_at`)
            .run(profile.id, JSON.stringify(profile), secretBlob, now, now);
        return { ...profile, hasApiKey: secretBlob !== null };
    }
    deleteProviderProfile(id) {
        return this.#database.prepare("DELETE FROM provider_profiles WHERE id = ?").run(id).changes === 1;
    }
    getProviderApiKey(id) {
        const row = this.#database
            .prepare("SELECT secret_blob FROM provider_profiles WHERE id = ?")
            .get(id);
        return row?.secret_blob ? this.#decryptApiKey(id, row.secret_blob) : undefined;
    }
    providerUsage(id) {
        return {
            modelIds: this.listModelProfiles().filter((model) => model.providerProfileId === id).map((model) => model.id),
        };
    }
    listKnowledgeProviderProfiles() {
        const rows = this.#database
            .prepare("SELECT id, config_json, secret_blob FROM knowledge_provider_profiles ORDER BY id")
            .all();
        return rows.map((row) => this.#knowledgeProviderSummary(row));
    }
    getKnowledgeProviderProfile(id) {
        const row = this.#database
            .prepare("SELECT id, config_json, secret_blob FROM knowledge_provider_profiles WHERE id = ?")
            .get(id);
        return row ? this.#knowledgeProviderSummary(row) : undefined;
    }
    saveKnowledgeProviderProfile(value, apiKeyUpdate) {
        const profile = parseKnowledgeProviderProfile(value);
        const existing = this.#database
            .prepare("SELECT secret_blob FROM knowledge_provider_profiles WHERE id = ?")
            .get(profile.id);
        const secretBlob = apiKeyUpdate === undefined
            ? (existing?.secret_blob ?? null)
            : apiKeyUpdate === null
                ? null
                : this.#encryptSecret("knowledge", profile.id, normalizeApiKey(apiKeyUpdate));
        const now = Date.now();
        this.#database
            .prepare(`INSERT INTO knowledge_provider_profiles (id, config_json, secret_blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json,
           secret_blob = excluded.secret_blob, updated_at = excluded.updated_at`)
            .run(profile.id, JSON.stringify(profile), secretBlob, now, now);
        return { ...profile, hasApiKey: secretBlob !== null };
    }
    deleteKnowledgeProviderProfile(id) {
        return this.#database.prepare("DELETE FROM knowledge_provider_profiles WHERE id = ?").run(id).changes === 1;
    }
    getKnowledgeProviderApiKey(id) {
        const row = this.#database
            .prepare("SELECT secret_blob FROM knowledge_provider_profiles WHERE id = ?")
            .get(id);
        return row?.secret_blob ? this.#decryptSecret("knowledge", id, row.secret_blob) : undefined;
    }
    listMcpServerProfiles() {
        const rows = this.#database
            .prepare("SELECT id, config_json, secret_blob FROM mcp_server_profiles ORDER BY id")
            .all();
        return rows.map((row) => this.#mcpServerSummary(row));
    }
    getMcpServerProfile(id) {
        const row = this.#database
            .prepare("SELECT id, config_json, secret_blob FROM mcp_server_profiles WHERE id = ?")
            .get(id);
        return row ? this.#mcpServerSummary(row) : undefined;
    }
    saveMcpServerProfile(value, secretUpdate) {
        const profile = parseMcpServerProfile(value);
        const existing = this.#database.prepare("SELECT secret_blob FROM mcp_server_profiles WHERE id = ?")
            .get(profile.id);
        const secretBlob = secretUpdate === undefined
            ? (existing?.secret_blob ?? null)
            : secretUpdate === null ? null : this.#encryptSecret("mcp", profile.id, normalizeApiKey(secretUpdate));
        const now = Date.now();
        this.#database.prepare(`INSERT INTO mcp_server_profiles (id, config_json, secret_blob, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json,
         secret_blob = excluded.secret_blob, updated_at = excluded.updated_at`).run(profile.id, JSON.stringify(profile), secretBlob, now, now);
        return { ...profile, hasSecret: secretBlob !== null };
    }
    deleteMcpServerProfile(id) {
        return this.#database.prepare("DELETE FROM mcp_server_profiles WHERE id = ?").run(id).changes === 1;
    }
    getMcpServerSecret(id) {
        const row = this.#database.prepare("SELECT secret_blob FROM mcp_server_profiles WHERE id = ?")
            .get(id);
        return row?.secret_blob ? this.#decryptSecret("mcp", id, row.secret_blob) : undefined;
    }
    listModelProfiles() {
        const rows = this.#database
            .prepare("SELECT id, config_json FROM model_profiles ORDER BY id")
            .all();
        return rows.map((row) => parseModelProfile(parseJson(row.config_json, `model ${row.id}`)));
    }
    getModelProfile(id) {
        const row = this.#database.prepare("SELECT id, config_json FROM model_profiles WHERE id = ?").get(id);
        return row ? parseModelProfile(parseJson(row.config_json, `model ${id}`)) : undefined;
    }
    saveModelProfile(value) {
        const profile = parseModelProfile(value);
        const now = Date.now();
        this.#database
            .prepare(`INSERT INTO model_profiles (id, config_json, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
            .run(profile.id, JSON.stringify(profile), now, now);
        return profile;
    }
    deleteModelProfile(id) {
        return this.#database.prepare("DELETE FROM model_profiles WHERE id = ?").run(id).changes === 1;
    }
    listPersonaProfiles() {
        const rows = this.#database
            .prepare("SELECT id, config_json FROM persona_profiles ORDER BY id")
            .all();
        return rows.map((row) => parsePersonaProfile(parseJson(row.config_json, `persona ${row.id}`)));
    }
    getPersonaProfile(id) {
        const row = this.#database.prepare("SELECT id, config_json FROM persona_profiles WHERE id = ?").get(id);
        return row ? parsePersonaProfile(parseJson(row.config_json, `persona ${id}`)) : undefined;
    }
    savePersonaProfile(value) {
        const profile = parsePersonaProfile(value);
        const now = Date.now();
        this.#database.prepare(`INSERT INTO persona_profiles (id, config_json, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`).run(profile.id, JSON.stringify(profile), now, now);
        return profile;
    }
    deletePersonaProfile(id) {
        return this.#database.prepare("DELETE FROM persona_profiles WHERE id = ?").run(id).changes === 1;
    }
    getConversationPersonaOverride(botId, conversationId) {
        const row = this.#database.prepare(`SELECT persona_profile_id FROM conversation_persona_overrides
       WHERE bot_id = ? AND conversation_id = ?`).get(normalizedKey(botId), normalizedKey(conversationId));
        return row?.persona_profile_id;
    }
    setConversationPersonaOverride(botId, conversationId, personaProfileId) {
        const normalizedBotId = normalizedKey(botId);
        const normalizedConversationId = normalizedKey(conversationId);
        if (!normalizedBotId || !normalizedConversationId)
            throw new Error("Conversation persona requires bot and conversation ids");
        if (!personaProfileId) {
            this.#database.prepare("DELETE FROM conversation_persona_overrides WHERE bot_id = ? AND conversation_id = ?").run(normalizedBotId, normalizedConversationId);
            return;
        }
        const normalizedPersonaId = normalizedKey(personaProfileId);
        if (!this.getPersonaProfile(normalizedPersonaId))
            throw new Error(`Persona ${normalizedPersonaId} does not exist`);
        this.#database.prepare(`INSERT INTO conversation_persona_overrides (bot_id, conversation_id, persona_profile_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bot_id, conversation_id) DO UPDATE SET
         persona_profile_id = excluded.persona_profile_id,
         updated_at = excluded.updated_at`).run(normalizedBotId, normalizedConversationId, normalizedPersonaId, Date.now());
    }
    getConversationVoiceMode(botId, conversationId) {
        const row = this.#database.prepare("SELECT mode FROM conversation_voice_modes WHERE bot_id = ? AND conversation_id = ?").get(normalizedKey(botId), normalizedKey(conversationId));
        return row?.mode ?? "text";
    }
    setConversationVoiceMode(botId, conversationId, mode) {
        const normalizedBotId = normalizedKey(botId);
        const normalizedConversationId = normalizedKey(conversationId);
        if (!normalizedBotId || !normalizedConversationId)
            throw new Error("Conversation voice mode requires bot and conversation ids");
        if (mode === "text") {
            this.#database.prepare("DELETE FROM conversation_voice_modes WHERE bot_id = ? AND conversation_id = ?").run(normalizedBotId, normalizedConversationId);
            return mode;
        }
        this.#database.prepare(`INSERT INTO conversation_voice_modes (bot_id, conversation_id, mode, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bot_id, conversation_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`).run(normalizedBotId, normalizedConversationId, mode, Date.now());
        return mode;
    }
    personaUsage(id) {
        const bots = this.listBots();
        const chatrooms = bots.flatMap((bot) => bot.chatroomModelOverrides
            .filter((override) => override.personaProfileId === id)
            .map((override) => ({ botId: bot.id, chatroomId: override.chatroomId })));
        const directConversations = this.#database.prepare(`SELECT bot_id, conversation_id FROM conversation_persona_overrides
       WHERE persona_profile_id = ? ORDER BY bot_id, conversation_id`).all(id);
        return {
            global: this.getGlobalSettings().defaultPersonaProfileId === id,
            botIds: [...new Set([
                    ...bots.filter((bot) => bot.personaProfileId === id || chatrooms.some((item) => item.botId === bot.id)).map((bot) => bot.id),
                    ...directConversations.map((item) => item.bot_id),
                ])],
            chatrooms,
            directConversations: directConversations.map((item) => ({
                botId: item.bot_id,
                conversationId: item.conversation_id,
            })),
        };
    }
    modelUsage(id) {
        const global = this.getGlobalSettings();
        return {
            global: global.defaultChatModelProfileId === id || global.defaultVisionModelProfileId === id,
            botIds: this.listBots()
                .filter((bot) => bot.chatModelProfileId === id ||
                bot.fastChatModelProfileId === id ||
                bot.participationJudgeModelProfileId === id ||
                bot.fallbackChatModelProfileIds.includes(id) ||
                bot.visionModelProfileId === id ||
                bot.chatroomModelOverrides.some((override) => override.chatModelProfileId === id || override.visionModelProfileId === id))
                .map((bot) => bot.id),
        };
    }
    listBots() {
        const rows = this.#database.prepare("SELECT id, config_json FROM bot_configs ORDER BY id").all();
        return rows.map((row) => parseBotConfig(parseJson(row.config_json, `bot ${row.id}`)));
    }
    getBot(id) {
        const row = this.#database.prepare("SELECT id, config_json FROM bot_configs WHERE id = ?").get(id);
        return row ? parseBotConfig(parseJson(row.config_json, `bot ${id}`)) : undefined;
    }
    saveBot(value) {
        const bot = parseBotConfig(value);
        const now = Date.now();
        this.#database
            .prepare(`INSERT INTO bot_configs (id, config_json, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`)
            .run(bot.id, JSON.stringify(bot), now, now);
        return bot;
    }
    deleteBot(id) {
        const normalizedId = normalizedKey(id);
        this.#database.prepare("DELETE FROM conversation_persona_overrides WHERE bot_id = ?").run(normalizedId);
        this.#database.prepare("DELETE FROM conversation_voice_modes WHERE bot_id = ?").run(normalizedId);
        return this.#database.prepare("DELETE FROM bot_configs WHERE id = ?").run(normalizedId).changes === 1;
    }
    listScheduledTasks(query = {}) {
        const clauses = [];
        const values = [];
        if (query.botId) {
            clauses.push("bot_id = ?");
            values.push(query.botId);
        }
        if (query.conversationId) {
            clauses.push("conversation_id = ?");
            values.push(query.conversationId);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.#database
            .prepare(`SELECT * FROM scheduled_tasks ${where} ORDER BY enabled DESC, next_run_at, created_at DESC`)
            .all(...values);
        return rows.map(toScheduledTask);
    }
    createScheduledTask(input) {
        const normalized = normalizeScheduledTaskInput(input);
        const now = Date.now();
        const nextRunAt = nextScheduledTaskRun(normalized.schedule, normalized.timezoneOffsetMinutes, now - 1);
        if (normalized.enabled && nextRunAt === null)
            throw new Error("Enabled task must have a future run time");
        const id = `task-${randomUUID()}`;
        this.#database.prepare(`INSERT INTO scheduled_tasks
       (id, bot_id, conversation_id, conversation_title, creator_id, creator_name, title, task_content,
        schedule_json, timezone_offset_minutes, enabled, next_run_at, locked_until, last_run_at,
        last_status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'never', NULL, ?, ?)`).run(id, normalized.botId, normalized.conversationId, normalized.conversationTitle ?? null, normalized.creatorId, normalized.creatorName, normalized.title, normalized.content, JSON.stringify(normalized.schedule), normalized.timezoneOffsetMinutes, normalized.enabled ? 1 : 0, nextRunAt, now, now);
        return this.#scheduledTask(id);
    }
    updateScheduledTask(id, input) {
        const existing = this.#scheduledTask(id);
        if (!existing)
            throw new Error(`Scheduled task ${id} does not exist`);
        const title = input.title === undefined ? existing.title : taskText(input.title, "title", 1, 120);
        const content = input.content === undefined ? existing.content : taskText(input.content, "content", 1, 4000);
        const schedule = input.schedule === undefined ? existing.schedule : validateScheduledTaskSchedule(input.schedule);
        const timezoneOffsetMinutes = input.timezoneOffsetMinutes === undefined
            ? existing.timezoneOffsetMinutes
            : boundedInteger(input.timezoneOffsetMinutes, -14 * 60, 14 * 60, "timezoneOffsetMinutes");
        const enabled = input.enabled ?? existing.enabled;
        const nextRunAt = nextScheduledTaskRun(schedule, timezoneOffsetMinutes, Date.now() - 1);
        if (enabled && nextRunAt === null)
            throw new Error("Enabled task must have a future run time");
        this.#database.prepare(`UPDATE scheduled_tasks SET title = ?, task_content = ?, schedule_json = ?, timezone_offset_minutes = ?,
       enabled = ?, next_run_at = ?, locked_until = NULL, updated_at = ? WHERE id = ?`).run(title, content, JSON.stringify(schedule), timezoneOffsetMinutes, enabled ? 1 : 0, nextRunAt, Date.now(), id);
        return this.#scheduledTask(id);
    }
    deleteScheduledTask(id) {
        return this.#database.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id).changes === 1;
    }
    assignScheduledTask(id, botId, conversationId, now = Date.now()) {
        if (!botId.trim() || !conversationId.trim())
            throw new Error("Scheduled task assignment is invalid");
        return this.#database.prepare(`UPDATE scheduled_tasks SET bot_id = ?, conversation_id = ?, updated_at = ?
       WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)`).run(botId, conversationId, now, id, now).changes === 1;
    }
    claimDueScheduledTasks(botId, now, limit = 10) {
        const boundedNow = boundedInteger(now, 1, Number.MAX_SAFE_INTEGER, "scheduled task claim time");
        const boundedLimit = boundedInteger(limit, 1, 100, "scheduled task claim limit");
        const claimed = [];
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const rows = this.#database.prepare(`SELECT * FROM scheduled_tasks
         WHERE bot_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           AND (locked_until IS NULL OR locked_until <= ?)
         ORDER BY next_run_at LIMIT ?`).all(botId, boundedNow, boundedNow, boundedLimit);
            for (const row of rows) {
                const changed = this.#database.prepare(`UPDATE scheduled_tasks SET locked_until = ?, last_status = 'running', last_error = NULL, updated_at = ?
           WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?)`).run(boundedNow + 10 * 60_000, boundedNow, row.id, boundedNow).changes;
                if (changed === 1)
                    claimed.push(toScheduledTask({ ...row, locked_until: boundedNow + 10 * 60_000, last_status: "running" }));
            }
            this.#database.exec("COMMIT");
            return claimed;
        }
        catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }
    completeScheduledTaskRun(id, scheduledFor, result) {
        const existing = this.#scheduledTask(id);
        if (!existing)
            throw new Error(`Scheduled task ${id} does not exist`);
        const completedAt = boundedInteger(result.completedAt, 1, Number.MAX_SAFE_INTEGER, "task completion time");
        boundedInteger(scheduledFor, 1, Number.MAX_SAFE_INTEGER, "scheduledFor");
        const retryExpired = !result.success && completedAt - scheduledFor >= 60 * 60_000;
        const nextRunAt = result.success
            ? nextScheduledTaskRun(existing.schedule, existing.timezoneOffsetMinutes, Math.max(completedAt, scheduledFor))
            : retryExpired
                ? nextScheduledTaskRun(existing.schedule, existing.timezoneOffsetMinutes, Math.max(completedAt, scheduledFor))
                : scheduledFor;
        const enabled = existing.schedule.type === "once" && (result.success || retryExpired)
            ? false
            : existing.enabled;
        this.#database.prepare(`UPDATE scheduled_tasks SET enabled = ?, next_run_at = ?, locked_until = ?, last_run_at = ?,
       last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(enabled ? 1 : 0, nextRunAt, result.success || retryExpired ? null : completedAt + 5 * 60_000, completedAt, result.success ? "succeeded" : "failed", result.success ? null : taskText(result.error ?? "任务执行失败", "error", 1, 1000), completedAt, id);
        return this.#scheduledTask(id);
    }
    getScheduledTaskDraft(botId, conversationId, creatorId, now = Date.now()) {
        this.#database.prepare("DELETE FROM scheduled_task_drafts WHERE expires_at <= ?").run(now);
        const row = this.#database.prepare(`SELECT * FROM scheduled_task_drafts WHERE bot_id = ? AND conversation_id = ? AND creator_id = ?`).get(botId, conversationId, creatorId);
        return row ? toScheduledTaskDraft(row) : undefined;
    }
    saveScheduledTaskDraft(input) {
        const stateJson = JSON.stringify(input.state);
        if (stateJson.length > 16_000)
            throw new Error("Scheduled task draft is too large");
        const now = Date.now();
        const expiresAt = boundedInteger(input.expiresAt, now + 1000, now + 24 * 60 * 60_000, "draft expiry");
        this.#database.prepare(`INSERT INTO scheduled_task_drafts
       (bot_id, conversation_id, creator_id, creator_name, state_json, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, conversation_id, creator_id) DO UPDATE SET
         creator_name = excluded.creator_name, state_json = excluded.state_json,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`).run(taskText(input.botId, "botId", 1, 128), taskText(input.conversationId, "conversationId", 1, 300), taskText(input.creatorId, "creatorId", 1, 300), taskText(input.creatorName, "creatorName", 1, 200), stateJson, expiresAt, now, now);
        return this.getScheduledTaskDraft(input.botId, input.conversationId, input.creatorId, now);
    }
    deleteScheduledTaskDraft(botId, conversationId, creatorId) {
        return this.#database.prepare("DELETE FROM scheduled_task_drafts WHERE bot_id = ? AND conversation_id = ? AND creator_id = ?").run(botId, conversationId, creatorId).changes === 1;
    }
    #scheduledTask(id) {
        const row = this.#database.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id);
        return row ? toScheduledTask(row) : undefined;
    }
    claimProactive(input) {
        const claimKey = input.claimKey.trim().slice(0, 500);
        const conversationId = input.canonicalConversationId.trim().slice(0, 300);
        const botId = input.botId.trim().slice(0, 128);
        const reason = input.reason.trim().slice(0, 128);
        if (!claimKey || !conversationId || !botId || !reason)
            throw new Error("Proactive claim fields cannot be empty");
        const createdAt = boundedInteger(input.createdAt, 1, Number.MAX_SAFE_INTEGER, "proactive claim time");
        const cooldownMs = boundedInteger(input.cooldownMs ?? 0, 0, 90 * 24 * 60 * 60_000, "proactive cooldown");
        const botCooldownMs = boundedInteger(input.botCooldownMs ?? 0, 0, 90 * 24 * 60 * 60_000, "bot proactive cooldown");
        const dailyLimit = boundedInteger(input.dailyLimit ?? 1_000_000, 0, 1_000_000, "proactive daily limit");
        const dayStartAt = boundedInteger(input.dayStartAt ?? 0, 0, createdAt, "proactive day start");
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            if (this.#database.prepare("SELECT 1 FROM proactive_claims WHERE claim_key = ?").get(claimKey)) {
                this.#database.exec("ROLLBACK");
                return false;
            }
            if (input.ambient && cooldownMs > 0) {
                const recent = this.#database
                    .prepare(`SELECT created_at FROM proactive_claims
             WHERE canonical_conversation_id = ? AND ambient = 1
             ORDER BY created_at DESC LIMIT 1`)
                    .get(conversationId);
                if (recent && createdAt - recent.created_at < cooldownMs) {
                    this.#database.exec("ROLLBACK");
                    return false;
                }
            }
            if (input.ambient && botCooldownMs > 0) {
                const recent = this.#database
                    .prepare(`SELECT created_at FROM proactive_claims
             WHERE bot_id = ? AND ambient = 1 ORDER BY created_at DESC LIMIT 1`)
                    .get(botId);
                if (recent && createdAt - recent.created_at < botCooldownMs) {
                    this.#database.exec("ROLLBACK");
                    return false;
                }
            }
            if (input.ambient) {
                const row = this.#database
                    .prepare("SELECT COUNT(*) AS count FROM proactive_claims WHERE bot_id = ? AND ambient = 1 AND created_at >= ?")
                    .get(botId, dayStartAt);
                if (row.count >= dailyLimit) {
                    this.#database.exec("ROLLBACK");
                    return false;
                }
            }
            this.#database
                .prepare(`INSERT INTO proactive_claims
             (claim_key, canonical_conversation_id, bot_id, reason, ambient, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`)
                .run(claimKey, conversationId, botId, reason, input.ambient ? 1 : 0, createdAt);
            this.#database.exec("COMMIT");
            return true;
        }
        catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }
    pruneProactiveClaims(before) {
        return Number(this.#database
            .prepare("DELETE FROM proactive_claims WHERE created_at < ?")
            .run(boundedInteger(before, 0, Number.MAX_SAFE_INTEGER, "proactive prune cutoff")).changes);
    }
    releaseProactiveClaim(claimKey, botId) {
        return this.#database
            .prepare("DELETE FROM proactive_claims WHERE claim_key = ? AND bot_id = ?")
            .run(claimKey, botId).changes === 1;
    }
    appendLog(input) {
        const message = input.message.trim().slice(0, 4000);
        if (!message)
            throw new Error("Log message cannot be empty");
        const event = input.event.trim().slice(0, 160);
        if (!event)
            throw new Error("Log event cannot be empty");
        const details = input.details ? safeDetails(input.details) : undefined;
        const createdAt = input.createdAt ?? Date.now();
        const result = this.#database
            .prepare(`INSERT INTO admin_logs (level, scope, bot_id, event, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(input.level, input.scope, input.botId ?? null, event, message, details ? JSON.stringify(details) : null, createdAt);
        return {
            id: Number(result.lastInsertRowid),
            level: input.level,
            scope: input.scope,
            event,
            message,
            createdAt,
            ...(input.botId ? { botId: input.botId } : {}),
            ...(details ? { details } : {}),
        };
    }
    listLogs(query = {}) {
        const limit = boundedInteger(query.limit ?? 100, 1, 500, "log limit");
        const clauses = [];
        const values = [];
        if (query.beforeId !== undefined) {
            clauses.push("id < ?");
            values.push(boundedInteger(query.beforeId, 1, Number.MAX_SAFE_INTEGER, "beforeId"));
        }
        if (query.level) {
            clauses.push("level = ?");
            values.push(query.level);
        }
        if (query.botId) {
            clauses.push("bot_id = ?");
            values.push(query.botId);
        }
        if (query.query?.trim()) {
            clauses.push("(message LIKE ? ESCAPE '\\' OR event LIKE ? ESCAPE '\\')");
            const pattern = `%${escapeLike(query.query.trim().slice(0, 200))}%`;
            values.push(pattern, pattern);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.#database
            .prepare(`SELECT id, level, scope, bot_id, event, message, details_json, created_at
         FROM admin_logs ${where} ORDER BY id DESC LIMIT ?`)
            .all(...values, limit);
        return rows.map(toLogRecord);
    }
    logCounts() {
        const result = { debug: 0, info: 0, warn: 0, error: 0 };
        const rows = this.#database
            .prepare("SELECT level, COUNT(*) AS count FROM admin_logs GROUP BY level")
            .all();
        for (const row of rows)
            result[row.level] = row.count;
        return result;
    }
    pruneLogs(settings = this.getGlobalSettings()) {
        const cutoff = Date.now() - settings.logRetentionDays * 24 * 60 * 60_000;
        const byAge = this.#database.prepare("DELETE FROM admin_logs WHERE created_at < ?").run(cutoff).changes;
        const byCount = this.#database
            .prepare(`DELETE FROM admin_logs WHERE id NOT IN (
           SELECT id FROM admin_logs ORDER BY id DESC LIMIT ?
         )`)
            .run(settings.maxLogRows).changes;
        return { deleted: Number(byAge) + Number(byCount) };
    }
    isGroupRoomInactive(botId, conversationId) {
        const bot = normalizedKey(botId);
        const room = normalizedGroupRoomId(conversationId);
        const row = this.#database.prepare("SELECT inactive FROM group_room_availability WHERE bot_id = ? AND conversation_id = ?").get(bot, room);
        return row?.inactive === 1;
    }
    getGroupRoomAvailability(botId, conversationId) {
        const bot = normalizedKey(botId);
        const room = normalizedGroupRoomId(conversationId);
        const row = this.#database.prepare(`SELECT consecutive_unavailable, inactive, reason, updated_at
       FROM group_room_availability WHERE bot_id = ? AND conversation_id = ?`).get(bot, room);
        if (!row)
            return undefined;
        return {
            consecutiveUnavailable: Number(row.consecutive_unavailable),
            inactive: row.inactive === 1,
            ...(typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
            updatedAt: Number(row.updated_at),
        };
    }
    markGroupRoomAvailable(botId, conversationId) {
        const bot = normalizedKey(botId);
        const room = normalizedGroupRoomId(conversationId);
        const existing = this.#database.prepare("SELECT inactive FROM group_room_availability WHERE bot_id = ? AND conversation_id = ?").get(bot, room);
        if (!existing)
            return false;
        this.#database.prepare("DELETE FROM group_room_availability WHERE bot_id = ? AND conversation_id = ?").run(bot, room);
        return existing.inactive === 1;
    }
    noteGroupRoomUnavailable(botId, conversationId, reason, confirmed = false, observedAt = Date.now()) {
        const bot = normalizedKey(botId);
        const room = normalizedGroupRoomId(conversationId);
        const normalizedReason = normalizedKey(reason).slice(0, 200);
        if (!normalizedReason)
            throw new Error("Group room unavailability reason cannot be empty");
        if (!Number.isSafeInteger(observedAt) || observedAt <= 0)
            throw new Error("Group room observation time is invalid");
        const existing = this.#database.prepare(`SELECT consecutive_unavailable, inactive FROM group_room_availability
       WHERE bot_id = ? AND conversation_id = ?`).get(bot, room);
        const consecutive = confirmed
            ? Math.max(2, existing?.consecutive_unavailable ?? 0)
            : Math.min(1000, (existing?.consecutive_unavailable ?? 0) + 1);
        const inactive = confirmed || existing?.inactive === 1 || consecutive >= 2;
        this.#database.prepare(`INSERT INTO group_room_availability (
         bot_id, conversation_id, consecutive_unavailable, inactive, reason, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, conversation_id) DO UPDATE SET
         consecutive_unavailable = excluded.consecutive_unavailable,
         inactive = excluded.inactive,
         reason = excluded.reason,
         updated_at = excluded.updated_at`).run(bot, room, consecutive, inactive ? 1 : 0, normalizedReason, observedAt);
        return { consecutive, inactive };
    }
    deleteGroupMemberSnapshots(conversationId) {
        const result = this.#database.prepare("DELETE FROM group_member_snapshots WHERE conversation_id = ?").run(normalizedGroupRoomId(conversationId));
        return Number(result.changes);
    }
    /**
     * Reconciles a channel-provided group-member snapshot and returns visible name
     * and presence changes relative to the preceding complete snapshot.
     * The first complete snapshot is deliberately a silent baseline.
     */
    syncGroupMemberSnapshots(conversationId, members, observedAt = Date.now()) {
        const roomId = conversationId.normalize("NFKC").trim().toLocaleLowerCase();
        if (!roomId || /\s|[\u0000-\u001f]/u.test(roomId)) {
            throw new Error("Group member snapshot conversationId must be a non-empty conversation id");
        }
        if (!Number.isSafeInteger(observedAt) || observedAt <= 0)
            throw new Error("Group member snapshot time is invalid");
        if (members.length === 0 || members.length > 1000)
            throw new Error("Group member snapshot must contain 1 to 1000 members");
        const current = new Map();
        for (const member of members) {
            const id = normalizedSnapshotText(member.id, 300);
            if (!id)
                continue;
            const nickname = normalizedSnapshotText(member.nickname, 200);
            const displayName = normalizedSnapshotText(member.displayName, 200);
            current.set(id, { nickname, displayName });
        }
        if (current.size === 0)
            throw new Error("Group member snapshot contains no valid members");
        const existingRows = this.#database
            .prepare(`SELECT member_id, nickname, display_name, active
         FROM group_member_snapshots WHERE conversation_id = ?`)
            .all(roomId);
        const existing = new Map(existingRows.map((row) => [row.member_id, row]));
        const initialized = existingRows.length === 0;
        const changes = [];
        const joined = [];
        const left = [];
        if (!initialized) {
            for (const [id, member] of current) {
                const old = existing.get(id);
                if (!old || old.active !== 1)
                    joined.push({ id, name: member.displayName || member.nickname || id });
            }
            for (const old of existingRows) {
                if (old.active === 1 && !current.has(old.member_id)) {
                    left.push({ id: old.member_id, name: old.display_name || old.nickname || old.member_id });
                }
            }
        }
        this.#transaction(() => {
            const upsert = this.#database.prepare(`INSERT INTO group_member_snapshots (
           conversation_id, member_id, nickname, display_name, active, first_observed_at, last_observed_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(conversation_id, member_id) DO UPDATE SET
           nickname = excluded.nickname,
           display_name = excluded.display_name,
           active = 1,
           last_observed_at = excluded.last_observed_at`);
            for (const [id, member] of current) {
                const old = existing.get(id);
                if (!initialized && old?.active === 1) {
                    const oldName = old.display_name || old.nickname || id;
                    const newName = member.displayName || member.nickname || id;
                    if (oldName !== newName)
                        changes.push({ id, oldName, newName });
                }
                upsert.run(roomId, id, member.nickname, member.displayName, observedAt, observedAt);
            }
            const activeIds = [...current.keys()];
            const placeholders = activeIds.map(() => "?").join(",");
            this.#database.prepare(`UPDATE group_member_snapshots SET active = 0, last_observed_at = ?
         WHERE conversation_id = ? AND active = 1 AND member_id NOT IN (${placeholders})`).run(observedAt, roomId, ...activeIds);
        });
        return { initialized, changes, joined, left };
    }
    listEmojis(botId) {
        const rows = (botId
            ? this.#database.prepare("SELECT * FROM emojis WHERE bot_id = ? ORDER BY is_thinking DESC, updated_at DESC").all(botId)
            : this.#database.prepare("SELECT * FROM emojis ORDER BY is_thinking DESC, updated_at DESC").all());
        return rows.map(toEmojiRecord);
    }
    getEmoji(id) {
        const row = this.#database.prepare("SELECT * FROM emojis WHERE id = ?").get(id);
        return row ? toEmojiRecord(row) : undefined;
    }
    findEmojiByHash(botId, sha256) {
        const row = this.#database.prepare("SELECT * FROM emojis WHERE bot_id = ? AND sha256 = ?").get(botId, sha256);
        return row ? toEmojiRecord(row) : undefined;
    }
    saveCollectedEmoji(input) {
        const existingRow = this.#database.prepare("SELECT * FROM emojis WHERE sha256 = ? ORDER BY updated_at DESC LIMIT 1").get(input.sha256);
        const existing = existingRow ? toEmojiRecord(existingRow) : undefined;
        if (existing)
            return { emoji: existing, created: false };
        const now = Date.now();
        const id = randomUUID();
        this.#database.prepare(`INSERT INTO emojis (
        id, bot_id, asset_json, sha256, description, status, enabled, is_thinking,
        source_conversation_id, source_sender_id, source_message_id, use_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'analyzing', 1, 0, ?, ?, ?, 0, ?, ?)`).run(id, input.botId, JSON.stringify(input.asset), input.sha256, input.description?.trim() || "等待视觉模型识别", input.sourceConversationId ?? null, input.sourceSenderId ?? null, input.sourceMessageId ?? null, now, now);
        return { emoji: this.getEmoji(id), created: true };
    }
    completeEmojiAnalysis(id, description) {
        const normalized = emojiDescription(description);
        const result = this.#database.prepare("UPDATE emojis SET description = ?, status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(normalized, Date.now(), id);
        if (result.changes === 0)
            throw new Error(`Emoji ${id} does not exist`);
        return this.getEmoji(id);
    }
    failEmojiAnalysis(id, error) {
        const normalized = error.normalize("NFKC").trim().slice(0, 1000) || "视觉识别失败";
        const result = this.#database.prepare("UPDATE emojis SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(normalized, Date.now(), id);
        if (result.changes === 0)
            throw new Error(`Emoji ${id} does not exist`);
        return this.getEmoji(id);
    }
    updateEmoji(id, input) {
        const existing = this.getEmoji(id);
        if (!existing)
            throw new Error(`Emoji ${id} does not exist`);
        const description = input.description === undefined ? existing.description : emojiDescription(input.description);
        const enabled = input.enabled ?? existing.enabled;
        const isThinking = input.isThinking ?? existing.isThinking;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            if (isThinking)
                this.#database.prepare("UPDATE emojis SET is_thinking = 0, updated_at = ? WHERE bot_id = ? AND id <> ?").run(Date.now(), existing.botId, id);
            this.#database.prepare("UPDATE emojis SET description = ?, enabled = ?, is_thinking = ?, status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(description, enabled ? 1 : 0, isThinking ? 1 : 0, Date.now(), id);
            this.#database.exec("COMMIT");
        }
        catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
        return this.getEmoji(id);
    }
    updateEmojiAsset(id, asset) {
        const existing = this.getEmoji(id);
        if (!existing)
            throw new Error(`Emoji ${id} does not exist`);
        if (!asset.id.trim() || !asset.locator.trim())
            throw new Error("Emoji asset is invalid");
        this.#database.prepare("UPDATE emojis SET asset_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(asset), Date.now(), id);
        return this.getEmoji(id);
    }
    markEmojiUsed(id) {
        this.#database.prepare("UPDATE emojis SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), id);
    }
    thinkingEmoji(botId) {
        const row = this.#database.prepare("SELECT * FROM emojis WHERE bot_id = ? AND is_thinking = 1 AND enabled = 1 AND status = 'ready'").get(botId);
        return row ? toEmojiRecord(row) : undefined;
    }
    deleteEmoji(id) {
        return this.#database.prepare("DELETE FROM emojis WHERE id = ?").run(id).changes > 0;
    }
    #providerSummary(row) {
        const profile = parseProviderProfile(parseJson(row.config_json, `provider ${row.id}`));
        return { ...profile, hasApiKey: row.secret_blob !== null };
    }
    #knowledgeProviderSummary(row) {
        const profile = parseKnowledgeProviderProfile(parseJson(row.config_json, `knowledge provider ${row.id}`));
        return { ...profile, hasApiKey: row.secret_blob !== null };
    }
    #mcpServerSummary(row) {
        const profile = parseMcpServerProfile(parseJson(row.config_json, `MCP server ${row.id}`));
        return { ...profile, hasSecret: row.secret_blob !== null };
    }
    #encryptApiKey(id, apiKey) {
        return this.#encryptSecret("provider", id, apiKey);
    }
    #encryptSecret(namespace, id, apiKey) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.#secretKey, iv);
        cipher.setAAD(Buffer.from(`pi-wechat-${namespace}:${id}`, "utf8"));
        const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
    }
    #decryptApiKey(id, payload) {
        return this.#decryptSecret("provider", id, payload);
    }
    #decryptSecret(namespace, id, payload) {
        const [version, ivValue, tagValue, encryptedValue, extra] = payload.split(".");
        if (version !== "v1" || !ivValue || !tagValue || !encryptedValue || extra !== undefined) {
            throw new Error(`Stored API key for provider ${id} has an invalid format`);
        }
        try {
            const decipher = createDecipheriv("aes-256-gcm", this.#secretKey, Buffer.from(ivValue, "base64url"));
            decipher.setAAD(Buffer.from(`pi-wechat-${namespace}:${id}`, "utf8"));
            decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
            return Buffer.concat([
                decipher.update(Buffer.from(encryptedValue, "base64url")),
                decipher.final(),
            ]).toString("utf8");
        }
        catch {
            throw new Error(`Stored API key for provider ${id} cannot be decrypted`);
        }
    }
    #migrateLegacyModelProfiles() {
        const rows = this.#database
            .prepare("SELECT id, config_json FROM model_profiles ORDER BY id")
            .all();
        for (const row of rows) {
            const value = parseJson(row.config_json, `legacy model ${row.id}`);
            if (!isRecord(value) || typeof value.providerProfileId === "string")
                continue;
            if (typeof value.provider !== "string" || typeof value.apiKeyEnv !== "string") {
                throw new Error(`Stored model ${row.id} cannot be migrated to a provider profile`);
            }
            const providerProfileId = this.#availableLegacyProviderId(row.id);
            const provider = parseProviderProfile({
                id: providerProfileId,
                label: `${typeof value.label === "string" ? value.label : row.id} Provider`,
                provider: value.provider,
                api: legacyProviderApi(value.api, value.provider),
                apiKeyEnv: value.apiKeyEnv,
                baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : legacyProviderBaseUrl(value.provider),
                enabled: value.enabled ?? true,
            });
            this.saveProviderProfile(provider);
            const model = parseModelProfile({
                id: value.id,
                label: value.label,
                providerProfileId,
                modelId: value.modelId,
                ...(Array.isArray(value.input) ? { input: value.input } : {}),
                ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
                ...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
                ...(typeof value.maxTokens === "number" ? { maxTokens: value.maxTokens } : {}),
                thinkingLevel: value.thinkingLevel,
                maxRetryDelayMs: value.maxRetryDelayMs,
                enabled: value.enabled,
            });
            this.#database
                .prepare("UPDATE model_profiles SET config_json = ?, updated_at = ? WHERE id = ?")
                .run(JSON.stringify(model), Date.now(), row.id);
        }
    }
    #deduplicateEmojisByHash() {
        const hashes = this.#database.prepare("SELECT sha256 FROM emojis GROUP BY sha256 HAVING COUNT(*) > 1").all();
        if (hashes.length === 0)
            return;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            for (const { sha256 } of hashes) {
                const rows = this.#database.prepare(`SELECT * FROM emojis WHERE sha256 = ?
           ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'analyzing' THEN 1 ELSE 2 END,
                    enabled DESC, updated_at DESC`).all(sha256);
                const keeper = rows[0];
                if (!keeper)
                    continue;
                const useCount = rows.reduce((total, row) => total + row.use_count, 0);
                const lastUsedAt = rows.reduce((latest, row) => Math.max(latest, row.last_used_at ?? 0), 0);
                const createdAt = rows.reduce((earliest, row) => Math.min(earliest, row.created_at), keeper.created_at);
                this.#database.prepare(`UPDATE emojis
           SET use_count = ?, last_used_at = ?, created_at = ?, enabled = ?, updated_at = ?
           WHERE id = ?`).run(useCount, lastUsedAt || null, createdAt, rows.some((row) => row.enabled === 1) ? 1 : 0, Date.now(), keeper.id);
                this.#database.prepare(`DELETE FROM emojis WHERE sha256 = ? AND id <> ?`).run(sha256, keeper.id);
            }
            this.#database.exec("CREATE INDEX IF NOT EXISTS emojis_hash_idx ON emojis(sha256)");
            this.#database.exec("COMMIT");
        }
        catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }
    #availableLegacyProviderId(modelId) {
        if (!this.#database.prepare("SELECT 1 FROM provider_profiles WHERE id = ?").get(modelId))
            return modelId;
        for (let suffix = 2; suffix < 10_000; suffix += 1) {
            const suffixText = `-${suffix}`;
            const candidate = `${modelId.slice(0, 64 - suffixText.length)}${suffixText}`;
            if (!this.#database.prepare("SELECT 1 FROM provider_profiles WHERE id = ?").get(candidate))
                return candidate;
        }
        throw new Error(`Cannot allocate provider profile id for legacy model ${modelId}`);
    }
    #transaction(operation) {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            this.#database.exec("COMMIT");
            return result;
        }
        catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }
}
function legacyProviderApi(value, provider) {
    if (typeof value === "string" && value)
        return value;
    if (provider === "anthropic")
        return "anthropic-messages";
    if (provider === "google")
        return "google-generative-ai";
    return "openai-completions";
}
function legacyProviderBaseUrl(provider) {
    if (provider === "anthropic")
        return "https://api.anthropic.com";
    if (provider === "google")
        return "https://generativelanguage.googleapis.com/v1beta";
    if (provider === "xai")
        return "https://api.x.ai/v1";
    if (provider === "openrouter")
        return "https://openrouter.ai/api/v1";
    if (provider === "openai")
        return "https://api.openai.com/v1";
    throw new Error(`Legacy provider ${String(provider)} requires an explicit Base URL`);
}
function toLogRecord(row) {
    const details = row.details_json
        ? parseJson(row.details_json, `log details ${row.id}`)
        : undefined;
    return {
        id: row.id,
        level: row.level,
        scope: row.scope,
        event: row.event,
        message: row.message,
        createdAt: row.created_at,
        ...(row.bot_id ? { botId: row.bot_id } : {}),
        ...(details ? { details } : {}),
    };
}
function toEmojiRecord(row) {
    const asset = parseJson(row.asset_json, `emoji ${row.id} asset`);
    return {
        id: row.id,
        botId: row.bot_id,
        asset,
        sha256: row.sha256,
        description: row.description,
        status: row.status,
        enabled: row.enabled === 1,
        isThinking: row.is_thinking === 1,
        useCount: row.use_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.source_conversation_id ? { sourceConversationId: row.source_conversation_id } : {}),
        ...(row.source_sender_id ? { sourceSenderId: row.source_sender_id } : {}),
        ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
        ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
        ...(row.error ? { error: row.error } : {}),
    };
}
function emojiDescription(value) {
    if (typeof value !== "string")
        throw new Error("Emoji description must be a string");
    const normalized = value.normalize("NFKC").trim();
    if (!normalized || [...normalized].length > 500) {
        throw new Error("Emoji description must contain between 1 and 500 characters");
    }
    return normalized;
}
function normalizeScheduledTaskInput(input) {
    const schedule = validateScheduledTaskSchedule(input.schedule);
    return {
        botId: taskText(input.botId, "botId", 1, 128),
        conversationId: taskText(input.conversationId, "conversationId", 1, 300),
        ...(input.conversationTitle
            ? { conversationTitle: taskText(input.conversationTitle, "conversationTitle", 1, 200) }
            : {}),
        creatorId: taskText(input.creatorId, "creatorId", 1, 300),
        creatorName: taskText(input.creatorName, "creatorName", 1, 200),
        title: taskText(input.title, "title", 1, 120),
        content: taskText(input.content, "content", 1, 4000),
        schedule,
        timezoneOffsetMinutes: boundedInteger(input.timezoneOffsetMinutes, -14 * 60, 14 * 60, "timezoneOffsetMinutes"),
        enabled: input.enabled !== false,
    };
}
function toScheduledTask(row) {
    const schedule = validateScheduledTaskSchedule(parseJson(row.schedule_json, `scheduled task ${row.id} schedule`));
    const lastStatus = ["never", "running", "succeeded", "failed"].includes(row.last_status)
        ? row.last_status
        : "failed";
    return {
        id: row.id,
        botId: row.bot_id,
        conversationId: row.conversation_id,
        ...(row.conversation_title ? { conversationTitle: row.conversation_title } : {}),
        creatorId: row.creator_id,
        creatorName: row.creator_name,
        title: row.title,
        content: row.task_content,
        schedule,
        timezoneOffsetMinutes: row.timezone_offset_minutes,
        enabled: row.enabled === 1,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastStatus,
        ...(row.last_error ? { lastError: row.last_error } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function toScheduledTaskDraft(row) {
    const value = parseJson(row.state_json, "scheduled task draft state");
    return {
        botId: row.bot_id,
        conversationId: row.conversation_id,
        creatorId: row.creator_id,
        creatorName: row.creator_name,
        state: isRecord(value) ? value : {},
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function taskText(value, name, min, max) {
    if (typeof value !== "string")
        throw new Error(`${name} must be a string`);
    const normalized = value.normalize("NFKC").trim();
    const length = [...normalized].length;
    if (length < min || length > max)
        throw new Error(`${name} must contain between ${min} and ${max} characters`);
    return normalized;
}
function normalizedControlId(value, name) {
    const normalized = taskText(value, name, 1, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(normalized))
        throw new Error(`${name} is invalid`);
    return normalized;
}
function decimalControlId(value, name) {
    const normalized = taskText(value, name, 1, 30);
    if (!/^\d+$/u.test(normalized))
        throw new Error(`${name} must be a decimal string`);
    return normalized;
}
function controlInteger(value, name, min, max) {
    if (typeof value !== "number")
        throw new Error(`${name} must be a number`);
    return boundedInteger(value, min, max, name);
}
function safeDetails(value) {
    const serialized = JSON.stringify(value);
    if (serialized.length > 16_000)
        return { truncated: serialized.slice(0, 15_999) + "…" };
    return JSON.parse(serialized);
}
function parseJson(value, name) {
    try {
        return JSON.parse(value);
    }
    catch {
        throw new Error(`Stored ${name} contains invalid JSON`);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeApiKey(value) {
    if (typeof value !== "string")
        throw new Error("apiKey must be a string");
    const normalized = value.trim();
    if (normalized.length < 1 || normalized.length > 10_000) {
        throw new Error("apiKey must contain between 1 and 10000 characters");
    }
    return normalized;
}
function normalizedKey(value) {
    if (typeof value !== "string")
        throw new Error("Key must be a string");
    return value.normalize("NFKC").trim();
}
function normalizedSnapshotText(value, max) {
    if (value === undefined)
        return null;
    if (typeof value !== "string")
        throw new Error("Group member snapshot text must be a string");
    const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (!normalized)
        return null;
    if ([...normalized].length > max)
        throw new Error(`Group member snapshot text exceeds ${max} characters`);
    return normalized;
}
function normalizedGroupRoomId(value) {
    const room = normalizedKey(value).toLocaleLowerCase();
    if (!room || /\s|[\u0000-\u001f]/u.test(room)) {
        throw new Error("Group room id must be a non-empty conversation id");
    }
    return room;
}
function boundedInteger(value, min, max, name) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}
function escapeLike(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
//# sourceMappingURL=admin-store.js.map
