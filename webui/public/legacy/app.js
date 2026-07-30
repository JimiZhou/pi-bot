"use strict";

const DEFAULT_LIMITS = {
  historyLimit: 50,
  maxHistoryChars: 12000,
  memoryLimit: 12,
  behaviorLimit: 12,
  continuationWindowMs: 300000,
  messageBurstDebounceMs: 8000,
  explicitMessageBurstDebounceMs: 900,
  maxAgentLlmCalls: 6,
  maxAgentToolCalls: 8,
  agentTimeoutMs: 120000,
  maxReplyChars: 2000,
  maxImageUnderstandingCalls: 2,
  maxImageBytes: 10485760,
  maxImageEvidenceChars: 4000,
  imageUnderstandingTimeoutMs: 45000,
  imageContextMessageLimit: 8,
  imageContextWindowMs: 600000,
  maxAvailableImagesPerTurn: 4,
};

const DEFAULT_SOCIAL_SCHEDULE = {
  enabled: false,
  timezoneOffsetMinutes: 480,
  activeStartMinute: 420,
  activeEndMinute: 1380,
  hotChatWindowMs: 180000,
  hotChatMinMessages: 10,
  hotChatMinParticipants: 4,
  hotChatCooldownMs: 1800000,
  coldChatAfterMs: 14400000,
  coldChatCooldownMs: 86400000,
  maxDailyAmbientMessages: 3,
  goodnightEnabled: true,
  goodnightMinute: 1380,
  activeGroupMinMessages: 5,
};

const DEFAULT_MORNING_BRIEF_PLUGIN = {
  id: "morning-brief",
  type: "morning-brief",
  enabled: false,
  settings: {
    minute: 435,
    activeGroupMinMessages: 5,
    newsSourceUrl: "https://api.suxun.site/api/sixs?type=json",
  },
};

const DEFAULT_PAT_REPLY_PLUGIN = {
  id: "pat-reply",
  type: "pat-reply",
  enabled: false,
  settings: {
    replies: ["拍我干嘛～"],
    groupOnly: true,
  },
};

const DEFAULT_GROUP_SUMMARY_PLUGIN = {
  id: "group-summary",
  type: "group-summary",
  enabled: false,
  settings: {
    scheduledEnabled: true,
    onDemandEnabled: true,
    minute: 1200,
    activeGroupMinMessages: 5,
    maxTranscriptChars: 12000,
  },
};

const DEFAULT_SCHEDULED_TASK_PLUGIN = {
  id: "scheduled-task",
  type: "scheduled-task",
  enabled: false,
  settings: {
    draftTimeoutMinutes: 30,
    maxTasksPerGroup: 20,
    dueBatchSize: 10,
  },
};

const DEFAULT_AUTO_PARTICIPATION_PLUGIN = {
  id: "auto-participation",
  type: "auto-participation",
  enabled: false,
  settings: {},
};

const DEFAULT_COLD_CHAT_WARMUP_PLUGIN = {
  id: "cold-chat-warmup",
  type: "cold-chat-warmup",
  enabled: false,
  settings: {},
};

const DEFAULT_RED_ENVELOPE_PLUGIN = {
  id: "red-envelope-notify",
  type: "red-envelope-notify",
  enabled: false,
  settings: {},
};

const DEFAULT_REPEATER_PLUGIN = {
  id: "repeater",
  type: "repeater",
  enabled: false,
  settings: {
    cooldownMinutes: 8,
  },
};

const DEFAULT_MAGNET_CODE_SEARCH_PLUGIN = {
  id: "magnet-code-search",
  type: "magnet-code-search",
  enabled: false,
  settings: {
    timeoutSeconds: 8,
    maxResults: 1,
  },
};

const CHATROOM_PLUGIN_TYPES = [
  ["auto-participation", "自动接话"],
  ["cold-chat-warmup", "冷群暖场"],
  ["morning-brief", "晨报"],
  ["pat-reply", "拍一拍"],
  ["group-summary", "群聊总结"],
  ["scheduled-task", "定时任务"],
  ["red-envelope-notify", "红包提醒"],
  ["repeater", "复读机"],
  ["magnet-code-search", "编号磁力搜索"],
];

const state = {
  token: localStorage.getItem("pi-admin-token") || "",
  settings: null,
  providerProfiles: [],
  knowledgeProviders: [],
  mcpServers: [],
  models: [],
  personas: [],
  bots: [],
  status: null,
  currentView: "overview",
  logs: [],
  logsHasMore: false,
  editingProvider: null,
  editingKnowledgeProvider: null,
  editingMcpServer: null,
  editingModel: null,
  editingBot: null,
  editingPersona: null,
  discoveredModels: new Map(),
  currentModelCatalog: [],
  timer: null,
  ipadLoginBot: null,
  ipadLoginStatus: null,
  ipadLoginTimer: null,
  ipadLoginSynced: false,
  participationCases: [],
  participationSummary: null,
  qualitySummaries: {},
  pluginCatalog: [],
  scheduledTasks: [],
  chatrooms: [],
  currentChatroom: null,
  chatroomMessages: [],
  chatroomHasMore: false,
  chatroomMemories: [],
  chatroomMembers: [],
  chatroomMemoryAudit: [],
  chatroomHistoryLoaded: false,
  chatroomHistoryTimer: null,
  chatroomHistoryPolling: false,
  selectedChatrooms: new Set(),
  tts: {
    voices: ["Leda"],
    presets: [],
    defaultVoice: "Leda",
    defaultStyle: "年轻、愉悦、自然、有亲和力、感情丰富但不过度夸张的女性语气",
  },
  emojis: [],
  emojiPreviewUrls: new Map(),
  selectedChatroomEmojiId: null,
  personaAvatarDataUrl: null,
  wechatProfile: null,
  wechatCapabilities: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(themeSetting());
  bindUi();
  restoreViewFromHash();
  if (state.token) void boot();
  else showLogin();
});

const THEME_KEY = "pi-theme";
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_LABELS = { auto: "主题：跟随系统", light: "主题：浅色", dark: "主题：深色" };

function themeSetting() {
  const stored = localStorage.getItem(THEME_KEY);
  return THEME_ORDER.includes(stored) ? stored : "auto";
}

function applyTheme(setting) {
  const dark = setting === "dark" || (setting !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const label = $("#theme-toggle-label");
  if (label) label.textContent = THEME_LABELS[setting];
  const toggle = $("#theme-toggle");
  if (toggle) toggle.title = `切换配色主题（当前：${THEME_LABELS[setting].slice(3)}）`;
}

function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(themeSetting()) + 1) % THEME_ORDER.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function knownViews() {
  return $$(".nav[data-view]").map((button) => button.dataset.view);
}

function restoreViewFromHash() {
  const view = location.hash.slice(1) || "overview";
  if (view !== state.currentView && knownViews().includes(view)) switchView(view);
}

function confirmDialog({ title = "确认操作", body = "", danger = false, confirmText = "确认" } = {}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = body;
  const ok = $("#confirm-ok");
  ok.textContent = confirmText;
  ok.className = danger ? "danger-solid" : "primary";
  dialog.returnValue = "";
  dialog.showModal();
  ok.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

function setButtonBusy(button, busy) {
  if (!button) return;
  if (busy) {
    if (button.dataset.busy) return;
    button.dataset.busy = "1";
    button.disabled = true;
    button.prepend(node("span", "spinner btn-spinner"));
    return;
  }
  delete button.dataset.busy;
  button.disabled = false;
  button.querySelector(".btn-spinner")?.remove();
}

async function withBusy(button, task) {
  setButtonBusy(button, true);
  try { return await task(); }
  finally { setButtonBusy(button, false); }
}

function loadingBlock(message = "正在加载……") {
  return node("div", "empty loading", [node("span", "spinner"), node("span", "", message)]);
}

function bindUi() {
  $$(".nav[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#login-form").addEventListener("submit", login);
  $("#logout").addEventListener("click", logout);
  $("#refresh-all").addEventListener("click", () => void refreshAll());
  $("#add-provider").addEventListener("click", () => openProviderForm());
  $("#add-model").addEventListener("click", () => void openModelForm());
  $("#add-knowledge-provider").addEventListener("click", () => openKnowledgeProviderForm());
  $("#add-mcp-server").addEventListener("click", () => openMcpServerForm());
  $("#add-bot").addEventListener("click", () => openBotForm());
  $("#add-persona").addEventListener("click", () => openPersonaForm());
  $("#provider-form").addEventListener("submit", saveProvider);
  $("#provider-probe").addEventListener("click", () => void probeProviderForm());
  $("#provider-form [name=provider]").addEventListener("change", applyProviderDefaults);
  $("#knowledge-provider-form").addEventListener("submit", saveKnowledgeProvider);
  $("#knowledge-provider-probe").addEventListener("click", () => void probeKnowledgeProviderForm());
  $("#knowledge-provider-form [name=kind]").addEventListener("change", applyKnowledgeProviderDefaults);
  $("#mcp-server-form").addEventListener("submit", saveMcpServer);
  $("#mcp-server-probe").addEventListener("click", () => void probeMcpServerForm());
  $("#mcp-server-form [name=authType]").addEventListener("change", applyMcpAuthDefaults);
  $("#model-form").addEventListener("submit", saveModel);
  $("#model-text-test").addEventListener("click", () => void testModelForm(false));
  $("#model-image-test").addEventListener("click", () => void testModelForm(true));
  $("#bot-form").addEventListener("submit", saveBot);
  $("#persona-form").addEventListener("submit", savePersona);
  $("#persona-form [name=avatarFile]").addEventListener("change", previewPersonaAvatar);
  $("#refresh-wechat-identity").addEventListener("click", () => void loadWechatIdentity());
  $("#wechat-identity-bot").addEventListener("change", () => void loadWechatIdentity());
  $("#wechat-profile-form").addEventListener("submit", saveWechatProfile);
  $("#wechat-avatar-file").addEventListener("change", previewWechatAvatar);
  $("#wechat-avatar-upload").addEventListener("click", () => void uploadWechatAvatar());
  $("#wechat-qrcode-load").addEventListener("click", () => void loadWechatQrCode());
  $("#refresh-contacts").addEventListener("click", () => void loadContacts());
  $("#contacts-bot").addEventListener("change", () => void loadContacts());
  $("#contact-search-form").addEventListener("submit", searchContact);
  $("#contact-remark-save").addEventListener("click", () => void saveContactRemark());
  $$("[data-label-action]").forEach((button) => button.addEventListener("click", () => void runLabelAction(button.dataset.labelAction)));
  $("#refresh-moments").addEventListener("click", () => void loadMoments());
  $("#moments-bot").addEventListener("change", () => void loadMoments());
  $("#moment-publish-form").addEventListener("submit", publishMoment);
  $("#moment-automation-form").addEventListener("submit", saveMomentAutomation);
  $$("[data-moment-action]").forEach((button) => button.addEventListener("click", () => void runMomentAction(button.dataset.momentAction)));
  $("#bot-form [name=channelType]").addEventListener("change", toggleBotChannelFields);
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#prune-logs").addEventListener("click", pruneLogs);
  $("#refresh-logs").addEventListener("click", () => void refreshLogs());
  $("#log-level").addEventListener("change", () => void refreshLogs());
  $("#log-bot").addEventListener("change", () => void refreshLogs());
  $("#model-form [name=providerProfileId]").addEventListener("change", loadModelCatalog);
  $("#model-form [name=modelId]").addEventListener("input", applyDiscoveredModelDefaults);
  $("#refresh-chatrooms").addEventListener("click", () => void refreshChatrooms());
  $("#refresh-emojis").addEventListener("click", () => void refreshEmojis());
  $("#emoji-bot-filter").addEventListener("change", renderEmojis);
  $("#emoji-search").addEventListener("input", renderEmojis);
  $("#chatroom-bot-filter").addEventListener("change", renderChatrooms);
  $("#chatroom-search").addEventListener("input", renderChatrooms);
  $("#chatroom-bulk-form").addEventListener("submit", saveChatroomBulkChanges);
  $("#chatroom-bulk-reset-context").addEventListener("click", () => void resetSelectedChatroomContexts());
  $("#chatroom-clear-selection").addEventListener("click", () => {
    state.selectedChatrooms.clear();
    renderChatrooms();
  });
  $$(".chatroom-tab").forEach((button) => button.addEventListener("click", () => void switchChatroomTab(button.dataset.chatroomTab)));
  $("#chatroom-load-earlier").addEventListener("click", () => void loadChatroomHistory(true));
  $("#chatroom-send-form").addEventListener("submit", sendChatroomMessage);
  $("#chatroom-send-emoji-search").addEventListener("input", renderChatroomSendEmojiPicker);
  $("#chatroom-send-emoji-clear").addEventListener("click", () => selectChatroomSendEmoji(null));
  $("#chatroom-memory-form").addEventListener("submit", saveChatroomMemory);
  $("#chatroom-memory-form [name=scope]").addEventListener("change", toggleMemoryPersonField);
  $("#chatroom-wechat-refresh").addEventListener("click", () => void loadChatroomWechat());
  $("#chatroom-wechat-settings-form").addEventListener("submit", saveChatroomWechatSetting);
  $("#chatroom-wechat-members-form").addEventListener("submit", manageChatroomMembers);
  $("#chatroom-wechat-admin").addEventListener("click", () => void manageChatroomAdmin());
  $("#chatroom-group-qrcode").addEventListener("click", () => void loadChatroomQrCode());
  $("#chatroom-dialog").addEventListener("close", () => {
    stopChatroomHistoryPolling();
    state.currentChatroom = null;
    state.chatroomMessages = [];
    state.chatroomMemories = [];
    state.chatroomMembers = [];
    state.chatroomMemoryAudit = [];
  });
  $("#ipad-login-start").addEventListener("click", () => void startIpadLogin());
  $("#ipad-security-code-form").addEventListener("submit", submitIpadSecurityCode);
  $("#ipad-login-slider").addEventListener("click", () => void openIpadSlider());
  $("#ipad-login-cancel").addEventListener("click", () => void cancelIpadLogin());
  $("#ipad-login-dialog").addEventListener("close", stopIpadLoginPolling);
  $("#refresh-participation").addEventListener("click", () => void refreshParticipation());
  $("#participation-bot").addEventListener("change", () => void refreshParticipation());
  $("#participation-review").addEventListener("change", () => void refreshParticipation());
  $("#participation-quality-review").addEventListener("change", () => void refreshParticipation());
  $("#export-participation").addEventListener("click", () => void exportParticipationDataset());
  $("#prune-participation").addEventListener("click", () => void pruneParticipation());
  $("#theme-toggle").addEventListener("click", cycleTheme);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeSetting() === "auto") applyTheme("auto");
  });
  window.addEventListener("hashchange", restoreViewFromHash);
  $("#load-more-logs").addEventListener("click", () => void loadMoreLogs());
  $("#confirm-ok").addEventListener("click", () => $("#confirm-dialog").close("ok"));
  $("#confirm-cancel").addEventListener("click", () => $("#confirm-dialog").close(""));
  $("#confirm-dialog").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("#confirm-dialog").close(document.activeElement === $("#confirm-cancel") ? "" : "ok");
  });
}

async function login(event) {
  event.preventDefault();
  const token = new FormData(event.currentTarget).get("token").trim();
  state.token = token;
  await withBusy(event.currentTarget.querySelector('button[type="submit"]'), async () => {
    try {
      await api("/api/session");
      localStorage.setItem("pi-admin-token", token);
      $("#login-error").textContent = "";
      $("#login-dialog").close();
      await boot();
    } catch (error) {
      state.token = "";
      $("#login-error").textContent = error.message;
    }
  });
}

function logout() {
  localStorage.removeItem("pi-admin-token");
  state.token = "";
  clearInterval(state.timer);
  showLogin();
}

function showLogin() {
  const dialog = $("#login-dialog");
  if (!dialog.open) dialog.showModal();
}

async function boot() {
  try {
    const [data, plugins, scheduledTasks, chatrooms] = await Promise.all([
      api("/api/bootstrap"),
      api("/api/plugins"),
      api("/api/scheduled-tasks"),
      api("/api/chatrooms"),
    ]);
    state.settings = data.settings;
    state.providerProfiles = data.providers;
    state.knowledgeProviders = data.knowledgeProviders || [];
    state.mcpServers = data.mcpServers || [];
    state.models = data.models;
    state.personas = data.personas || [];
    state.bots = data.bots;
    state.status = data.status;
    state.tts = data.tts || state.tts;
    state.pluginCatalog = plugins.catalog || [];
    state.scheduledTasks = scheduledTasks.tasks || [];
    state.chatrooms = chatrooms.chatrooms || [];
    await refreshQualityOverview();
    $("#connection").textContent = "已连接";
    $("#connection").className = "pill healthy";
    renderAll();
    scheduleRefresh();
    if (state.currentView !== "overview") switchView(state.currentView);
  } catch (error) {
    if (error.status === 401) logout();
    else toast(error.message, true);
  }
}

async function refreshAll() {
  try {
    const [status, bots, models, personas, providers, knowledgeProviders, mcpServers, plugins, scheduledTasks, chatrooms] = await Promise.all([
      api("/api/status"),
      api("/api/bots"),
      api("/api/models"),
      api("/api/personas"),
      api("/api/providers"),
      api("/api/knowledge-providers"),
      api("/api/mcp-servers"),
      api("/api/plugins"),
      api("/api/scheduled-tasks"),
      api("/api/chatrooms"),
    ]);
    state.status = status;
    state.bots = bots.bots;
    state.models = models.models;
    state.personas = personas.personas || [];
    state.providerProfiles = providers.providers;
    state.knowledgeProviders = knowledgeProviders.providers;
    state.mcpServers = mcpServers.servers || [];
    state.pluginCatalog = plugins.catalog || [];
    state.scheduledTasks = scheduledTasks.tasks || [];
    state.chatrooms = chatrooms.chatrooms || [];
    await refreshQualityOverview();
    renderAll();
    if (state.currentView === "logs") await refreshLogs();
  } catch (error) {
    connectionFailed(error);
  }
}

function scheduleRefresh() {
  clearInterval(state.timer);
  state.timer = setInterval(() => void refreshStatus(), state.settings?.statusRefreshMs || 3000);
}

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
    $("#connection").textContent = "已连接";
    $("#connection").className = "pill healthy";
    renderOverview();
    renderBots();
    if (state.currentView === "logs" && $("#log-follow").checked) await refreshLogs(true);
  } catch (error) {
    connectionFailed(error);
  }
}

function connectionFailed(error) {
  $("#connection").textContent = "连接异常";
  $("#connection").className = "pill error";
  if (error.status === 401) logout();
}

function switchView(view) {
  state.currentView = view;
  if (location.hash.slice(1) !== view) location.hash = view;
  $$(".nav[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  if (!state.token) return;
  const loaders = { logs: "#logs-list", participation: "#participation-list", chatrooms: "#chatrooms-list", emojis: "#emojis-list" };
  if (loaders[view]) {
    const container = $(loaders[view]);
    if (!container.childElementCount) container.replaceChildren(loadingBlock());
  }
  if (view === "logs") void refreshLogs();
  if (view === "participation") void refreshParticipation();
  if (view === "chatrooms") void refreshChatrooms();
  if (view === "emojis") void refreshEmojis();
  if (view === "wechat-identity") void loadWechatIdentity();
  if (view === "contacts") void loadContacts();
  if (view === "moments") void loadMoments();
}

function renderAll() {
  renderOverview();
  renderBots();
  renderPlugins();
  renderPersonas();
  renderChatrooms();
  renderEmojis();
  renderProviders();
  renderKnowledgeProviders();
  renderMcpServers();
  renderModels();
  renderSettings();
  renderWechatSelectors();
  fillLogBotFilter();
  fillParticipationBotFilter();
}

function renderPersonas() {
  const rows = state.personas.map((persona) => {
    const usage = state.chatrooms.filter((room) => room.personaProfileId === persona.id);
    return node("article", "persona-card", [
      node("div", "persona-card-head", [
        node("div", "", [node("h2", "", persona.label), node("div", "meta", `${persona.id} · ${usage.length} 个群聊使用`)]),
        node("span", `pill ${persona.enabled ? "healthy" : "muted"}`, persona.enabled ? "可用" : "已停用"),
      ]),
      node("p", "persona-preview", persona.prompt),
      node("div", "meta", [
        node("span", "", `账号昵称：${persona.accountNickname || "继承机器人"} · 群内昵称：${persona.groupNickname || "未设"}`),
        node("span", "", `唤醒词：${(persona.wakeWords || []).join("、") || "仅机器人默认词"} · 头像：${persona.avatarDataUrl ? "已配置" : "未配置"}`),
      ]),
      node("div", "actions", [
        actionButton("应用到微信账号", () => void applyPersonaToWechat(persona), false, "ghost small"),
        actionButton("编辑", () => openPersonaForm(persona), false, "ghost small"),
        actionButton("删除", () => void deletePersona(persona), false, "danger small"),
      ]),
    ]);
  });
  $("#personas-list").replaceChildren(...(rows.length ? rows : [empty("还没有全局人设。新增后可在群聊管理中选择。") ]));
}

async function refreshEmojis() {
  try {
    const result = await api("/api/emojis");
    state.emojis = result.emojis || [];
    renderEmojis();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderEmojis() {
  const filter = $("#emoji-bot-filter");
  const selectedBot = filter.value;
  filter.replaceChildren(
    option("", "全部机器人"),
    ...state.bots.map((bot) => option(bot.id, bot.displayName)),
  );
  filter.value = state.bots.some((bot) => bot.id === selectedBot) ? selectedBot : "";
  const query = $("#emoji-search").value.normalize("NFKC").trim().toLocaleLowerCase();
  const emojis = state.emojis.filter((emoji) =>
    (!filter.value || emoji.botId === filter.value) &&
    (!query || emoji.description.toLocaleLowerCase().includes(query)));
  $("#emoji-count").textContent = `${emojis.length} / ${state.emojis.length} 个表情包`;
  const container = $("#emojis-list");
  if (emojis.length === 0) {
    container.replaceChildren(empty(state.emojis.length ? "没有匹配的表情包。" : "机器人收到微信动态表情后会自动出现在这里。"));
    return;
  }
  container.replaceChildren(...emojis.map(renderEmojiCard));
}

function renderEmojiCard(emoji) {
  const bot = state.bots.find((candidate) => candidate.id === emoji.botId);
  const image = node("img", "emoji-preview");
  image.alt = emoji.description;
  image.loading = "lazy";
  void loadEmojiPreview(emoji.id, image);
  const description = document.createElement("textarea");
  description.rows = 3;
  description.maxLength = 500;
  description.value = emoji.description;
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = emoji.enabled;
  const thinking = document.createElement("input");
  thinking.type = "checkbox";
  thinking.checked = emoji.isThinking;
  const form = node("form", "emoji-card", [
    node("div", "emoji-visual", [
      image,
      node("div", "emoji-badges", [
        node("span", `pill ${emoji.status === "ready" ? "healthy" : emoji.status === "failed" ? "error" : "starting"}`, emojiStatusLabel(emoji.status)),
        ...(emoji.isThinking ? [node("span", "pill warn", "思考占位")] : []),
      ]),
    ]),
    node("div", "emoji-card-body", [
      node("div", "emoji-card-meta", [
        node("strong", "", bot?.displayName || emoji.botId),
        node("span", "meta", `${formatBytes(emoji.size || 0)} · 使用 ${emoji.useCount || 0} 次 · ${formatDate(emoji.createdAt)}`),
      ]),
      field("模型调用描述", description),
      node("div", "emoji-options", [
        field("允许模型调用", enabled),
        field("设为“正在思考”", thinking),
      ]),
      ...(emoji.error ? [node("div", "emoji-error", emoji.error)] : []),
      node("div", "actions", [
        actionButton("删除", () => void deleteEmoji(emoji), false, "danger"),
        actionButton("保存", () => form.requestSubmit(), false, "primary"),
      ]),
    ]),
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEmoji(emoji, {
      description: description.value.trim(),
      enabled: enabled.checked,
      isThinking: thinking.checked,
    });
  });
  return form;
}

async function loadEmojiPreview(id, image) {
  try {
    let url = state.emojiPreviewUrls.get(id);
    if (!url) {
      const response = await fetch(`/api/emojis/${encodeURIComponent(id)}/content`, {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      url = URL.createObjectURL(await response.blob());
      state.emojiPreviewUrls.set(id, url);
    }
    image.src = url;
  } catch {
    image.replaceWith(node("div", "emoji-preview emoji-preview-error", "预览失败"));
  }
}

async function saveEmoji(emoji, input) {
  if (!input.description) return toast("表情包描述不能为空", true);
  try {
    await api(`/api/emojis/${encodeURIComponent(emoji.id)}`, { method: "PATCH", body: input });
    toast("表情包配置已保存");
    await refreshEmojis();
  } catch (error) {
    toast(error.message, true);
  }
}

async function deleteEmoji(emoji) {
  if (!(await confirmDialog({
    title: "删除表情包",
    body: "确认从表情库删除这个表情包？本地媒体文件可能仍因去重被其他记录引用。",
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/emojis/${encodeURIComponent(emoji.id)}`, { method: "DELETE" });
    const preview = state.emojiPreviewUrls.get(emoji.id);
    if (preview) URL.revokeObjectURL(preview);
    state.emojiPreviewUrls.delete(emoji.id);
    state.emojis = state.emojis.filter((candidate) => candidate.id !== emoji.id);
    renderEmojis();
    toast("表情包已删除");
  } catch (error) {
    toast(error.message, true);
  }
}

function emojiStatusLabel(status) {
  return { analyzing: "识别中", ready: "可用", failed: "识别失败" }[status] || status;
}

function openPersonaForm(persona = null) {
  state.editingPersona = persona;
  const form = $("#persona-form");
  form.reset();
  form.elements.id.readOnly = Boolean(persona);
  form.elements.id.value = persona?.id || "";
  form.elements.label.value = persona?.label || "";
  form.elements.prompt.value = persona?.prompt || "";
  form.elements.accountNickname.value = persona?.accountNickname || "";
  form.elements.groupNickname.value = persona?.groupNickname || "";
  form.elements.wakeWords.value = (persona?.wakeWords || []).join("，");
  form.elements.autoApplyAccountProfile.checked = persona?.autoApplyAccountProfile === true;
  form.elements.removeAvatar.checked = false;
  state.personaAvatarDataUrl = persona?.avatarDataUrl || null;
  showImagePreview($("#persona-avatar-preview"), state.personaAvatarDataUrl);
  form.elements.enabled.checked = persona?.enabled ?? true;
  $("#persona-dialog-title").textContent = persona ? "编辑人设" : "新增人设";
  $("#persona-dialog").showModal();
}

async function savePersona(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    const avatarFile = form.elements.avatarFile.files[0];
    const avatarDataUrl = form.elements.removeAvatar.checked
      ? undefined
      : avatarFile ? await imageFileDataUrl(avatarFile) : state.personaAvatarDataUrl || undefined;
    const result = await api("/api/personas", {
      method: "POST",
      body: {
        id: form.elements.id.value,
        label: form.elements.label.value,
        prompt: form.elements.prompt.value,
        accountNickname: form.elements.accountNickname.value || undefined,
        groupNickname: form.elements.groupNickname.value || undefined,
        wakeWords: delimitedList(form.elements.wakeWords.value),
        avatarDataUrl,
        autoApplyAccountProfile: form.elements.autoApplyAccountProfile.checked,
        enabled: form.elements.enabled.checked,
      },
    });
    state.personas = result.personas || [];
    $("#persona-dialog").close();
    renderPersonas();
    renderChatrooms();
    toast("人设已保存，下次模型调用立即生效");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function deletePersona(persona) {
  if (!(await confirmDialog({
    title: "删除人设",
    body: `确认删除人设“${persona.label}”？仍被全局配置、机器人、群聊或私聊会话使用的人设不能删除。`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/personas/${encodeURIComponent(persona.id)}`, { method: "DELETE" });
    state.personas = state.personas.filter((item) => item.id !== persona.id);
    renderPersonas();
    toast("人设已删除");
  } catch (error) { toast(error.message, true); }
}

function renderWechatSelectors() {
  const bots = state.bots.filter((bot) => bot.channel.type === "wechat-ipad");
  for (const selector of ["#wechat-identity-bot", "#contacts-bot", "#moments-bot"]) {
    const select = $(selector);
    const selected = select.value;
    select.replaceChildren(...bots.map((bot) => option(bot.id, `${bot.displayName} · ${bot.channel.accountWxid}`)));
    if (bots.some((bot) => bot.id === selected)) select.value = selected;
  }
}

function selectedWechatBot(selector) {
  const id = $(selector).value;
  const bot = state.bots.find((candidate) => candidate.id === id && candidate.channel.type === "wechat-ipad");
  if (!bot) throw new Error("请先选择正在运行的 iPad 机器人");
  return bot;
}

async function applyPersonaToWechat(persona) {
  const ipadBots = state.bots.filter((bot) => bot.channel.type === "wechat-ipad");
  const selectedId = $("#wechat-identity-bot").value;
  const bot = ipadBots.find((item) => item.id === selectedId) || ipadBots[0];
  if (!bot) return toast("没有可用的 iPad 机器人", true);
  if (!persona.accountNickname && !persona.avatarDataUrl) return toast("这个人设没有账号昵称或头像预设", true);
  if (!(await confirmDialog({
    title: "应用人设到微信账号",
    body: `确认把“${persona.label}”的昵称/头像应用到 ${bot.displayName}？\n\n这是微信账号全局资料，会影响该账号所在的全部群聊。`,
  }))) return;
  try {
    const result = await api(`/api/personas/${encodeURIComponent(persona.id)}/apply`, {
      method: "POST",
      body: { botId: bot.id },
    });
    toast(result.result?.accountProfileApplied ? "人设昵称/头像已应用到微信账号" : "人设已生效；没有需要同步的账号资料");
  } catch (error) { toast(error.message, true); }
}

async function previewPersonaAvatar(event) {
  const file = event.currentTarget.files[0];
  if (!file) return;
  try {
    state.personaAvatarDataUrl = await imageFileDataUrl(file);
    showImagePreview($("#persona-avatar-preview"), state.personaAvatarDataUrl);
  } catch (error) { event.currentTarget.value = ""; toast(error.message, true); }
}

async function loadWechatIdentity() {
  let bot;
  try { bot = selectedWechatBot("#wechat-identity-bot"); } catch (error) {
    $("#wechat-profile-raw").textContent = error.message;
    return;
  }
  try {
    const [profile, capability] = await Promise.all([
      api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/profile`),
      api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/capabilities`),
    ]);
    state.wechatProfile = profile.profile;
    state.wechatCapabilities = capability.capabilities;
    $("#wechat-profile-raw").textContent = prettyProtocol(profile.profile);
    $("#wechat-identity-capability").textContent = capability.capabilities.groupNicknameReason;
  } catch (error) { $("#wechat-profile-raw").textContent = error.message; }
}

async function saveWechatProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  let bot;
  try { bot = selectedWechatBot("#wechat-identity-bot"); } catch (error) { return toast(error.message, true); }
  const body = Object.fromEntries(["nickname", "signature", "city", "province", "country"]
    .map((name) => [name, form.elements[name].value.trim()]).filter((entry) => entry[1]));
  if (form.elements.sex.value !== "") body.sex = Number(form.elements.sex.value);
  if (Object.keys(body).length === 0) return toast("至少填写一个要修改的资料字段", true);
  if (!(await confirmDialog({
    title: "修改微信账号资料",
    body: "确认修改这个微信账号的全局资料？会影响该账号所在的全部群聊。",
  }))) return;
  try {
    await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/profile`, { method: "PATCH", body });
    toast("微信账号资料已修改");
    form.reset();
    await loadWechatIdentity();
  } catch (error) { toast(error.message, true); }
}

async function previewWechatAvatar(event) {
  const file = event.currentTarget.files[0];
  if (!file) return showImagePreview($("#wechat-avatar-preview"), null);
  try { showImagePreview($("#wechat-avatar-preview"), await imageFileDataUrl(file)); }
  catch (error) { event.currentTarget.value = ""; toast(error.message, true); }
}

async function uploadWechatAvatar() {
  let bot;
  try { bot = selectedWechatBot("#wechat-identity-bot"); } catch (error) { return toast(error.message, true); }
  const file = $("#wechat-avatar-file").files[0];
  if (!file) return toast("请先选择头像图片", true);
  if (!(await confirmDialog({
    title: "修改微信头像",
    body: "确认修改这个微信账号的全局头像？",
  }))) return;
  try {
    await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/avatar`, {
      method: "POST", body: { avatarDataUrl: await imageFileDataUrl(file) },
    });
    toast("微信头像已更新");
  } catch (error) { toast(error.message, true); }
}

async function loadWechatQrCode() {
  let bot;
  try { bot = selectedWechatBot("#wechat-identity-bot"); } catch (error) { return toast(error.message, true); }
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/qrcode`);
    renderProtocolImage($("#wechat-qrcode-result"), result.qrcode);
  } catch (error) { toast(error.message, true); }
}

async function loadContacts() {
  let bot;
  try { bot = selectedWechatBot("#contacts-bot"); } catch (error) { $("#contacts-result").textContent = error.message; return; }
  try {
    const [contacts, labels] = await Promise.all([
      api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/contacts`),
      api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/labels`),
    ]);
    $("#contacts-result").textContent = prettyProtocol(contacts.contacts);
    $("#labels-result").textContent = prettyProtocol(labels.labels);
  } catch (error) { $("#contacts-result").textContent = error.message; }
}

async function searchContact(event) {
  event.preventDefault();
  try {
    const bot = selectedWechatBot("#contacts-bot");
    const query = event.currentTarget.elements.query.value.trim();
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/contacts/search`, { method: "POST", body: { query } });
    $("#contact-search-result").textContent = prettyProtocol(result.contact);
  } catch (error) { toast(error.message, true); }
}

async function saveContactRemark() {
  const form = $("#contact-search-form");
  try {
    const bot = selectedWechatBot("#contacts-bot");
    const contactId = form.elements.contactId.value.trim();
    const remarks = form.elements.remarks.value.trim();
    if (!contactId) return toast("请输入联系人 wxid", true);
    if (!(await confirmDialog({ title: "修改联系人备注", body: `确认修改 ${contactId} 的备注？` }))) return;
    await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/contacts/remark`, { method: "POST", body: { contactId, remarks } });
    toast("联系人备注已修改");
  } catch (error) { toast(error.message, true); }
}

async function runLabelAction(action) {
  const form = $("#label-form");
  try {
    const bot = selectedWechatBot("#contacts-bot");
    const labelId = form.elements.labelId.value.trim();
    const name = form.elements.name.value.trim();
    const base = `/api/bots/${encodeURIComponent(bot.id)}/wechat/labels`;
    if (action === "delete" && !(await confirmDialog({
      title: "删除标签",
      body: `确认删除标签 ${labelId}？`,
      danger: true,
      confirmText: "删除",
    }))) return;
    if (action === "add") await api(base, { method: "POST", body: { name } });
    else if (action === "rename") await api(`${base}/${encodeURIComponent(labelId)}`, { method: "PATCH", body: { name } });
    else if (action === "members") await api(`${base}/${encodeURIComponent(labelId)}`, { method: "PATCH", body: { contactIds: delimitedList(form.elements.contactIds.value) } });
    else if (action === "delete") await api(`${base}/${encodeURIComponent(labelId)}`, { method: "DELETE" });
    toast("联系人标签已更新");
    await loadContacts();
  } catch (error) { toast(error.message, true); }
}

async function loadMoments() {
  let bot;
  try { bot = selectedWechatBot("#moments-bot"); } catch (error) { $("#moments-result").textContent = error.message; return; }
  try {
    const [result, automation] = await Promise.all([
      api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/moments`),
      api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/moments/automation`),
    ]);
    $("#moments-result").textContent = prettyProtocol(result.moments);
    const form = $("#moment-automation-form");
    const settings = automation.settings;
    form.elements.enabled.checked = settings.enabled;
    form.elements.dryRun.checked = settings.dryRun;
    form.elements.autoLike.checked = settings.autoLike;
    form.elements.autoComment.checked = settings.autoComment;
    form.elements.allowedAuthorWxids.value = (settings.allowedAuthorWxids || []).join("\n");
    form.elements.maxActionsPerDay.value = settings.maxActionsPerDay;
    form.elements.minIntervalMinutes.value = settings.minIntervalMinutes;
    form.elements.lookbackMinutes.value = settings.lookbackMinutes;
    form.elements.commentTemplates.value = (settings.commentTemplates || []).join("\n");
    $("#moment-automation-actions").textContent = prettyProtocol(automation.actions || []);
  } catch (error) { $("#moments-result").textContent = error.message; }
}

async function saveMomentAutomation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const bot = selectedWechatBot("#moments-bot");
    const settings = {
      enabled: form.elements.enabled.checked,
      dryRun: form.elements.dryRun.checked,
      autoLike: form.elements.autoLike.checked,
      autoComment: form.elements.autoComment.checked,
      allowedAuthorWxids: delimitedList(form.elements.allowedAuthorWxids.value),
      maxActionsPerDay: Number(form.elements.maxActionsPerDay.value),
      minIntervalMinutes: Number(form.elements.minIntervalMinutes.value),
      lookbackMinutes: Number(form.elements.lookbackMinutes.value),
      commentTemplates: delimitedList(form.elements.commentTemplates.value),
    };
    if (settings.enabled && !settings.dryRun && !(await confirmDialog({
      title: "开启真实自动互动",
      body: `确认开启真实朋友圈自动互动？\n\n白名单 ${settings.allowedAuthorWxids.length} 人；每天最多 ${settings.maxActionsPerDay} 次；最短间隔 ${settings.minIntervalMinutes} 分钟。`,
      danger: true,
      confirmText: "开启",
    }))) return;
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/moments/automation`, {
      method: "PUT", body: settings,
    });
    $("#moment-automation-actions").textContent = prettyProtocol(result.actions || []);
    toast(result.settings.enabled
      ? result.settings.dryRun ? "自动互动策略已启用（dry-run）" : "真实自动互动策略已启用"
      : "自动互动策略已停用");
  } catch (error) { toast(error.message, true); }
}

async function publishMoment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const bot = selectedWechatBot("#moments-bot");
    const content = form.elements.content.value.trim();
    if (!(await confirmDialog({
      title: "发布朋友圈",
      body: `确认立即发布这条${form.elements.privacy.value === "private" ? "私密" : "公开"}朋友圈？\n\n${content}`,
      confirmText: "确认发布",
    }))) return;
    await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/moments`, {
      method: "POST", body: { content, privacy: form.elements.privacy.value },
    });
    form.reset();
    toast("朋友圈已发布");
    await loadMoments();
  } catch (error) { toast(error.message, true); }
}

async function runMomentAction(action) {
  const form = $("#moment-interaction-form");
  try {
    const bot = selectedWechatBot("#moments-bot");
    const momentId = form.elements.momentId.value.trim();
    const content = form.elements.content.value.trim();
    if (action === "comment" && !content) return toast("评论内容不能为空", true);
    if (!(await confirmDialog({
      title: action === "like" ? "点赞朋友圈" : "评论朋友圈",
      body: `确认${action === "like" ? "点赞" : "评论"}朋友圈 ${momentId}？${action === "comment" ? `\n\n${content}` : ""}`,
    }))) return;
    await api(`/api/bots/${encodeURIComponent(bot.id)}/wechat/moments/${encodeURIComponent(momentId)}/${action}`, {
      method: "POST", body: action === "comment" ? { content } : {},
    });
    toast(action === "like" ? "已点赞" : "已评论");
  } catch (error) { toast(error.message, true); }
}

function renderPlugins() {
  const cards = state.bots.map((bot) => {
    const morning = bot.plugins?.find((plugin) => plugin.type === "morning-brief") || DEFAULT_MORNING_BRIEF_PLUGIN;
    const pat = bot.plugins?.find((plugin) => plugin.type === "pat-reply") || DEFAULT_PAT_REPLY_PLUGIN;
    const summary = bot.plugins?.find((plugin) => plugin.type === "group-summary") || DEFAULT_GROUP_SUMMARY_PLUGIN;
    const scheduled = bot.plugins?.find((plugin) => plugin.type === "scheduled-task") || DEFAULT_SCHEDULED_TASK_PLUGIN;
    const autoParticipation = bot.plugins?.find((plugin) => plugin.type === "auto-participation") || DEFAULT_AUTO_PARTICIPATION_PLUGIN;
    const coldWarmup = bot.plugins?.find((plugin) => plugin.type === "cold-chat-warmup") || DEFAULT_COLD_CHAT_WARMUP_PLUGIN;
    const redEnvelope = bot.plugins?.find((plugin) => plugin.type === "red-envelope-notify") || DEFAULT_RED_ENVELOPE_PLUGIN;
    const repeater = bot.plugins?.find((plugin) => plugin.type === "repeater") || DEFAULT_REPEATER_PLUGIN;
    const magnetCodeSearch = bot.plugins?.find((plugin) => plugin.type === "magnet-code-search") || DEFAULT_MAGNET_CODE_SEARCH_PLUGIN;
    const card = node("form", "plugin-bot-card");
    card.dataset.botId = bot.id;

    const head = node("div", "plugin-bot-head", [
      node("div", "", [node("h2", "", bot.displayName), node("div", "meta", `${bot.id} · ${bot.channel.type}`)]),
      node("span", `pill ${bot.enabled ? "healthy" : "muted"}`, bot.enabled ? "Bot 已启用" : "Bot 已停用"),
    ]);

    const morningPanel = node("fieldset", "plugin-panel");
    const morningLegend = node("legend", "", "群聊晨报");
    const morningEnabled = checkboxControl("启用晨报", "morningEnabled", morning.enabled);
    const morningTime = inputControl("time", "morningTime", minuteToTime(morning.settings.minute ?? 435));
    const morningMin = inputControl("number", "morningMin", morning.settings.activeGroupMinMessages ?? 5, { min: "1", max: "1000" });
    const morningUrl = inputControl("url", "morningUrl", morning.settings.newsSourceUrl || DEFAULT_MORNING_BRIEF_PLUGIN.settings.newsSourceUrl);
    morningPanel.append(
      morningLegend,
      node("p", "plugin-description", "按本地时区汇总昨日群聊，并从配置的 HTTP 接口摘取早报数据。关闭时不会请求接口或调用模型。"),
      node("div", "plugin-fields", [
        morningEnabled,
        field("发送时间", morningTime),
        field("活跃群最低消息数", morningMin),
        field("早报数据接口", morningUrl),
      ]),
    );

    const patPanel = node("fieldset", "plugin-panel");
    const patLegend = node("legend", "", "拍一拍回复");
    const patEnabled = checkboxControl("启用拍一拍回复", "patEnabled", pat.enabled);
    const patGroupOnly = checkboxControl("仅群聊生效", "patGroupOnly", pat.settings.groupOnly !== false);
    const replies = document.createElement("textarea");
    replies.name = "patReplies";
    replies.rows = 4;
    replies.required = true;
    replies.placeholder = "每行一条，收到拍一拍后稳定随机选择；可用 {昵称} 代入拍你的群友";
    replies.value = (Array.isArray(pat.settings.replies)
      ? pat.settings.replies
      : String(pat.settings.replyText || "拍我干嘛～").split(/\r?\n/u)).join("\n");
    patPanel.append(
      node("legend", "", "拍一拍回复"),
      node("p", "plugin-description", "识别微信原生 pat 系统事件，仅在目标是当前机器人时回复；直接进入持久化 outbox，不消耗 LLM Token。"),
      node("div", "plugin-fields", [patEnabled, patGroupOnly, field("自定义回复（每行一条）", replies)]),
    );

    const summaryPanel = node("fieldset", "plugin-panel");
    const summaryEnabled = checkboxControl("启用群聊总结", "summaryEnabled", summary.enabled);
    const summaryOnDemand = checkboxControl("响应群友总结/复盘", "summaryOnDemand", summary.settings.onDemandEnabled !== false);
    const summaryScheduled = checkboxControl("每日定时总结", "summaryScheduled", summary.settings.scheduledEnabled !== false);
    const summaryTime = inputControl("time", "summaryTime", minuteToTime(summary.settings.minute ?? 1200));
    const summaryMin = inputControl("number", "summaryMin", summary.settings.activeGroupMinMessages ?? 5, { min: "1", max: "1000" });
    const summaryChars = inputControl("number", "summaryChars", summary.settings.maxTranscriptChars ?? 12000, { min: "1000", max: "50000", step: "500" });
    summaryPanel.append(
      node("legend", "", "群聊总结"),
      node("p", "plugin-description", "识别明确的群聊总结/复盘请求，也可每天晚八点汇总当天话题、结论和待办；摘要上下文有严格字符上限。"),
      node("div", "plugin-fields", [
        summaryEnabled,
        summaryOnDemand,
        summaryScheduled,
        field("定时发送时间", summaryTime),
        field("定时总结最低消息数", summaryMin),
        field("最多摘要上下文字符", summaryChars),
      ]),
    );

    const scheduledPanel = node("fieldset", "plugin-panel scheduled-task-panel");
    const scheduledEnabled = checkboxControl("允许群友创建定时任务", "scheduledTaskEnabled", scheduled.enabled);
    const draftTimeout = inputControl("number", "scheduledTaskDraftTimeout", scheduled.settings.draftTimeoutMinutes ?? 30, { min: "5", max: "1440" });
    const maxTasks = inputControl("number", "scheduledTaskMaxTasks", scheduled.settings.maxTasksPerGroup ?? 20, { min: "1", max: "200" });
    scheduledPanel.append(
      node("legend", "", "群聊定时任务"),
      node("p", "plugin-description", "这里配置 Bot 默认能力和任务上限；已有任务请到“群聊管理”中按群查看、启停、编辑和删除。"),
      node("div", "plugin-fields", [
        scheduledEnabled,
        field("草稿追问有效期（分钟）", draftTimeout),
        field("每群启用任务上限", maxTasks),
      ]),
    );

    const autoPanel = node("fieldset", "plugin-panel");
    autoPanel.append(
      node("legend", "", "自动接话"),
      node("p", "plugin-description", "控制环境提问、热群插话、话题延续和学习得到的主动发言。关闭后仍响应明确 @、引用和唤醒词。"),
      node("div", "plugin-fields", [checkboxControl("Bot 默认启用自动接话", "autoParticipationEnabled", autoParticipation.enabled)]),
    );

    const coldPanel = node("fieldset", "plugin-panel");
    coldPanel.append(
      node("legend", "", "冷群暖场"),
      node("p", "plugin-description", "仅控制群聊长时间沉寂后的主动暖场，独立于自动接话；仍受日间作息、冷却和每日上限约束。"),
      node("div", "plugin-fields", [checkboxControl("Bot 默认启用冷群暖场", "coldChatWarmupEnabled", coldWarmup.enabled)]),
    );

    const repeaterPanel = node("fieldset", "plugin-panel");
    repeaterPanel.append(
      node("legend", "", "复读机"),
      node("p", "plugin-description", "仅在连续两位不同群友发送相同的安全短文字或微信动态表情后参与；单人连续发送或单条消息绝不触发。"),
      node("div", "plugin-fields", [
        checkboxControl("Bot 默认启用复读机", "repeaterEnabled", repeater.enabled),
        field("复读冷却（分钟）", inputControl("number", "repeaterCooldown", repeater.settings.cooldownMinutes ?? 8, { min: "1", max: "1440" })),
      ]),
    );

    const redEnvelopePanel = node("fieldset", "plugin-panel");
    redEnvelopePanel.append(
      node("legend", "", "红包提醒"),
      node("p", "plugin-description", "识别普通红包、专属红包和微信礼物，原生 @ 各群所选成员；群收款会排除，且绝不会自动抢红包。提醒名单在“群聊管理”中设置。"),
      node("div", "plugin-fields", [checkboxControl("Bot 默认启用红包提醒", "redEnvelopeEnabled", redEnvelope.enabled)]),
    );

    const magnetCodeSearchPanel = node("fieldset", "plugin-panel");
    magnetCodeSearchPanel.append(
      node("legend", "", "编号磁力搜索"),
      node("p", "plugin-description", "群友发送纯英文-数字编号（如 ABCD-1234）时查询 cilisousuo.cc；仅返回精确匹配的规范化磁力链接，不调用模型。"),
      node("div", "plugin-fields", [
        checkboxControl("Bot 默认启用编号磁力搜索", "magnetCodeSearchEnabled", magnetCodeSearch.enabled),
        field("查询超时（秒）", inputControl("number", "magnetCodeSearchTimeout", magnetCodeSearch.settings.timeoutSeconds ?? 8, { min: "2", max: "30" })),
        field("最多返回结果", inputControl("number", "magnetCodeSearchMaxResults", magnetCodeSearch.settings.maxResults ?? 1, { min: "1", max: "3" })),
      ]),
    );

    const actions = node("div", "plugin-actions", [
      node("span", "meta", `${state.pluginCatalog.length || 4} 个内置插件`),
      actionButton("保存并应用", () => {}, false, "primary"),
    ]);
    actions.querySelector("button").type = "submit";
    card.append(head, node("div", "plugin-grid", [autoPanel, coldPanel, redEnvelopePanel, repeaterPanel, magnetCodeSearchPanel, morningPanel, patPanel, summaryPanel, scheduledPanel]), actions);
    card.addEventListener("submit", saveBotPlugins);
    return card;
  });
  $("#plugins-list").replaceChildren(...(cards.length ? cards : [empty("请先新增机器人，再为它配置功能插件。") ]));
}

async function saveBotPlugins(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const bot = state.bots.find((item) => item.id === form.dataset.botId);
  if (!bot || !form.reportValidity()) return;
  const replies = form.elements.patReplies.value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  const plugins = [
    ...(bot.plugins || []).filter((plugin) =>
      plugin.type !== "morning-brief" && plugin.type !== "pat-reply" &&
      plugin.type !== "group-summary" && plugin.type !== "scheduled-task" &&
      plugin.type !== "auto-participation" && plugin.type !== "cold-chat-warmup" &&
      plugin.type !== "red-envelope-notify" &&
      plugin.type !== "repeater" && plugin.type !== "magnet-code-search"),
    {
      id: bot.plugins?.find((plugin) => plugin.type === "morning-brief")?.id || "morning-brief",
      type: "morning-brief",
      enabled: form.elements.morningEnabled.checked,
      settings: {
        minute: timeToMinute(form.elements.morningTime.value),
        activeGroupMinMessages: Number(form.elements.morningMin.value),
        newsSourceUrl: form.elements.morningUrl.value,
      },
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "pat-reply")?.id || "pat-reply",
      type: "pat-reply",
      enabled: form.elements.patEnabled.checked,
      settings: { replies, groupOnly: form.elements.patGroupOnly.checked },
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "group-summary")?.id || "group-summary",
      type: "group-summary",
      enabled: form.elements.summaryEnabled.checked,
      settings: {
        scheduledEnabled: form.elements.summaryScheduled.checked,
        onDemandEnabled: form.elements.summaryOnDemand.checked,
        minute: timeToMinute(form.elements.summaryTime.value),
        activeGroupMinMessages: Number(form.elements.summaryMin.value),
        maxTranscriptChars: Number(form.elements.summaryChars.value),
      },
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "scheduled-task")?.id || "scheduled-task",
      type: "scheduled-task",
      enabled: form.elements.scheduledTaskEnabled.checked,
      settings: {
        draftTimeoutMinutes: Number(form.elements.scheduledTaskDraftTimeout.value),
        maxTasksPerGroup: Number(form.elements.scheduledTaskMaxTasks.value),
        dueBatchSize: 10,
      },
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "auto-participation")?.id || "auto-participation",
      type: "auto-participation",
      enabled: form.elements.autoParticipationEnabled.checked,
      settings: {},
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "cold-chat-warmup")?.id || "cold-chat-warmup",
      type: "cold-chat-warmup",
      enabled: form.elements.coldChatWarmupEnabled.checked,
      settings: {},
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "red-envelope-notify")?.id || "red-envelope-notify",
      type: "red-envelope-notify",
      enabled: form.elements.redEnvelopeEnabled.checked,
      settings: {},
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "repeater")?.id || "repeater",
      type: "repeater",
      enabled: form.elements.repeaterEnabled.checked,
      settings: {
        cooldownMinutes: Number(form.elements.repeaterCooldown.value),
      },
    },
    {
      id: bot.plugins?.find((plugin) => plugin.type === "magnet-code-search")?.id || "magnet-code-search",
      type: "magnet-code-search",
      enabled: form.elements.magnetCodeSearchEnabled.checked,
      settings: {
        timeoutSeconds: Number(form.elements.magnetCodeSearchTimeout.value),
        maxResults: Number(form.elements.magnetCodeSearchMaxResults.value),
      },
    },
  ];
  const button = form.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    await api(`/api/bots/${encodeURIComponent(bot.id)}/plugins`, { method: "PUT", body: { plugins } });
    toast(`${bot.displayName} 的插件配置已保存并应用`);
    await reloadConfiguration();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function refreshChatrooms() {
  try {
    const result = await api("/api/chatrooms");
    state.chatrooms = result.chatrooms || [];
    renderChatrooms();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderChatrooms() {
  const botFilter = $("#chatroom-bot-filter");
  const selectedBot = botFilter.value;
  botFilter.replaceChildren(option("", "全部机器人"), ...state.bots.map((bot) => option(bot.id, bot.displayName)));
  botFilter.value = selectedBot;
  const query = $("#chatroom-search").value.normalize("NFKC").trim().toLocaleLowerCase();
  const rooms = state.chatrooms.filter((room) => {
    if (selectedBot && !(room.botIds || [room.botId]).includes(selectedBot)) return false;
    if (!query) return true;
    return [room.label, room.title, room.chatroomId, room.botDisplayName, ...(room.bots || []).map((bot) => bot.displayName)]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  });
  $("#chatroom-count").textContent = `${rooms.length} / ${state.chatrooms.length} 个群聊`;
  renderChatroomBulkControls();
  if (rooms.length === 0) {
    $("#chatrooms-list").replaceChildren(empty(state.chatrooms.length ? "没有匹配的群聊。" : "运行并收到群消息后，这里会自动发现群聊。"));
    return;
  }
  const header = node("div", "chatroom-table-row chatroom-table-head", [
    bulkSelectionCheckbox(rooms),
    node("span", "", "群聊"),
    node("span", "", "机器人 / 活跃"),
    node("span", "", "模型 / 插件"),
    node("span", "", "任务"),
    node("span", "", ""),
  ]);
  $("#chatrooms-list").replaceChildren(header, ...rooms.map(renderChatroomRow));
}

function renderChatroomRow(room) {
  const bot = state.bots.find((item) => item.id === room.botId);
  if (!bot) return document.createDocumentFragment();
  const name = room.label || room.title || room.chatroomId;
  const roomBotIds = room.botIds || [bot.id];
  const taskCount = state.scheduledTasks.filter((task) =>
    roomBotIds.includes(task.botId) && canonicalRoomId(task.conversationId) === canonicalRoomId(room.chatroomId)).length;
  const enabledPlugins = room.plugins.filter((plugin) => plugin.enabled).length;
  const chatModel = state.models.find((model) => model.id === room.chatModelProfileId)?.label || "继承 Bot";
  const lastActivity = room.lastMessageAt ? formatDate(room.lastMessageAt) : "无消息";
  const manage = actionButton("管理", () => void openChatroomDialog(bot, room), false, "primary small");
  const select = document.createElement("input");
  select.type = "checkbox";
  select.ariaLabel = `选择 ${name}`;
  select.checked = state.selectedChatrooms.has(chatroomSelectionKey(room));
  select.addEventListener("change", () => {
    const key = chatroomSelectionKey(room);
    if (select.checked) state.selectedChatrooms.add(key);
    else state.selectedChatrooms.delete(key);
    renderChatroomBulkControls();
  });
  const agentLabel = room.bots?.length > 1
    ? room.bots.map((item) => `${item.role === "primary" ? "主" : "备"}·${item.displayName}`).join(" / ")
    : bot.displayName;
  const healthLabel = room.bots?.length > 1
    ? room.bots.map((item) => `${item.displayName}${item.healthy === true ? "在线" : item.healthy === false ? "离线" : "检测中"}`).join(" · ")
    : lastActivity;
  return node("article", "chatroom-table-row", [
    select,
    node("div", "chatroom-name-cell", [node("strong", "", name), node("span", "meta", room.chatroomId)]),
    node("div", "", [node("strong", "", agentLabel), node("span", "meta", `${healthLabel} · ${room.inboundMessages} 条 · ${room.activeMembers} 人`)]),
    node("div", "", [node("span", "", chatModel), node("span", "meta", `${enabledPlugins}/${room.plugins.length} 个插件生效`)]),
    node("span", taskCount > 0 ? "pill healthy" : "pill muted", `${taskCount} 个`),
    manage,
  ]);
}

function bulkSelectionCheckbox(rooms) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.ariaLabel = "选择当前筛选结果";
  const keys = rooms.map(chatroomSelectionKey);
  input.checked = keys.length > 0 && keys.every((key) => state.selectedChatrooms.has(key));
  input.indeterminate = !input.checked && keys.some((key) => state.selectedChatrooms.has(key));
  input.addEventListener("change", () => {
    keys.forEach((key) => input.checked ? state.selectedChatrooms.add(key) : state.selectedChatrooms.delete(key));
    renderChatrooms();
  });
  return input;
}

function chatroomSelectionKey(room) {
  return canonicalRoomId(room.chatroomId);
}

function renderChatroomBulkControls() {
  const form = $("#chatroom-bulk-form");
  const personaSelect = form.elements.personaProfileId;
  const selectedPersona = personaSelect.value || "__unchanged__";
  personaSelect.replaceChildren(
    option("__unchanged__", "人设不变"),
    option("", "恢复继承"),
    ...state.personas.filter((persona) => persona.enabled).map((persona) => option(persona.id, persona.label)),
  );
  personaSelect.value = [...personaSelect.options].some((item) => item.value === selectedPersona)
    ? selectedPersona
    : "__unchanged__";
  const pluginSelect = form.elements.pluginType;
  const selectedPlugin = pluginSelect.value;
  pluginSelect.replaceChildren(option("", "插件不变"), ...CHATROOM_PLUGIN_TYPES.map(([type, label]) => option(type, label)));
  pluginSelect.value = selectedPlugin;
  $("#chatroom-selected-count").textContent = `已选 ${state.selectedChatrooms.size} 个`;
  form.querySelector('button[type="submit"]').disabled = state.selectedChatrooms.size === 0;
  $("#chatroom-bulk-reset-context").disabled = state.selectedChatrooms.size === 0;
}

async function saveChatroomBulkChanges(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const personaValue = form.elements.personaProfileId.value;
  const participationIntensity = form.elements.participationIntensity.value;
  const pluginType = form.elements.pluginType.value;
  if (personaValue === "__unchanged__" && participationIntensity === "__unchanged__" && !pluginType) {
    toast("请选择要批量应用的人设或插件状态", true);
    return;
  }
  const targets = selectedChatroomTargets();
  if (!(await confirmDialog({
    title: "批量修改群聊",
    body: `确认批量修改 ${targets.length} 个群聊？每个涉及的 Bot 只会重载一次。`,
  }))) return;
  const button = form.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    const result = await api("/api/chatrooms/bulk", {
      method: "PUT",
      body: {
        targets,
        ...(personaValue === "__unchanged__" ? {} : { personaProfileId: personaValue || null }),
        ...(participationIntensity === "__unchanged__" ? {} : { participationIntensity }),
        ...(pluginType ? { pluginChanges: { [pluginType]: form.elements.pluginEnabled.value === "true" } } : {}),
      },
    });
    state.chatrooms = result.chatrooms || [];
    state.selectedChatrooms.clear();
    await reloadConfiguration();
    toast(`已批量更新 ${result.updated} 个群聊${result.contextResets ? `，并重置 ${result.contextResets} 个上下文` : ""}`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

function selectedChatroomTargets() {
  return state.chatrooms.filter((room) => state.selectedChatrooms.has(chatroomSelectionKey(room)))
    .map((room) => ({ botId: room.botId, chatroomId: room.chatroomId }));
}

async function resetSelectedChatroomContexts() {
  const targets = selectedChatroomTargets();
  if (targets.length === 0) return;
  if (!(await confirmDialog({
    title: "重置群聊上下文",
    body: `确认重置所选 ${targets.length} 个群聊的短期上下文？完整聊天记录和长期记忆仍会保留。`,
    danger: true,
    confirmText: "重置",
  }))) return;
  const button = $("#chatroom-bulk-reset-context");
  setButtonBusy(button, true);
  try {
    const result = await api("/api/chatrooms/context-reset", { method: "POST", body: { targets } });
    state.chatrooms = result.chatrooms || state.chatrooms;
    renderChatrooms();
    refreshCurrentChatroomReference();
    toast(`已重置 ${result.reset} 个群聊的短期上下文`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
    button.disabled = state.selectedChatrooms.size === 0;
  }
}

function renderChatroomConfigPanel(bot, room) {
  const form = node("form", "chatroom-config-form");
  form.dataset.botId = bot.id;
  form.dataset.chatroomId = room.chatroomId;
  const label = inputControl("text", "chatroomLabel", room.label || room.title || "");
  label.required = false;
  label.placeholder = "群聊备注（可空）";
  const chatModel = document.createElement("select");
  chatModel.name = "chatModelProfileId";
  fillModelSelect(chatModel, room.chatModelProfileId, "继承 Bot 聊天模型");
  const visionModel = document.createElement("select");
  visionModel.name = "visionModelProfileId";
  fillModelSelect(visionModel, room.visionModelProfileId, "继承 Bot 视觉模型");
  const persona = document.createElement("select");
  persona.name = "personaProfileId";
  persona.append(
    option("", "继承 Bot 默认人设"),
    ...state.personas.filter((item) => item.enabled || item.id === room.personaProfileId)
      .map((item) => option(item.id, `${item.label}${item.enabled ? "" : "（已停用）"}`)),
  );
  persona.value = room.personaProfileId || "";
  const participationIntensity = document.createElement("select");
  participationIntensity.name = "participationIntensity";
  participationIntensity.append(
    option("conservative", "保守（少接话）"),
    option("standard", "标准"),
    option("active", "积极（多接话）"),
  );
  participationIntensity.value = room.participationIntensity || "standard";
  const voicePreset = document.createElement("select");
  voicePreset.name = "ttsPresetId";
  voicePreset.append(
    option("", `继承系统默认（${state.tts.defaultVoice}）`),
    ...state.tts.presets.map((preset) => option(preset.id, `${preset.label} · ${preset.voice}`)),
    option("__custom__", "自定义音色与表达提示词"),
  );
  const hasVoiceOverride = Boolean(room.ttsVoice || room.ttsStyle);
  voicePreset.value = !hasVoiceOverride ? "" : room.ttsPresetId || "__custom__";
  const ttsVoice = document.createElement("select");
  ttsVoice.name = "ttsVoice";
  ttsVoice.append(...state.tts.voices.map((voice) => option(voice, voice)));
  ttsVoice.value = room.ttsVoice || state.tts.defaultVoice;
  const ttsStyle = document.createElement("textarea");
  ttsStyle.name = "ttsStyle";
  ttsStyle.rows = 3;
  ttsStyle.maxLength = 200;
  ttsStyle.placeholder = "例如：年轻、温柔、令人愉悦，带自然笑意，感情丰富但不过度夸张";
  ttsStyle.value = room.ttsStyle || state.tts.defaultStyle;
  const syncVoiceControls = () => {
    const preset = state.tts.presets.find((item) => item.id === voicePreset.value);
    if (voicePreset.value === "") {
      ttsVoice.value = state.tts.defaultVoice;
      ttsStyle.value = state.tts.defaultStyle;
    } else if (preset) {
      ttsVoice.value = preset.voice;
      ttsStyle.value = preset.style;
    }
    const custom = voicePreset.value === "__custom__";
    ttsVoice.disabled = !custom;
    ttsStyle.disabled = !custom;
  };
  voicePreset.addEventListener("change", syncVoiceControls);
  syncVoiceControls();
  const selectedManagerIds = room.managerIds || [];
  const managers = document.createElement("select");
  managers.name = "managerIds";
  managers.multiple = true;
  const availableMembers = state.chatroomMembers.filter((member) => !member.isBot);
  managers.size = Math.min(8, Math.max(4, availableMembers.length));
  const knownManagerIds = new Set();
  for (const member of availableMembers) {
    const memberId = canonicalIdentity(member.id);
    knownManagerIds.add(memberId);
    const item = option(member.id, member.displayName || memberId);
    item.selected = selectedManagerIds.some((id) => canonicalIdentity(id) === memberId);
    managers.append(item);
  }
  for (const managerId of selectedManagerIds) {
    if (knownManagerIds.has(canonicalIdentity(managerId))) continue;
    const item = option(managerId, `${canonicalIdentity(managerId)}（当前未获取到昵称）`);
    item.selected = true;
    managers.append(item);
  }
  const selectedRedEnvelopeTargetIds = room.redEnvelopeTargetIds || [];
  const redEnvelopeTargets = document.createElement("select");
  redEnvelopeTargets.name = "redEnvelopeTargetIds";
  redEnvelopeTargets.multiple = true;
  redEnvelopeTargets.size = Math.min(8, Math.max(4, availableMembers.length));
  const knownTargetIds = new Set();
  for (const member of availableMembers) {
    const memberId = canonicalIdentity(member.id);
    knownTargetIds.add(memberId);
    const item = option(member.id, member.displayName || memberId);
    item.selected = selectedRedEnvelopeTargetIds.some((id) => canonicalIdentity(id) === memberId);
    redEnvelopeTargets.append(item);
  }
  for (const targetId of selectedRedEnvelopeTargetIds) {
    if (knownTargetIds.has(canonicalIdentity(targetId))) continue;
    const item = option(targetId, `${canonicalIdentity(targetId)}（当前未获取到昵称）`);
    item.selected = true;
    redEnvelopeTargets.append(item);
  }
  const pluginControls = CHATROOM_PLUGIN_TYPES.map(([type, title]) => {
    const current = room.plugins.find((plugin) => plugin.type === type) || {
      type,
      defaultEnabled: false,
      override: null,
      enabled: false,
    };
    const select = document.createElement("select");
    select.name = `plugin:${type}`;
    select.append(
      option("", `继承 Bot（${current.defaultEnabled ? "开启" : "关闭"}）`),
      option("enabled", "强制开启"),
      option("disabled", "强制关闭"),
    );
    select.value = current.override === null ? "" : current.override ? "enabled" : "disabled";
    return field(title, select);
  });
  const sessionRows = (room.bots || []).map((item) => node("div", "chatroom-session-row", [
    node("div", "chatroom-session-head", [
      node("strong", "", `${item.role === "primary" ? "主" : "备"}·${item.displayName}`),
      node("span", "meta", item.personaProfileId ? `人设 ${item.personaProfileId}` : "默认人设"),
    ]),
    node("code", "chatroom-session-id", item.sessionId || "尚未生成 Session ID"),
  ]));
  form.append(
    node("div", "chatroom-model-grid", [field("群聊备注", label), field("聊天模型", chatModel), field("视觉模型", visionModel), field("人设", persona), field("自动接话意愿", participationIntensity)]),
    node("p", "meta", "仅影响未点名时本地 Qwen 的接话判断。明确 @、引用和唤醒词始终正常回复；积极档也不会参与群友之间的私聊。"),
    node("div", "chatroom-voice-config", [
      node("div", "chatroom-model-grid", [
        field("默认语音角色", voicePreset),
        field("Gemini 音色", ttsVoice),
        field("表达风格提示词", ttsStyle),
      ]),
      node("p", "meta", "用于本群被动语音回复和自动语音接话。可选预设，也可自定义 200 字以内的语气、年龄感、情绪和节奏；只影响本群。"),
    ]),
    node("div", "chatroom-session-config", [
      node("div", "chatroom-session-title", [
        node("strong", "", "当前模型 Session ID"),
        node("span", "meta", "重置上下文或切换人设后，两个账号都会立即换成新的 Session。"),
      ]),
      ...sessionRows,
    ]),
    node("div", "chatroom-manager-config", [
      field("机器人管理白名单（可多选）", managers),
      node("p", "meta", "仅白名单成员和 Bot 全局操作员能执行切换人设、重置上下文等管理命令；所有群命令仍必须先 @机器人。"),
    ]),
    node("div", "chatroom-manager-config", [
      field("红包提醒成员（可多选）", redEnvelopeTargets),
      node("p", "meta", "同时将“红包提醒”插件设为开启后生效。普通红包会提醒所选成员；专属红包只提醒对应接收人。机器人只提醒，不会自动抢。"),
    ]),
    node("div", "chatroom-plugin-grid", pluginControls),
    node("div", "chatroom-actions", [
      actionButton("重置上下文", () => void resetOneChatroomContext(bot, room), false, "ghost"),
      actionButton("恢复全部继承", () => void resetChatroomOverride(bot, room), false, "ghost"),
      actionButton("保存并应用", () => {}, false, "primary"),
    ]),
  );
  form.querySelector(".chatroom-actions .primary").type = "submit";
  form.addEventListener("submit", saveChatroomOverride);
  $("#chatroom-tab-config").replaceChildren(form);
}

async function openChatroomDialog(bot, room) {
  state.currentChatroom = { bot, room };
  state.chatroomMessages = [];
  state.chatroomHasMore = false;
  state.chatroomHistoryLoaded = false;
  state.chatroomMemories = [];
  state.chatroomMembers = [];
  state.chatroomMemoryAudit = [];
  $("#chatroom-dialog-title").textContent = room.label || room.title || room.chatroomId;
  const agentMeta = room.bots?.length > 1
    ? room.bots.map((item) => `${item.role === "primary" ? "主" : "备"}：${item.displayName}（${item.healthy === true ? "在线" : item.healthy === false ? "离线" : "检测中"}）`).join(" · ")
    : `${bot.displayName} · ${bot.channel.type}`;
  $("#chatroom-dialog-meta").textContent = `${room.chatroomId} · ${agentMeta}`;
  renderChatroomConfigPanel(bot, room);
  renderCurrentChatroomTasks();
  $("#chatroom-memories-list").replaceChildren(loadingBlock("正在加载持久记忆……"));
  $("#chatroom-memory-count").textContent = "加载中";
  $("#chatroom-send-text").value = "";
  $("#chatroom-send-emoji-search").value = "";
  $("#chatroom-send-emoji-panel").open = false;
  state.selectedChatroomEmojiId = null;
  populateChatroomSendBots();
  renderChatroomSendEmojiPicker();
  syncChatroomSendMode();
  $("#chatroom-messages").replaceChildren(empty("切换到“历史与发送”后加载聊天记录。"));
  $("#chatroom-history-status").textContent = "";
  $("#chatroom-load-earlier").disabled = true;
  $("#chatroom-memory-form").reset();
  $("#chatroom-memory-form [name=kind]").value = "fact";
  $("#chatroom-memory-form [name=importance]").value = "0.7";
  toggleMemoryPersonField();
  await switchChatroomTab("config");
  $("#chatroom-dialog").showModal();
  await Promise.all([loadChatroomMemories(), loadChatroomSendEmojis()]);
}

function populateChatroomSendBots() {
  const current = state.currentChatroom;
  if (!current) return;
  const roomBots = current.room.bots?.length
    ? current.room.bots
    : (current.room.botIds || [current.bot.id]).map((id) => {
        const bot = state.bots.find((candidate) => candidate.id === id);
        return {
          id,
          displayName: bot?.displayName || id,
          channelType: bot?.channel.type || "unknown",
          role: id === current.bot.id ? "primary" : "backup",
          running: true,
          healthy: null,
        };
      });
  const select = $("#chatroom-send-bot");
  select.replaceChildren(...roomBots.map((item) => {
    const role = item.role === "primary" ? "主" : "备";
    const health = item.healthy === true ? "在线" : item.healthy === false ? "离线" : item.running === false ? "未运行" : "待检测";
    const entry = option(item.id, `${role} · ${item.displayName} · ${item.channelType} · ${health}`);
    entry.disabled = item.running === false;
    return entry;
  }));
  const preferred = roomBots.find((item) => item.healthy === true && item.running !== false) ??
    roomBots.find((item) => item.id === current.bot.id && item.running !== false) ??
    roomBots.find((item) => item.running !== false);
  if (preferred) select.value = preferred.id;
}

async function loadChatroomSendEmojis() {
  const current = state.currentChatroom;
  if (!current) return;
  try {
    const result = await api("/api/emojis");
    if (state.currentChatroom !== current) return;
    state.emojis = result.emojis || [];
    renderChatroomSendEmojiPicker();
  } catch (error) {
    $("#chatroom-send-emoji-picker").replaceChildren(empty(`表情包加载失败：${error.message}`));
  }
}

function renderChatroomSendEmojiPicker() {
  const container = $("#chatroom-send-emoji-picker");
  if (!container) return;
  const query = $("#chatroom-send-emoji-search").value.normalize("NFKC").trim().toLocaleLowerCase();
  const emojis = state.emojis.filter((emoji) =>
    emoji.status === "ready" && !emoji.isThinking &&
    (!query || emoji.description.normalize("NFKC").toLocaleLowerCase().includes(query)));
  if (!emojis.length) {
    container.replaceChildren(empty(state.emojis.length ? "没有匹配的可用表情包。" : "正在加载表情包库……"));
    return;
  }
  container.replaceChildren(...emojis.map((emoji) => {
    const owner = state.bots.find((bot) => bot.id === emoji.botId);
    const image = node("img", "chatroom-send-emoji-image");
    image.alt = emoji.description;
    image.loading = "lazy";
    void loadEmojiPreview(emoji.id, image);
    const card = node("button", `chatroom-send-emoji-card${state.selectedChatroomEmojiId === emoji.id ? " selected" : ""}`, [
      image,
      node("span", "chatroom-send-emoji-description", emoji.description),
      node("small", "meta", owner?.displayName || emoji.botId),
    ], { type: "button", title: emoji.description, "aria-pressed": state.selectedChatroomEmojiId === emoji.id ? "true" : "false" });
    card.addEventListener("click", () => selectChatroomSendEmoji(
      state.selectedChatroomEmojiId === emoji.id ? null : emoji.id,
    ));
    return card;
  }));
}

function selectChatroomSendEmoji(emojiId) {
  state.selectedChatroomEmojiId = emojiId;
  renderChatroomSendEmojiPicker();
  syncChatroomSendMode();
}

function syncChatroomSendMode() {
  const emoji = state.emojis.find((item) => item.id === state.selectedChatroomEmojiId);
  const textarea = $("#chatroom-send-text");
  textarea.disabled = Boolean(emoji);
  $("#chatroom-send-emoji-clear").hidden = !emoji;
  $("#chatroom-send-emoji-status").textContent = emoji ? `已选择：${emoji.description}` : "未选择表情包";
  const button = $("#chatroom-send-form button[type=submit]");
  button.textContent = emoji ? "发送表情包" : "发送到群聊";
}

async function switchChatroomTab(name) {
  $$(".chatroom-tab").forEach((button) => button.classList.toggle("active", button.dataset.chatroomTab === name));
  $$(".chatroom-tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `chatroom-tab-${name}`));
  if (name === "history") startChatroomHistoryPolling();
  else stopChatroomHistoryPolling();
  if (name === "history" && state.currentChatroom && !state.chatroomHistoryLoaded) {
    $("#chatroom-messages").replaceChildren(loadingBlock("正在加载聊天记录……"));
    await loadChatroomHistory(false);
    state.chatroomHistoryLoaded = true;
  }
  if (name === "wechat" && state.currentChatroom) await loadChatroomWechat();
}

function startChatroomHistoryPolling() {
  stopChatroomHistoryPolling();
  state.chatroomHistoryTimer = setInterval(() => void pollChatroomHistory(), 3000);
}

function stopChatroomHistoryPolling() {
  clearInterval(state.chatroomHistoryTimer);
  state.chatroomHistoryTimer = null;
}

async function pollChatroomHistory() {
  const current = state.currentChatroom;
  if (!current || !$("#chatroom-dialog").open) return stopChatroomHistoryPolling();
  if (!$("#chatroom-tab-history").classList.contains("active")) return;
  if (!state.chatroomHistoryLoaded) return;
  // A slow NAS/database read must not let the 3-second timer pile up more
  // requests. Those overlapping reads previously caused sporadic HTTP 408s
  // and made the send controls appear broken even though sending is separate.
  if (state.chatroomHistoryPolling) return;
  state.chatroomHistoryPolling = true;
  try {
    const result = await api(
      `/api/bots/${encodeURIComponent(current.bot.id)}/chatrooms/${encodeURIComponent(current.room.chatroomId)}/messages?limit=50`,
    );
    if (state.currentChatroom !== current) return;
    const known = new Set(state.chatroomMessages.filter((item) => !item.optimistic).map((item) => item.sequence));
    const fresh = (result.messages || []).filter((item) => !known.has(item.sequence));
    if (!fresh.length) return;
    state.chatroomMessages = [
      ...state.chatroomMessages.filter((item) =>
        !(item.optimistic && fresh.some((entry) => entry.direction === "outbound" && entry.text === item.text))),
      ...fresh,
    ];
    renderChatroomMessages({ preserveScroll: true });
    $("#chatroom-history-status").textContent = `${state.chatroomMessages.length} 条已加载`;
  } catch { /* 静默重试，下一轮再拉 */ }
  finally {
    state.chatroomHistoryPolling = false;
  }
}

function currentChatroomWechatBot() {
  const current = state.currentChatroom;
  if (!current) throw new Error("没有选中的群聊");
  const roomBotIds = current.room.botIds || [current.bot.id];
  const bot = state.bots.find((candidate) => roomBotIds.includes(candidate.id) && candidate.channel.type === "wechat-ipad");
  if (!bot) throw new Error("这个群没有可用的 iPad 协议机器人");
  return bot;
}

function currentWechatGroupBase() {
  const bot = currentChatroomWechatBot();
  return {
    bot,
    base: `/api/bots/${encodeURIComponent(bot.id)}/wechat/groups/${encodeURIComponent(state.currentChatroom.room.chatroomId)}`,
  };
}

async function loadChatroomWechat() {
  try {
    const { base } = currentWechatGroupBase();
    const result = await api(base);
    $("#chatroom-wechat-result").textContent = prettyProtocol({ details: result.details, members: result.members });
    $("#chatroom-group-nickname-status").textContent = result.capabilities.groupNicknameReason;
  } catch (error) {
    $("#chatroom-wechat-result").textContent = error.message;
    $("#chatroom-group-nickname-status").textContent = "原生群设置当前不可用。";
  }
}

async function saveChatroomWechatSetting(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const operation = form.elements.operation.value;
  const value = form.elements.value.value.trim();
  const labels = { remarks: "群备注", name: "群名称", announcement: "群公告" };
  if (operation === "name" && !value) return toast("群名称不能为空", true);
  if (!(await confirmDialog({
    title: `修改${labels[operation]}`,
    body: `确认手动修改${labels[operation]}？\n\n${value || "（清空）"}`,
  }))) return;
  try {
    const { base } = currentWechatGroupBase();
    await api(base, { method: "PATCH", body: { operation, value } });
    toast(`${labels[operation]}已修改`);
    await loadChatroomWechat();
  } catch (error) { toast(error.message, true); }
}

async function manageChatroomMembers(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const action = form.elements.action.value;
  const memberIds = delimitedList(form.elements.memberIds.value);
  if (!memberIds.length) return toast("至少填写一个成员 wxid", true);
  if (!(await confirmDialog({
    title: "群成员操作",
    body: `确认执行群成员操作“${action}”？\n\n${memberIds.join("\n")}`,
    danger: action === "remove",
  }))) return;
  try {
    const { base } = currentWechatGroupBase();
    await api(`${base}/members`, { method: "POST", body: { action, memberIds } });
    toast("群成员操作已提交");
    await loadChatroomWechat();
  } catch (error) { toast(error.message, true); }
}

async function manageChatroomAdmin() {
  const form = $("#chatroom-wechat-members-form");
  const action = form.elements.adminAction.value;
  const memberIds = delimitedList(form.elements.memberIds.value);
  if (!memberIds.length) return toast("请在成员 wxid 输入框填写目标成员", true);
  if (action === "transfer" && memberIds.length !== 1) return toast("转让群主只能填写一个成员", true);
  if (!(await confirmDialog({
    title: "群管理员操作",
    body: `高风险操作：确认执行“${action}”？\n\n${memberIds.join("\n")}`,
    danger: true,
    confirmText: "执行",
  }))) return;
  try {
    const { base } = currentWechatGroupBase();
    await api(`${base}/admin`, { method: "POST", body: { action, memberIds } });
    toast("群管理员操作已提交");
    await loadChatroomWechat();
  } catch (error) { toast(error.message, true); }
}

async function loadChatroomQrCode() {
  try {
    const { base } = currentWechatGroupBase();
    const result = await api(`${base}/qrcode`);
    renderProtocolImage($("#chatroom-wechat-result"), result.qrcode);
  } catch (error) { toast(error.message, true); }
}

function renderCurrentChatroomTasks() {
  const current = state.currentChatroom;
  if (!current) return;
  const roomBotIds = current.room.botIds || [current.bot.id];
  const tasks = state.scheduledTasks.filter((task) =>
    roomBotIds.includes(task.botId) && canonicalRoomId(task.conversationId) === canonicalRoomId(current.room.chatroomId));
  $("#chatroom-task-count").textContent = `${tasks.length} 个`;
  $("#chatroom-tasks-list").replaceChildren(...renderScheduledTaskRows(current.bot, current.room));
}

async function loadChatroomMemories() {
  const current = state.currentChatroom;
  if (!current) return;
  try {
    const result = await api(chatroomMemoryPath(current));
    state.chatroomMemories = result.memories || [];
    state.chatroomMembers = result.members || [];
    state.chatroomMemoryAudit = result.audit || [];
    renderChatroomConfigPanel(current.bot, current.room);
    renderChatroomMemories();
  } catch (error) {
    $("#chatroom-memory-count").textContent = "加载失败";
    $("#chatroom-memories-list").replaceChildren(empty(error.message));
  }
}

function renderChatroomMemories() {
  $("#chatroom-memory-count").textContent = `${state.chatroomMemories.length} 条`;
  const memberSelect = $("#chatroom-memory-form [name=personId]");
  const selected = memberSelect.value;
  memberSelect.replaceChildren(
    option("", "选择群友"),
    ...state.chatroomMembers.map((member) => option(member.id, member.displayName || canonicalIdentity(member.id))),
  );
  memberSelect.value = selected;
  const names = new Map(state.chatroomMembers.map((member) => [member.id, member.displayName]));
  const rows = state.chatroomMemories.map((memory) => {
    const scope = memory.scope === "conversation"
      ? "整个群聊"
      : (names.get(memory.scopeId) || canonicalIdentity(memory.scopeId));
    const expired = Boolean(memory.expiresAt && memory.expiresAt <= Date.now());
    const confirm = actionButton("确认有效", () => void confirmChatroomMemory(memory), expired, "ghost small");
    const renew = actionButton(expired ? "恢复并续期 1 年" : "续期 1 年", () => void renewChatroomMemory(memory), false, expired ? "primary small" : "ghost small");
    const remove = actionButton("删除", () => void deleteChatroomMemory(memory), false, "danger small");
    const status = expired
      ? node("span", "pill error", "已过期 · 不再召回")
      : memory.expiresAt
        ? node("span", "pill warn", `有效至 ${formatDate(memory.expiresAt)}`)
        : node("span", "pill healthy", "长期有效");
    return node("article", `memory-row${expired ? " expired" : ""}`, [
      node("div", "memory-row-meta", [
        node("span", memory.scope === "conversation" ? "pill healthy" : "pill muted", scope),
        status,
        node("span", "meta", `${memory.kind} · 重要度 ${memory.importance.toFixed(1)} · 上次确认 ${formatDate(memory.lastConfirmedAt || memory.updatedAt)}`),
      ]),
      node("div", "memory-row-content", memory.content),
      node("div", "memory-row-actions", [confirm, renew, remove]),
    ]);
  });
  $("#chatroom-memories-list").replaceChildren(...(rows.length ? rows : [empty("这个群还没有持久记忆。") ]));
  const auditRows = state.chatroomMemoryAudit
    .filter((entry) => entry.entityType === "memory")
    .map((entry) => node("div", "memory-audit-row", [
      node("span", "meta", formatDate(entry.createdAt)),
      node("strong", "", memoryAuditLabel(entry)),
      node("span", "meta", entry.reason || entry.afterValue || entry.beforeValue || entry.entityId),
    ]));
  $("#chatroom-memory-audit").replaceChildren(...(auditRows.length ? auditRows : [empty("暂无记忆操作记录。") ]));
}

function toggleMemoryPersonField() {
  const form = $("#chatroom-memory-form");
  const isPerson = form.elements.scope.value === "person";
  const field = form.querySelector(".memory-person-field");
  field.hidden = !isPerson;
  form.elements.personId.required = isPerson;
}

async function saveChatroomMemory(event) {
  event.preventDefault();
  const current = state.currentChatroom;
  const form = event.currentTarget;
  if (!current || !form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    const result = await api(chatroomMemoryPath(current), {
      method: "POST",
      body: {
        scope: form.elements.scope.value,
        ...(form.elements.scope.value === "person" ? { personId: form.elements.personId.value } : {}),
        kind: form.elements.kind.value,
        content: form.elements.content.value,
        importance: Number(form.elements.importance.value),
        ...(form.elements.expiresInDays.value
          ? { expiresInDays: Number(form.elements.expiresInDays.value) }
          : {}),
      },
    });
    state.chatroomMemories = result.memories || [];
    state.chatroomMembers = result.members || state.chatroomMembers;
    state.chatroomMemoryAudit = result.audit || state.chatroomMemoryAudit;
    form.elements.content.value = "";
    renderChatroomMemories();
    toast("持久记忆已新增");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function confirmChatroomMemory(memory) {
  const current = state.currentChatroom;
  if (!current) return;
  try {
    const result = await api(`${chatroomMemoryPath(current)}/${encodeURIComponent(memory.id)}`, {
      method: "PATCH",
      body: {},
    });
    state.chatroomMemories = result.memories || [];
    state.chatroomMemoryAudit = result.audit || [];
    renderChatroomMemories();
    toast("已确认记忆仍然有效");
  } catch (error) { toast(error.message, true); }
}

async function renewChatroomMemory(memory) {
  const current = state.currentChatroom;
  if (!current) return;
  try {
    const result = await api(`${chatroomMemoryPath(current)}/${encodeURIComponent(memory.id)}`, {
      method: "PATCH",
      body: { extendDays: 365 },
    });
    state.chatroomMemories = result.memories || [];
    state.chatroomMemoryAudit = result.audit || [];
    renderChatroomMemories();
    toast("记忆已确认并续期一年");
  } catch (error) { toast(error.message, true); }
}

async function deleteChatroomMemory(memory) {
  const current = state.currentChatroom;
  if (!current) return;
  if (!(await confirmDialog({
    title: "删除持久记忆",
    body: `确认删除这条持久记忆？\n\n${memory.content}`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    const result = await api(`${chatroomMemoryPath(current)}/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
    state.chatroomMemories = result.memories || [];
    state.chatroomMembers = result.members || state.chatroomMembers;
    state.chatroomMemoryAudit = result.audit || state.chatroomMemoryAudit;
    renderChatroomMemories();
    toast("持久记忆已删除并记录审计");
  } catch (error) { toast(error.message, true); }
}

function memoryAuditLabel(entry) {
  if (entry.action === "saved") return "新增";
  if (entry.action === "forgotten") return "删除";
  if (entry.action === "restored") return "恢复";
  if (entry.reason?.includes("有效期")) return "续期";
  if (entry.reason?.includes("确认")) return "确认";
  return "修正";
}

function chatroomMemoryPath(current) {
  return `/api/bots/${encodeURIComponent(current.bot.id)}/chatrooms/${encodeURIComponent(current.room.chatroomId)}/memories`;
}

async function loadChatroomHistory(earlier) {
  const current = state.currentChatroom;
  if (!current) return;
  const button = $("#chatroom-load-earlier");
  setButtonBusy(button, true);
  $("#chatroom-history-status").textContent = "加载中……";
  const firstSequence = earlier ? state.chatroomMessages[0]?.sequence : undefined;
  const query = new URLSearchParams({ limit: "50" });
  if (firstSequence) query.set("beforeSequence", String(firstSequence));
  try {
    const result = await api(
      `/api/bots/${encodeURIComponent(current.bot.id)}/chatrooms/${encodeURIComponent(current.room.chatroomId)}/messages?${query}`,
    );
    state.chatroomMessages = earlier
      ? [...(result.messages || []), ...state.chatroomMessages]
      : (result.messages || []);
    state.chatroomHasMore = result.hasMore === true;
    if (earlier) {
      const container = $("#chatroom-messages");
      const previousHeight = container.scrollHeight;
      const previousTop = container.scrollTop;
      renderChatroomMessages({ keepPosition: true });
      container.scrollTop = container.scrollHeight - previousHeight + previousTop;
    } else {
      renderChatroomMessages();
    }
    $("#chatroom-history-status").textContent = `${state.chatroomMessages.length} 条已加载`;
  } catch (error) {
    $("#chatroom-history-status").textContent = error.message;
    if (!earlier) $("#chatroom-messages").replaceChildren(empty("聊天记录加载失败。"));
  } finally {
    setButtonBusy(button, false);
    button.disabled = !state.chatroomHasMore;
  }
}

function renderChatroomMessages({ preserveScroll = false, keepPosition = false } = {}) {
  const container = $("#chatroom-messages");
  if (state.chatroomMessages.length === 0) {
    container.replaceChildren(empty("这个群还没有可显示的聊天记录。"));
    return;
  }
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  const previousTop = container.scrollTop;
  container.replaceChildren(...state.chatroomMessages.map((message) => {
    const item = node("article", `chat-message ${message.direction}${message.optimistic ? " pending" : ""}`);
    item.append(
      node("div", "chat-message-head", [
        node("strong", "", message.senderName || (message.direction === "outbound" ? "机器人" : canonicalIdentity(message.senderId))),
        node("span", "", `${formatDate(message.timestamp)}${message.optimistic ? " · 发送中" : ""}`),
      ]),
      node("div", "chat-message-text", message.text || "[非文本消息]"),
    );
    return item;
  }));
  if (keepPosition) return;
  if (preserveScroll && !nearBottom) container.scrollTop = previousTop;
  else container.scrollTop = container.scrollHeight;
}

async function sendChatroomMessage(event) {
  event.preventDefault();
  // currentTarget is cleared by the browser as soon as event dispatch ends.
  // Capture the form before awaiting the confirmation dialog; otherwise both
  // text and emoji sends throw before the POST request is ever created.
  const form = event.currentTarget;
  const current = state.currentChatroom;
  if (!current) return;
  const text = $("#chatroom-send-text").value.trim();
  const emoji = state.emojis.find((item) => item.id === state.selectedChatroomEmojiId);
  if (!text && !emoji) return toast("请输入文字或选择一个表情包", true);
  const selectedBotId = $("#chatroom-send-bot").value;
  const selectedBot = state.bots.find((bot) => bot.id === selectedBotId);
  if (!selectedBot) return toast("请选择发送机器人", true);
  const targetName = current.room.label || current.room.title || current.room.chatroomId;
  if (!(await confirmDialog({
    title: emoji ? "发送表情包" : "发送群消息",
    body: emoji
      ? `确认让“${selectedBot.displayName}”向“${targetName}”发送这个表情包？\n\n${emoji.description}`
      : `确认让“${selectedBot.displayName}”向“${targetName}”发送这条消息？\n\n${text}`,
  }))) return;
  const button = form.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    const result = await api(
      `/api/bots/${encodeURIComponent(selectedBot.id)}/chatrooms/${encodeURIComponent(current.room.chatroomId)}/send`,
      { method: "POST", body: emoji ? { emojiId: emoji.id } : { text } },
    );
    $("#chatroom-send-text").value = "";
    selectChatroomSendEmoji(null);
    state.chatroomMessages = [...state.chatroomMessages, {
      direction: "outbound",
      senderName: selectedBot.displayName,
      text: emoji ? `[表情包] ${emoji.description}` : text,
      timestamp: Date.now(),
      optimistic: true,
    }];
    renderChatroomMessages();
    $("#chatroom-history-status").textContent = `${state.chatroomMessages.length} 条已加载`;
    toast(result.delivered > 0
      ? `${emoji ? "表情包" : "消息"}已由 ${selectedBot.displayName} 发送到群聊`
      : `${emoji ? "表情包" : "消息"}已进入 ${selectedBot.displayName} 的发送队列`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function saveChatroomOverride(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const pluginOverrides = CHATROOM_PLUGIN_TYPES.flatMap(([type]) => {
    const value = form.elements[`plugin:${type}`].value;
    return value ? [{ pluginType: type, enabled: value === "enabled" }] : [];
  });
  const button = form.querySelector('button[type="submit"]');
  const selectedVoicePreset = form.elements.ttsPresetId.value;
  const voicePreset = state.tts.presets.find((item) => item.id === selectedVoicePreset);
  const ttsVoice = selectedVoicePreset === ""
    ? null
    : voicePreset?.voice || form.elements.ttsVoice.value || state.tts.defaultVoice;
  const ttsStyle = selectedVoicePreset === ""
    ? null
    : voicePreset?.style || form.elements.ttsStyle.value.trim();
  if (selectedVoicePreset === "__custom__" && !ttsStyle) {
    toast("请输入自定义语音表达风格", true);
    return;
  }
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/bots/${encodeURIComponent(form.dataset.botId)}/chatrooms`, {
      method: "PUT",
      body: {
        chatroomId: form.dataset.chatroomId,
        label: form.elements.chatroomLabel.value || undefined,
        chatModelProfileId: form.elements.chatModelProfileId.value || null,
        visionModelProfileId: form.elements.visionModelProfileId.value || null,
        personaProfileId: form.elements.personaProfileId.value || null,
        ttsVoice,
        ttsStyle,
        participationIntensity: form.elements.participationIntensity.value,
        managerIds: [...form.elements.managerIds.selectedOptions].map((item) => item.value),
        redEnvelopeTargetIds: [...form.elements.redEnvelopeTargetIds.selectedOptions].map((item) => item.value),
        pluginOverrides,
      },
    });
    state.chatrooms = result.chatrooms || state.chatrooms;
    toast(result.contextReset ? "群聊配置已保存；人设变化，短期上下文已自动重置" : "群聊配置已保存并应用");
    await reloadConfiguration();
    refreshCurrentChatroomReference();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function resetOneChatroomContext(bot, room) {
  const name = room.label || room.title || room.chatroomId;
  if (!(await confirmDialog({
    title: "重置群聊上下文",
    body: `确认重置“${name}”的短期上下文？完整聊天记录和长期记忆仍会保留。`,
    danger: true,
    confirmText: "重置",
  }))) return;
  try {
    const result = await api("/api/chatrooms/context-reset", {
      method: "POST",
      body: { targets: [{ botId: bot.id, chatroomId: room.chatroomId }] },
    });
    state.chatrooms = result.chatrooms || state.chatrooms;
    refreshCurrentChatroomReference();
    toast(result.reset === 1 ? "该群短期上下文已重置" : "没有需要重置的群聊");
  } catch (error) {
    toast(error.message, true);
  }
}

async function resetChatroomOverride(bot, room) {
  if (!(await confirmDialog({
    title: "恢复全部继承",
    body: `确认让“${room.label || room.title || room.chatroomId}”恢复继承 ${bot.displayName} 的全部默认配置？`,
  }))) return;
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/chatrooms?chatroomId=${encodeURIComponent(room.chatroomId)}`, { method: "DELETE" });
    state.chatrooms = result.chatrooms || state.chatrooms;
    toast("群聊已恢复全部继承");
    await reloadConfiguration();
    refreshCurrentChatroomReference();
  } catch (error) {
    toast(error.message, true);
  }
}

function refreshCurrentChatroomReference() {
  const current = state.currentChatroom;
  if (!current) return;
  const bot = state.bots.find((item) => item.id === current.bot.id);
  const room = state.chatrooms.find((item) =>
    canonicalRoomId(item.chatroomId) === canonicalRoomId(current.room.chatroomId));
  if (!bot || !room) return;
  const primaryBot = state.bots.find((item) => item.id === room.botId) || bot;
  state.currentChatroom = { bot: primaryBot, room };
  renderChatroomConfigPanel(primaryBot, room);
  renderCurrentChatroomTasks();
}

function renderScheduledTaskRows(bot, room) {
  const roomBotIds = room.botIds || [bot.id];
  const tasks = state.scheduledTasks.filter((task) =>
    roomBotIds.includes(task.botId) && canonicalRoomId(task.conversationId) === canonicalRoomId(room.chatroomId));
  if (tasks.length === 0) return [empty("本群还没有任务。群友需显式 @机器人，并说明时间和任务内容后创建。")];
  return tasks.map((task) => {
    const row = node("div", "scheduled-task-row");
    row.dataset.taskId = task.id;
    row.dataset.timezoneOffsetMinutes = task.timezoneOffsetMinutes;
    const title = inputControl("text", "taskTitle", task.title);
    const content = document.createElement("textarea");
    content.name = "taskContent";
    content.rows = 2;
    content.value = task.content;
    const scheduleType = document.createElement("select");
    scheduleType.name = "taskScheduleType";
    scheduleType.append(option("once", "仅一次"), option("daily", "每天"), option("weekly", "每周"));
    scheduleType.value = task.schedule.type;
    const onceAt = inputControl("datetime-local", "taskRunAt", task.schedule.type === "once"
      ? timestampToLocalInput(task.schedule.runAt, task.timezoneOffsetMinutes)
      : "");
    onceAt.required = false;
    const localTime = inputControl("time", "taskLocalTime", task.schedule.type === "once" ? "08:00" : minuteToTime(task.schedule.minute));
    localTime.required = false;
    const weekdays = inputControl("text", "taskWeekdays", task.schedule.type === "weekly" ? task.schedule.weekdays.join(",") : "");
    weekdays.required = false;
    weekdays.placeholder = "0,1,2… 0 代表周日";
    const enabled = checkboxControl("启用", "taskEnabled", task.enabled);
    const scheduleFields = node("div", "scheduled-task-schedule", [
      field("类型", scheduleType),
      field("一次性时间", onceAt),
      field("每天/每周时间", localTime),
      field("每周日期", weekdays),
    ]);
    const refreshVisibility = () => {
      onceAt.closest("label").hidden = scheduleType.value !== "once";
      localTime.closest("label").hidden = scheduleType.value === "once";
      weekdays.closest("label").hidden = scheduleType.value !== "weekly";
    };
    scheduleType.addEventListener("change", refreshVisibility);
    const save = actionButton("保存任务", () => void saveScheduledTaskRow(row), false, "primary small");
    const remove = actionButton("删除", () => void deleteScheduledTaskRow(task), false, "danger small");
    row.append(
      node("div", "scheduled-task-meta", [
        node("span", "pill muted", task.conversationTitle || task.conversationId),
        node("span", "meta", `创建人 ${task.creatorName} · 下次 ${task.nextRunAt ? formatDate(task.nextRunAt) : "无"} · ${taskStatusLabel(task.lastStatus)}`),
      ]),
      node("div", "scheduled-task-main", [field("标题", title), field("运行内容", content)]),
      scheduleFields,
      node("div", "scheduled-task-actions", [enabled, save, remove]),
    );
    refreshVisibility();
    return row;
  });
}

async function saveScheduledTaskRow(row) {
  const type = row.querySelector('[name="taskScheduleType"]').value;
  const timezoneOffsetMinutes = Number(row.dataset.timezoneOffsetMinutes);
  let schedule;
  if (type === "once") {
    const value = row.querySelector('[name="taskRunAt"]').value;
    if (!value) return toast("请选择一次性运行时间", true);
    schedule = { type, runAt: localInputToTimestamp(value, timezoneOffsetMinutes) };
  } else if (type === "daily") {
    schedule = { type, minute: timeToMinute(row.querySelector('[name="taskLocalTime"]').value) };
  } else {
    const weekdays = delimitedList(row.querySelector('[name="taskWeekdays"]').value).map(Number);
    schedule = { type, minute: timeToMinute(row.querySelector('[name="taskLocalTime"]').value), weekdays };
  }
  try {
    await api(`/api/scheduled-tasks/${encodeURIComponent(row.dataset.taskId)}`, {
      method: "PUT",
      body: {
        title: row.querySelector('[name="taskTitle"]').value,
        content: row.querySelector('[name="taskContent"]').value,
        enabled: row.querySelector('[name="taskEnabled"]').checked,
        timezoneOffsetMinutes,
        schedule,
      },
    });
    toast("定时任务已更新");
    await reloadConfiguration();
    renderCurrentChatroomTasks();
  } catch (error) { toast(error.message, true); }
}

async function deleteScheduledTaskRow(task) {
  if (!(await confirmDialog({
    title: "删除定时任务",
    body: `确认删除“${task.title}”？`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/scheduled-tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    toast("定时任务已删除");
    await reloadConfiguration();
    renderCurrentChatroomTasks();
  } catch (error) { toast(error.message, true); }
}

function canonicalRoomId(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase().split(":").at(-1) || "";
}

function canonicalIdentity(value) {
  return String(value || "").normalize("NFKC").trim().split(":").at(-1) || String(value || "");
}

function inputControl(type, name, value, attributes = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.value = value;
  input.required = true;
  Object.entries(attributes).forEach(([key, item]) => input.setAttribute(key, item));
  return input;
}

function checkboxControl(labelText, name, checked) {
  const label = node("label", "check plugin-check");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.checked = checked;
  label.append(input, labelText);
  return label;
}

function renderOverview() {
  if (!state.status) return;
  const online = state.status.bots.filter((bot) => botAvailabilityPhase(bot) === "running").length;
  const totals = state.status.bots.reduce((sum, bot) => {
    Object.keys(sum).forEach((key) => { sum[key] += Number(bot.metrics[key] || 0); });
    return sum;
  }, {
    agentRuns: 0,
    replies: 0,
    totalAgentDurationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    fallbackHops: 0,
  });
  const replyRate = totals.agentRuns ? totals.replies / totals.agentRuns : 0;
  const averageLatency = totals.agentRuns ? totals.totalAgentDurationMs / totals.agentRuns : 0;
  const stats = [
    ["在线", `${online}/${state.status.bots.length}`],
    ["Agent 回复率", formatPercent(replyRate)],
    ["平均耗时", averageLatency ? formatDuration(averageLatency) : "—"],
    ["LLM 调用", formatCompactNumber(totals.llmCalls)],
    ["工具调用", formatCompactNumber(totals.toolCalls)],
    ["输入 / 输出 Token", `${formatCompactNumber(totals.inputTokens)} / ${formatCompactNumber(totals.outputTokens)}`],
    ["估算模型成本", formatUsd(totals.estimatedCostUsd)],
    ["降级跳数", formatCompactNumber(totals.fallbackHops)],
  ];
  const statsContainer = $("#overview-stats");
  if (statsContainer.childElementCount === stats.length) {
    stats.forEach(([, value], index) => {
      statsContainer.children[index].querySelector("strong").textContent = String(value);
    });
  } else {
    statsContainer.replaceChildren(...stats.map(([label, value]) => node("div", "stat", [node("span", "", label), node("strong", "", String(value))])));
  }
  renderOverviewModelChains();
  renderOverviewQuality();
  const botsContainer = $("#overview-bots");
  const existing = [...botsContainer.children];
  const sameStructure = state.status.bots.length > 0 && existing.length === state.status.bots.length &&
    state.status.bots.every((bot, index) => existing[index]?.dataset?.botId === bot.id);
  if (sameStructure) {
    state.status.bots.forEach((bot, index) => updateBotStatusCard(existing[index], bot));
    return;
  }
  const cards = state.status.bots.map(botStatusCard);
  botsContainer.replaceChildren(...(cards.length ? cards : [empty("尚未配置机器人") ]));
}

function renderOverviewModelChains() {
  const statuses = new Map((state.status?.bots || []).map((item) => [item.id, item]));
  const rows = state.bots.map((bot) => {
    const chain = configuredModelChain(bot);
    const status = statuses.get(bot.id);
    const stages = chain.stages.length
      ? chain.stages.flatMap((stage, index) => [
          ...(index ? [node("span", "model-chain-arrow", "→")] : []),
          node("span", `model-stage ${stage.kind}`, [
            node("strong", "", stage.label),
            node("small", "", stage.detail),
          ]),
        ])
      : [node("span", "pill error", "未配置聊天模型")];
    const notices = [];
    if (chain.fastModel) {
      const fastIsGemini = modelCategory(chain.fastModel) === "gemini";
      notices.push(node(
        "span",
        `pill ${fastIsGemini ? "healthy" : "warn"}`,
        `简单任务：${chain.fastModel.label}${fastIsGemini ? "" : "（非 Gemini）"}`,
      ));
    }
    if (chain.judgeModel) {
      notices.push(node(
        "span",
        "pill healthy",
        `接话判断：${chain.judgeModel.label}（不参与最终回复）`,
      ));
    } else {
      notices.push(node("span", "pill warn", "未配置独立接话判断模型"));
    }
    if (!chain.hasGeminiPrimary) notices.push(node("span", "pill warn", "建议以 Gemini 为主模型"));
    if (!chain.hasRemoteFallback) notices.push(node("span", "pill warn", "未配置 GPT/远程降级"));
    if (!chain.hasLocalFallback) notices.push(node("span", "pill muted", "最终回复无本地模型"));
    const actual = status?.metrics?.lastModelRoute?.length
      ? `最近实际路径：${status.metrics.lastModelRoute.join(" → ")}`
      : "尚无本次进程内的模型调用记录";
    return node("article", "model-chain-row", [
      node("div", "model-chain-head", [node("strong", "", bot.displayName), node("span", "meta", bot.id)]),
      node("div", "model-chain", stages),
      node("div", "model-chain-notices", notices),
      node("div", "meta", actual),
    ]);
  });
  $("#overview-model-chains").replaceChildren(...(rows.length ? rows : [empty("尚未配置机器人。") ]));
}

function renderOverviewQuality() {
  const summaries = Object.values(state.qualitySummaries);
  const totals = summaries.reduce((sum, summary) => {
    Object.keys(sum).forEach((key) => { sum[key] += Number(summary[key] || 0); });
    return sum;
  }, { total: 0, unrated: 0, speak: 0, silent: 0, unsure: 0, helpful: 0, unhelpful: 0, qualityUnsure: 0 });
  const qualityRated = totals.helpful + totals.unhelpful;
  const participationRated = totals.speak + totals.silent + totals.unsure;
  const helpfulRate = qualityRated ? totals.helpful / qualityRated : 0;
  const ratedRate = totals.total ? participationRated / totals.total : 0;
  $("#overview-quality").replaceChildren(
    node("div", "quality-score", [
      node("strong", "", qualityRated ? formatPercent(helpfulRate) : "—"),
      node("span", "meta", `有帮助率 · ${qualityRated} 条已评价回复`),
    ]),
    node("div", "quality-bar", [
      node("span", "quality-bar-helpful", "", { style: `width:${Math.round(helpfulRate * 100)}%` }),
    ]),
    node("div", "quality-breakdown", [
      metric(totals.helpful, "有帮助"),
      metric(totals.unhelpful, "需改进"),
      metric(totals.unrated, "待评参与时机"),
      metric(formatPercent(ratedRate), "参与评分覆盖"),
    ]),
  );
}

function botCardDetails(bot) {
  const gateway = bot.gatewayHealthy === true ? "连接正常" : bot.gatewayHealthy === false ? "账号/网关离线" : "连接未检查";
  return `${gateway} · pending ${bot.pendingOutbox} · ${bot.chatModel || "未加载模型"}`;
}

function botCardMetrics(bot) {
  const average = bot.metrics.agentRuns ? bot.metrics.totalAgentDurationMs / bot.metrics.agentRuns : 0;
  return [
    [bot.metrics.inboundMessages, "入站"],
    [bot.metrics.replies, "回复"],
    [bot.metrics.llmCalls, "LLM"],
    [bot.metrics.toolCalls, "工具"],
    [average ? formatDuration(average) : "—", "平均耗时"],
    [formatUsd(bot.metrics.estimatedCostUsd), "估算成本"],
  ];
}

function botStatusCard(bot) {
  const card = node("article", "bot-card");
  card.dataset.botId = bot.id;
  const pill = phasePill(botAvailabilityPhase(bot));
  pill.dataset.role = "phase";
  const head = node("div", "bot-card-head", [
    node("div", "", [node("h3", "", bot.displayName), node("div", "meta", bot.id)]),
    pill,
  ]);
  const details = node("div", "meta", botCardDetails(bot));
  details.dataset.role = "details";
  const metrics = node("div", "metric-row", botCardMetrics(bot).map(([value, label]) => metric(value, label)));
  const routeText = bot.metrics.lastModelRoute?.length ? `最近：${bot.metrics.lastModelRoute.join(" → ")}` : "";
  const route = node("div", "bot-route meta", routeText);
  route.dataset.role = "route";
  route.hidden = !routeText;
  card.append(head, details, route, metrics);
  return card;
}

function updateBotStatusCard(card, bot) {
  const pill = phasePill(botAvailabilityPhase(bot));
  pill.dataset.role = "phase";
  card.querySelector('[data-role="phase"]')?.replaceWith(pill);
  const details = card.querySelector('[data-role="details"]');
  if (details) details.textContent = botCardDetails(bot);
  const route = card.querySelector('[data-role="route"]');
  if (route) {
    const routeText = bot.metrics.lastModelRoute?.length ? `最近：${bot.metrics.lastModelRoute.join(" → ")}` : "";
    route.textContent = routeText;
    route.hidden = !routeText;
  }
  const cells = card.querySelectorAll(".metric-row strong");
  botCardMetrics(bot).forEach(([value], index) => {
    if (cells[index]) cells[index].textContent = String(value);
  });
}

function renderBots() {
  const statuses = new Map((state.status?.bots || []).map((item) => [item.id, item]));
  const container = $("#bots-list");
  const existing = [...container.children];
  const sameStructure = state.bots.length > 0 && existing.length === state.bots.length &&
    state.bots.every((bot, index) => existing[index]?.dataset?.botId === bot.id);
  if (sameStructure) {
    state.bots.forEach((bot, index) => updateBotCard(existing[index], bot, statuses.get(bot.id)));
    return;
  }
  const cards = state.bots.map((bot) => renderBotCard(bot, statuses.get(bot.id)));
  container.replaceChildren(...(cards.length ? cards : [empty("还没有机器人，先配置模型，再新增机器人。") ]));
}

function botConfigSignature(bot) {
  return JSON.stringify([bot.enabled, bot.displayName, bot.identityId, bot.channel, bot.chatroomModelOverrides?.length || 0]);
}

function renderBotCard(bot, status) {
  const card = node("article", "list-card");
  card.dataset.botId = bot.id;
  card.dataset.configSig = botConfigSignature(bot);
  const pill = phasePill(botAvailabilityPhase(status));
  pill.dataset.role = "phase";
  const identity = node("div", "", [
    node("div", "list-card-head", [node("div", "", [node("h2", "", bot.displayName), node("div", "meta", `${bot.id} · ${bot.identityId}`)]), pill]),
  ]);
  const channelSummary = bot.channel.type === "wechat-ipad"
    ? [
        node("div", "", `wechat-ipad · ${bot.channel.accountWxid}`),
        node("div", "", bot.channel.apiBaseUrl),
        node("div", "", `Callback ${bot.channel.callbackHost}:${bot.channel.callbackPort}${bot.channel.callbackPathPrefix}/…/sync-message`),
      ]
    : [
        node("div", "", "wx-hook-http"),
        node("div", "", bot.channel.gatewayBaseUrl),
        node("div", "", `Webhook ${bot.channel.webhookHost}:${bot.channel.webhookPort}${bot.channel.webhookPath}`),
      ];
  const statusLine = node("div", "", status?.lastError || status?.chatModel || "未启动");
  statusLine.dataset.role = "status";
  const channel = node("div", "meta", [
    ...channelSummary,
    node("div", "", `群聊模型覆盖 ${bot.chatroomModelOverrides?.length || 0} 条`),
    statusLine,
  ]);
  const actions = node("div", "actions");
  const requiresRunning = (button) => { button.dataset.requiresRunning = "1"; return button; };
  actions.append(
    actionButton("编辑", () => openBotForm(bot)),
    actionButton(bot.enabled ? "停止" : "启动", () => botAction(bot.id, bot.enabled ? "stop" : "start")),
    actionButton("重启", () => botAction(bot.id, "restart"), !bot.enabled),
    requiresRunning(actionButton("网关", () => botAction(bot.id, "gateway-check"), status?.phase !== "running")),
    requiresRunning(actionButton("注册回调", () => registerWebhook(bot), status?.phase !== "running")),
  );
  if (bot.channel.type === "wx-hook-http") {
    actions.append(requiresRunning(actionButton("Webhook", () => botAction(bot.id, "webhook-test"), status?.phase !== "running")));
  } else {
    actions.append(actionButton("微信登录", () => void openIpadLogin(bot), false, "login-button"));
  }
  actions.append(actionButton("删除", () => deleteBot(bot), false, "danger"));
  card.append(identity, channel, actions);
  return card;
}

function updateBotCard(card, bot, status) {
  if (card.dataset.configSig !== botConfigSignature(bot)) {
    card.replaceWith(renderBotCard(bot, status));
    return;
  }
  const pill = phasePill(botAvailabilityPhase(status));
  pill.dataset.role = "phase";
  card.querySelector('[data-role="phase"]')?.replaceWith(pill);
  const statusLine = card.querySelector('[data-role="status"]');
  if (statusLine) statusLine.textContent = status?.lastError || status?.chatModel || "未启动";
  const running = status?.phase === "running";
  card.querySelectorAll('[data-requires-running]').forEach((button) => {
    if (!button.dataset.busy) button.disabled = !running;
  });
}

async function openIpadLogin(bot) {
  stopIpadLoginPolling();
  state.ipadLoginBot = bot;
  state.ipadLoginStatus = null;
  state.ipadLoginSynced = false;
  $("#ipad-login-title").textContent = `${bot.displayName} · 微信登录`;
  $("#ipad-login-subtitle").textContent = `${bot.id} · wechat-ipad`;
  $("#ipad-slider-frame").hidden = true;
  $("#ipad-slider-frame").src = "about:blank";
  renderIpadLogin({ phase: "offline", sliderAvailable: false, message: "正在检查当前登录态…" }, true);
  $("#ipad-login-dialog").showModal();
  await refreshIpadLogin();
}

async function refreshIpadLogin() {
  const bot = state.ipadLoginBot;
  if (!bot || !$("#ipad-login-dialog").open) return;
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/login`);
    await acceptIpadLoginStatus(result.login);
  } catch (error) {
    renderIpadLogin({ phase: "error", sliderAvailable: false, message: error.message });
  }
}

async function startIpadLogin() {
  const bot = state.ipadLoginBot;
  if (!bot) return;
  const button = $("#ipad-login-start");
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/login/qr`, {
      method: "POST",
      body: { loginType: $("#ipad-login-type").value },
    });
    await acceptIpadLoginStatus(result.login);
  } catch (error) {
    toast(error.message, true);
    renderIpadLogin({ phase: "error", sliderAvailable: false, message: error.message });
  } finally {
    setButtonBusy(button, false);
  }
}

async function pollIpadLogin() {
  const bot = state.ipadLoginBot;
  if (!bot || !$("#ipad-login-dialog").open) return;
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/login/poll`, { method: "POST" });
    await acceptIpadLoginStatus(result.login);
  } catch (error) {
    renderIpadLogin({ phase: "error", sliderAvailable: false, message: error.message });
  }
}

async function submitIpadSecurityCode(event) {
  event.preventDefault();
  const bot = state.ipadLoginBot;
  if (!bot) return;
  const code = $("#ipad-security-code").value.trim();
  if (!/^\d{6}$/.test(code)) {
    toast("请输入手机显示的六位安全码", true);
    return;
  }
  const button = event.currentTarget.querySelector("button");
  setButtonBusy(button, true);
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/login/security-code`, {
      method: "POST",
      body: { code },
    });
    $("#ipad-security-code").value = "";
    await acceptIpadLoginStatus(result.login);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonBusy(button, false);
  }
}

async function openIpadSlider() {
  const bot = state.ipadLoginBot;
  if (!bot) return;
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/login/slider`, { method: "POST" });
    const frame = $("#ipad-slider-frame");
    frame.src = result.url;
    frame.hidden = false;
    frame.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    toast(error.message, true);
  }
}

async function cancelIpadLogin() {
  const bot = state.ipadLoginBot;
  if (!bot) return;
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/login/session`, { method: "DELETE" });
    stopIpadLoginPolling();
    renderIpadLogin(result.login);
  } catch (error) {
    toast(error.message, true);
  }
}

async function acceptIpadLoginStatus(login) {
  state.ipadLoginStatus = login;
  renderIpadLogin(login);
  stopIpadLoginPolling();
  if (["qr", "scanned", "verification", "waiting-confirmation"].includes(login.phase)) {
    state.ipadLoginTimer = setTimeout(() => void pollIpadLogin(), login.phase === "verification" ? 4500 : 3000);
  }
  if (login.phase === "online" && !state.ipadLoginSynced) {
    state.ipadLoginSynced = true;
    toast(`${login.nickname || login.accountWxid || "微信"} 已在线`);
    await reloadConfiguration();
  }
}

function renderIpadLogin(login, checking = false) {
  const phaseLabels = {
    offline: checking ? "检查中" : "未登录",
    qr: "待扫码",
    scanned: "待确认",
    verification: "安全验证",
    "waiting-confirmation": "等待手机确认",
    online: "在线",
    expired: "已过期",
    error: "异常",
  };
  const pillKinds = {
    online: "healthy",
    qr: "starting",
    scanned: "starting",
    verification: "warn",
    "waiting-confirmation": "starting",
    expired: "error",
    error: "error",
    offline: checking ? "starting" : "muted",
  };
  const phase = login.phase || "offline";
  const phasePill = $("#ipad-login-phase");
  phasePill.textContent = phaseLabels[phase] || phase;
  phasePill.className = `pill ${pillKinds[phase] || "muted"}`;
  $("#ipad-login-account").textContent = login.nickname || login.accountWxid || state.ipadLoginBot?.channel.accountWxid || "未登录账号";
  $("#ipad-login-message").textContent = login.message || "";

  const avatar = $("#ipad-login-avatar");
  if (login.headImageUrl) {
    avatar.style.backgroundImage = `url(${JSON.stringify(login.headImageUrl).slice(1, -1)})`;
    avatar.textContent = "";
  } else {
    avatar.style.backgroundImage = "";
    avatar.textContent = (login.nickname || "微").slice(0, 1);
  }

  const activeQr = ["qr", "scanned", "verification", "waiting-confirmation"].includes(phase);
  const qrPanel = $("#ipad-login-qr-panel");
  qrPanel.hidden = !activeQr;
  const qrImage = $("#ipad-login-qr");
  qrImage.hidden = !login.qrImage;
  if (login.qrImage) qrImage.src = login.qrImage;
  const qrLink = $("#ipad-login-qr-link");
  qrLink.hidden = !login.qrContent || Boolean(login.qrImage);
  if (login.qrContent) qrLink.href = login.qrContent;
  $("#ipad-login-countdown").textContent = phase === "scanned"
    ? "已扫码，请在手机上确认"
    : phase === "verification"
      ? "需要完成安全验证"
      : `二维码剩余 ${login.expiresInSeconds ?? "—"} 秒`;

  $("#ipad-login-start-panel").hidden = !["offline", "expired", "error"].includes(phase) || checking;
  $("#ipad-login-verify-panel").hidden = phase !== "verification";
  const slider = $("#ipad-login-slider");
  slider.disabled = !login.sliderAvailable;
  slider.textContent = login.sliderAvailable ? "打开滑块验证" : "滑块令牌不可用，请使用六位安全码";
  $("#ipad-login-cancel").hidden = phase === "online" || checking;
}

function stopIpadLoginPolling() {
  clearTimeout(state.ipadLoginTimer);
  state.ipadLoginTimer = null;
  if (!$("#ipad-login-dialog").open) {
    state.ipadLoginBot = null;
    state.ipadLoginStatus = null;
  }
}

function renderProviders() {
  const cards = state.providerProfiles.map((provider) => {
    const card = node("article", "list-card");
    const title = node("div", "", [node("h2", "", provider.label), node("div", "meta", provider.id)]);
    const credential = provider.hasApiKey
      ? "API Key 已加密保存"
      : provider.apiKeyEnv
        ? `环境变量 ${provider.apiKeyEnv}`
        : "未配置 API Key";
    const meta = node("div", "meta", [
      node("div", "", `${provider.provider} · ${providerApiLabel(provider.api)}`),
      node("div", "", provider.baseUrl || "使用 Provider 默认地址"),
      node("div", "", `${credential} · ${provider.enabled ? "已启用" : "已停用"}`),
    ]);
    const actions = node("div", "actions", [
      actionButton("测试/拉取", () => void probeSavedProvider(provider)),
      actionButton("编辑", () => openProviderForm(provider)),
      actionButton("删除", () => deleteProvider(provider), false, "danger"),
    ]);
    card.append(title, meta, actions);
    return card;
  });
  $("#providers-list").replaceChildren(...(cards.length ? cards : [empty("尚未配置 Provider。先录入 API Key，再创建模型。") ]));
}

function renderModels() {
  const cards = state.models.map((model) => {
    const provider = state.providerProfiles.find((item) => item.id === model.providerProfileId);
    const card = node("article", "list-card");
    const title = node("div", "", [node("h2", "", model.label), node("div", "meta", model.id)]);
    const meta = node("div", "meta", [
      node("div", "", `${provider?.provider || "未知 Provider"}/${model.modelId}`),
      node("div", "", `${provider?.label || model.providerProfileId} · ${modelApiLabel(model.api, provider?.api)} · thinking ${model.thinkingLevel}`),
      node("div", "", `${model.input.join("+")} · ctx ${model.contextWindow} · max ${model.maxTokens}`),
      node("div", "", model.enabled ? "已启用" : "已停用"),
    ]);
    const actions = node("div", "actions", [
      actionButton("文本测试", () => void testSavedModel(model, false)),
      actionButton("图片测试", () => void testSavedModel(model, true), !model.input.includes("image")),
      actionButton("编辑", () => void openModelForm(model)),
      actionButton("删除", () => deleteModel(model), false, "danger"),
    ]);
    card.append(title, meta, actions);
    return card;
  });
  $("#models-list").replaceChildren(...(cards.length ? cards : [empty("尚未配置模型。请先新增 Provider。") ]));
}

function renderKnowledgeProviders() {
  const cards = state.knowledgeProviders.map((provider) => {
    const card = node("article", "list-card");
    const title = node("div", "", [node("h2", "", provider.label), node("div", "meta", provider.id)]);
    const credential = provider.hasApiKey
      ? "API Key 已加密保存"
      : provider.apiKeyEnv
        ? `环境变量 ${provider.apiKeyEnv}`
        : provider.kind === "searxng" ? "无 Key 模式" : "未配置 API Key";
    const meta = node("div", "meta", [
      node("div", "", `${provider.kind} · 最多 ${provider.maxResults} 条 · ${provider.timeoutMs} ms`),
      node("div", "", provider.baseUrl),
      node("div", "", `${credential} · ${provider.enabled ? "已启用" : "已停用"}`),
    ]);
    const actions = node("div", "actions", [
      actionButton("测试", () => void probeSavedKnowledgeProvider(provider)),
      actionButton("编辑", () => openKnowledgeProviderForm(provider)),
      actionButton("删除", () => void deleteKnowledgeProvider(provider), false, "danger"),
    ]);
    card.append(title, meta, actions);
    return card;
  });
  $("#knowledge-providers-list").replaceChildren(...(cards.length ? cards : [empty("尚未配置联网检索；lookup_knowledge 当前不会暴露给模型。") ]));
}

function renderMcpServers() {
  const cards = state.mcpServers.map((server) => {
    const credential = server.authType === "none" ? "无鉴权" : server.hasSecret ? "密钥已加密保存" : "缺少密钥";
    const card = node("article", "list-card", [
      node("div", "", [node("h2", "", server.label), node("div", "meta", server.id)]),
      node("div", "meta", [
        node("div", "", server.url),
        node("div", "", `${server.authType} · ${credential} · 最多 ${server.maxTools} 个工具 · ${server.timeoutMs} ms`),
        node("div", "", server.enabled ? "已启用" : "已停用"),
      ]),
      node("div", "actions", [
        actionButton("测试/列工具", () => void probeSavedMcpServer(server)),
        actionButton("编辑", () => openMcpServerForm(server)),
        actionButton("删除", () => void deleteMcpServer(server), false, "danger"),
      ]),
    ]);
    return card;
  });
  $("#mcp-servers-list").replaceChildren(...(cards.length ? cards : [empty("尚未配置 MCP 服务；模型当前不会获得外部 MCP 工具。") ]));
}

function renderSettings() {
  if (!state.settings) return;
  const form = $("#settings-form");
  fillModelSelect(form.elements.defaultChatModelProfileId, state.settings.defaultChatModelProfileId, "未配置");
  fillModelSelect(form.elements.defaultVisionModelProfileId, state.settings.defaultVisionModelProfileId, "不启用视觉");
  form.elements.defaultKnowledgeProfileId.replaceChildren(
    option("", "不启用联网检索"),
    ...state.knowledgeProviders.map((provider) => option(provider.id, `${provider.label}${provider.enabled ? "" : "（停用）"}`)),
  );
  form.elements.defaultKnowledgeProfileId.value = state.settings.defaultKnowledgeProfileId || "";
  form.elements.defaultPersonaProfileId.replaceChildren(
    option("", "框架内置默认人设"),
    ...state.personas.map((persona) => option(persona.id, `${persona.label}${persona.enabled ? "" : "（停用）"}`)),
  );
  form.elements.defaultPersonaProfileId.value = state.settings.defaultPersonaProfileId || "";
  form.elements.logRetentionDays.value = state.settings.logRetentionDays;
  form.elements.maxLogRows.value = state.settings.maxLogRows;
  form.elements.statusRefreshMs.value = state.settings.statusRefreshMs;
  form.elements.participationRetentionDays.value = state.settings.participationRetentionDays ?? 90;
  form.elements.maxParticipationCasesPerBot.value = state.settings.maxParticipationCasesPerBot ?? 50000;
}

async function refreshParticipation() {
  if (!state.token) return;
  fillParticipationBotFilter();
  const botId = $("#participation-bot").value;
  if (!botId) {
    state.participationCases = [];
    state.participationSummary = null;
    renderParticipation();
    return;
  }
  const params = new URLSearchParams({
    botId,
    review: $("#participation-review").value,
    qualityReview: $("#participation-quality-review").value,
    limit: "100",
  });
  const conversationId = $("#participation-conversation").value.trim();
  if (conversationId) params.set("conversationId", conversationId);
  try {
    const [cases, summary] = await Promise.all([
      api(`/api/participation?${params}`),
      api(`/api/participation/summary?botId=${encodeURIComponent(botId)}`),
    ]);
    state.participationCases = cases.cases;
    state.participationSummary = summary.summary;
    state.qualitySummaries[botId] = summary.summary;
    renderParticipation();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderParticipation() {
  const summary = state.participationSummary;
  const helpfulRate = summary && summary.helpful + summary.unhelpful
    ? summary.helpful / (summary.helpful + summary.unhelpful)
    : 0;
  const participationCoverage = summary?.total
    ? (summary.speak + summary.silent + summary.unsure) / summary.total
    : 0;
  const stats = summary
    ? [
        ["案例总数", summary.total],
        ["待评分", summary.unrated],
        ["参与评分覆盖", formatPercent(participationCoverage)],
        ["有帮助率", summary.helpful + summary.unhelpful ? formatPercent(helpfulRate) : "—"],
        ["有帮助 / 需改进", `${summary.helpful || 0} / ${summary.unhelpful || 0}`],
        ["质量不确定", summary.qualityUnsure || 0],
      ]
    : [["案例总数", 0], ["待评分", 0], ["参与评分覆盖", "—"], ["有帮助率", "—"], ["有帮助 / 需改进", "0 / 0"], ["质量不确定", 0]];
  $("#participation-stats").replaceChildren(
    ...stats.map(([label, value]) => node("div", "stat", [node("span", "", label), node("strong", "", String(value))])),
  );
  const cards = state.participationCases.map(participationCard);
  $("#participation-list").replaceChildren(...(cards.length ? cards : [empty("当前筛选条件下没有案例。新群消息到来后会自动形成待评分样本。")]));
}

function participationCard(item) {
  const card = node("article", "participation-card");
  const title = node("div", "participation-head", [
    node("div", "", [
      node("h2", "", item.conversationTitle || item.conversationId),
      node("div", "meta", `${item.senderName} · ${formatDate(item.createdAt)}`),
    ]),
    node("span", `pill ${item.adminLabel ? "healthy" : "warn"}`, participationLabel(item.adminLabel)),
  ]);
  const message = node("div", "participation-message", item.messageText || "（非文本消息）");
  const decision = node(
    "div",
    "participation-decision",
    `${item.policyRespond ? "框架选择参与" : "框架选择沉默"} · ${item.policyReason} · ${item.modelUsed ? "已调用模型" : "未调用模型"} · ${participationOutcome(item.outcome)}`,
  );
  const context = document.createElement("details");
  context.className = "participation-context";
  const contextSummary = document.createElement("summary");
  contextSummary.textContent = `查看当时上下文（${item.context.length} 条）`;
  const contextBody = node(
    "div",
    "context-lines",
    item.context.length
      ? item.context.map((messageItem) =>
          node("div", "context-line", `${messageItem.senderName}: ${messageItem.text || "（非文本）"}`))
      : [node("div", "meta", "没有更早上下文")],
  );
  context.append(contextSummary, contextBody);
  if (item.replyText) card.append(title, message, decision, node("div", "participation-reply", `机器人回复：${item.replyText}`));
  else card.append(title, message, decision);
  if (item.implicitLabel) {
    card.append(node("div", "participation-feedback", `群友反馈：${item.implicitLabel === "speak" ? "正向" : "负向"} · ${item.implicitReason || ""}`));
  }
  if (item.implicitQualityLabel) {
    card.append(node("div", `participation-feedback ${item.implicitQualityLabel === "unhelpful" ? "negative" : ""}`, `质量反馈：${replyQualityLabel(item.implicitQualityLabel)} · ${item.implicitQualityReason || ""}`));
  }
  card.append(context);
  const reason = document.createElement("textarea");
  reason.rows = 2;
  reason.maxLength = 500;
  reason.placeholder = "可选：为什么这次应该说或不该说";
  reason.value = item.adminReason || "";
  const participationCaption = node("div", "review-dimension", [
    node("strong", "", "参与时机"),
    node("span", "meta", "机器人在这个时刻是否应该开口"),
  ]);
  const actions = node("div", "participation-actions", [
    actionButton("应该说", () => void labelParticipation(item, "speak", reason.value), false, item.adminLabel === "speak" ? "selected-good" : ""),
    actionButton("不该说", () => void labelParticipation(item, "silent", reason.value), false, item.adminLabel === "silent" ? "selected-bad" : ""),
    actionButton("不确定", () => void labelParticipation(item, "unsure", reason.value), false, item.adminLabel === "unsure" ? "selected-neutral" : ""),
  ]);
  const qualityReason = document.createElement("textarea");
  qualityReason.rows = 2;
  qualityReason.maxLength = 500;
  qualityReason.placeholder = "可选：回复哪里有帮助，或具体需要改进什么";
  qualityReason.value = item.adminQualityReason || "";
  const qualityActions = node("div", "participation-actions quality-actions", [
    actionButton("有帮助", () => void labelReplyQuality(item, "helpful", qualityReason.value), false, item.adminQualityLabel === "helpful" ? "selected-good" : ""),
    actionButton("需改进", () => void labelReplyQuality(item, "unhelpful", qualityReason.value), false, item.adminQualityLabel === "unhelpful" ? "selected-bad" : ""),
    actionButton("不确定", () => void labelReplyQuality(item, "unsure", qualityReason.value), false, item.adminQualityLabel === "unsure" ? "selected-neutral" : ""),
  ]);
  const qualityCaption = node("div", "review-dimension", [
    node("strong", "", "回复有用性"),
    node("span", "meta", item.replyText ? "评价答案本身，不影响参与时机标签" : "本次没有机器人回复，无法评价答案"),
  ]);
  qualityReason.disabled = !item.replyText;
  qualityActions.querySelectorAll("button").forEach((button) => { button.disabled = !item.replyText; });
  card.append(participationCaption, reason, actions, qualityCaption, qualityReason, qualityActions);
  return card;
}

async function exportParticipationDataset() {
  const botId = $("#participation-bot").value;
  if (!botId) return toast("请先选择机器人", true);
  const params = new URLSearchParams({
    botId,
    review: $("#participation-review").value,
    qualityReview: $("#participation-quality-review").value,
    limit: "200",
  });
  const conversationId = $("#participation-conversation").value.trim();
  if (conversationId) params.set("conversationId", conversationId);
  try {
    const response = await api(`/api/participation?${params}`);
    const lines = response.cases.map((item) => JSON.stringify({
      id: item.eventId,
      conversationId: item.conversationId,
      message: item.messageText,
      context: item.context.map((entry) => ({ role: entry.direction === "outbound" ? "assistant" : "user", name: entry.senderName, text: entry.text })),
      reply: item.replyText || null,
      expectedParticipation: item.adminLabel || item.implicitLabel || null,
      replyQuality: item.adminQualityLabel || item.implicitQualityLabel || null,
      participationReason: item.adminReason || item.implicitReason || null,
      qualityReason: item.adminQualityReason || item.implicitQualityReason || null,
      policy: { respond: item.policyRespond, reason: item.policyReason },
    })).join("\n");
    const url = URL.createObjectURL(new Blob([lines], { type: "application/x-ndjson;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${botId}-chat-evaluation-${new Date().toISOString().slice(0, 10)}.jsonl`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出 ${response.cases.length} 条评测案例`);
  } catch (error) { toast(error.message, true); }
}

async function labelReplyQuality(item, label, reason) {
  const botId = $("#participation-bot").value;
  try {
    await api("/api/participation/quality", {
      method: "POST",
      body: { botId, eventId: item.eventId, label, reason: reason.trim() || undefined },
    });
    toast(`回复质量已标注为“${replyQualityLabel(label)}”`);
    await refreshParticipation();
  } catch (error) { toast(error.message, true); }
}

async function labelParticipation(item, label, reason) {
  const botId = $("#participation-bot").value;
  try {
    await api("/api/participation/label", {
      method: "POST",
      body: { botId, eventId: item.eventId, label, reason: reason.trim() || undefined },
    });
    toast(`案例已标注为“${participationLabel(label)}”`);
    await refreshParticipation();
  } catch (error) { toast(error.message, true); }
}

async function pruneParticipation() {
  const botId = $("#participation-bot").value;
  if (!botId) return;
  try {
    const result = await api("/api/participation/prune", { method: "POST", body: { botId } });
    toast(`已清理 ${result.deleted} 条过期或溢出案例`);
    await refreshParticipation();
  } catch (error) { toast(error.message, true); }
}

function logQueryParams(extra = {}) {
  const params = new URLSearchParams({ limit: "200", ...extra });
  if ($("#log-level").value) params.set("level", $("#log-level").value);
  if ($("#log-bot").value) params.set("botId", $("#log-bot").value);
  if ($("#log-query").value.trim()) params.set("q", $("#log-query").value.trim());
  return params;
}

async function refreshLogs(merge = false) {
  if (!state.token) return;
  try {
    const data = await api(`/api/logs?${logQueryParams()}`);
    const fresh = data.logs || [];
    if (merge && state.logs.length) {
      const newestId = state.logs[0]?.id ?? 0;
      const added = fresh.filter((log) => log.id > newestId);
      if (!added.length) return;
      state.logs = [...added, ...state.logs];
    } else {
      state.logs = fresh;
      state.logsHasMore = fresh.length >= 200;
    }
    renderLogs();
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadMoreLogs() {
  const oldest = state.logs.at(-1);
  if (!oldest) return refreshLogs();
  const button = $("#load-more-logs");
  await withBusy(button, async () => {
    try {
      const data = await api(`/api/logs?${logQueryParams({ beforeId: String(oldest.id) })}`);
      const older = data.logs || [];
      state.logsHasMore = older.length >= 200;
      state.logs = [...state.logs, ...older];
      renderLogs();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function renderLogs() {
  const rows = state.logs.map((log) => node("div", `log-row${log.level === "error" ? " log-error-row" : ""}`, [
    node("span", "time", formatDate(log.createdAt)),
    node("span", `level-${log.level}`, log.level),
    node("span", "scope", `${log.botId || log.scope} · ${log.event}`),
    node("span", "message", log.message),
  ]));
  $("#logs-list").replaceChildren(...(rows.length ? rows : [empty("没有匹配日志") ]));
  $("#load-more-logs").hidden = !state.logsHasMore;
}

function openProviderForm(provider = null) {
  state.editingProvider = provider;
  const form = $("#provider-form");
  form.reset();
  form.elements.id.readOnly = Boolean(provider);
  form.elements.id.value = provider?.id || "";
  form.elements.label.value = provider?.label || "";
  form.elements.provider.value = provider?.provider || "";
  form.elements.api.value = provider?.api || "auto";
  form.elements.baseUrl.value = provider?.baseUrl || "";
  form.elements.apiKeyEnv.value = provider?.apiKeyEnv || "";
  form.elements.apiKey.value = "";
  form.elements.clearApiKey.checked = false;
  form.elements.enabled.checked = provider?.enabled ?? true;
  $("#provider-probe-result").textContent = "";
  $("#provider-probe-result").className = "span-2 probe-result";
  $("#provider-dialog").showModal();
}

async function saveProvider(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = {
    id: form.elements.id.value,
    label: form.elements.label.value,
    provider: form.elements.provider.value,
    api: form.elements.api.value,
    apiKey: form.elements.apiKey.value || undefined,
    clearApiKey: form.elements.clearApiKey.checked,
    apiKeyEnv: form.elements.apiKeyEnv.value || undefined,
    baseUrl: form.elements.baseUrl.value || undefined,
    enabled: form.elements.enabled.checked,
  };
  if (value.api === "auto") {
    toast("请先点击“测试并拉取模型”完成协议探测，或手动选择接口协议", true);
    return;
  }
  await withBusy(form.querySelector('button[type="submit"]'), async () => {
    try {
      await api("/api/providers", { method: "POST", body: value });
      $("#provider-dialog").close();
      toast("Provider 配置已保存；API Key 不会回传到浏览器");
      await reloadConfiguration();
    } catch (error) { toast(error.message, true); }
  });
}

async function probeProviderForm() {
  const form = $("#provider-form");
  if (!form.reportValidity()) return;
  setButtonBusy($("#provider-probe"), true);
  const result = $("#provider-probe-result");
  result.textContent = "正在连接 Provider…";
  result.className = "span-2 probe-result";
  const value = {
    id: form.elements.id.value,
    label: form.elements.label.value,
    provider: form.elements.provider.value,
    api: form.elements.api.value,
    apiKey: form.elements.apiKey.value || undefined,
    apiKeyEnv: form.elements.apiKeyEnv.value || undefined,
    baseUrl: form.elements.baseUrl.value,
    enabled: form.elements.enabled.checked,
  };
  try {
    const probe = await api("/api/providers/probe", { method: "POST", body: value });
    state.discoveredModels.set(value.id, probe.models);
    form.elements.api.value = probe.detectedApi;
    const compatible = probe.compatibleApis?.length > 1
      ? `；同时兼容 ${probe.compatibleApis.map(providerApiLabel).join(" / ")}，可手动切换`
      : "";
    result.textContent = `连接成功：${probe.latencyMs} ms，检测为 ${providerApiLabel(probe.detectedApi)}${compatible}，发现 ${probe.modelCount} 个模型。保存后可在“模型”中选择。`;
  } catch (error) {
    result.textContent = error.message;
    result.className = "span-2 probe-result error";
  } finally {
    setButtonBusy($("#provider-probe"), false);
  }
}

async function probeSavedProvider(provider) {
  try {
    const probe = await api(`/api/providers/${encodeURIComponent(provider.id)}/test`, { method: "POST" });
    state.discoveredModels.set(provider.id, probe.models);
    toast(`${provider.label} 连接成功：${providerApiLabel(probe.detectedApi)}，发现 ${probe.modelCount} 个模型（${probe.latencyMs} ms）`);
  } catch (error) { toast(error.message, true); }
}

function openKnowledgeProviderForm(provider = null) {
  state.editingKnowledgeProvider = provider;
  const form = $("#knowledge-provider-form");
  form.reset();
  form.elements.id.readOnly = Boolean(provider);
  form.elements.id.value = provider?.id || "";
  form.elements.label.value = provider?.label || "";
  form.elements.kind.value = provider?.kind || "searxng";
  form.elements.baseUrl.value = provider?.baseUrl || "http://searxng:8080";
  form.elements.apiKey.value = "";
  form.elements.apiKeyEnv.value = provider?.apiKeyEnv || "";
  form.elements.timeoutMs.value = provider?.timeoutMs || 12000;
  form.elements.maxResults.value = provider?.maxResults || 5;
  form.elements.enabled.checked = provider?.enabled ?? true;
  form.elements.clearApiKey.checked = false;
  $("#knowledge-provider-probe-result").textContent = "";
  $("#knowledge-provider-probe-result").className = "span-2 probe-result";
  $("#knowledge-provider-dialog").showModal();
}

function knowledgeProviderFormValue() {
  const form = $("#knowledge-provider-form");
  return {
    id: form.elements.id.value,
    label: form.elements.label.value,
    kind: form.elements.kind.value,
    baseUrl: form.elements.baseUrl.value,
    apiKey: form.elements.apiKey.value || undefined,
    clearApiKey: form.elements.clearApiKey.checked,
    apiKeyEnv: form.elements.apiKeyEnv.value || undefined,
    timeoutMs: Number(form.elements.timeoutMs.value),
    maxResults: Number(form.elements.maxResults.value),
    enabled: form.elements.enabled.checked,
  };
}

async function saveKnowledgeProvider(event) {
  event.preventDefault();
  await withBusy(event.currentTarget.querySelector('button[type="submit"]'), async () => {
    try {
      await api("/api/knowledge-providers", { method: "POST", body: knowledgeProviderFormValue() });
      $("#knowledge-provider-dialog").close();
      toast("联网检索配置已保存");
      await reloadConfiguration();
    } catch (error) { toast(error.message, true); }
  });
}

async function probeKnowledgeProviderForm() {
  const form = $("#knowledge-provider-form");
  if (!form.reportValidity()) return;
  setButtonBusy($("#knowledge-provider-probe"), true);
  const result = $("#knowledge-provider-probe-result");
  result.textContent = "正在执行受限搜索…";
  result.className = "span-2 probe-result";
  try {
    const probe = await api("/api/knowledge-providers/probe", {
      method: "POST",
      body: { ...knowledgeProviderFormValue(), query: "今天的科技新闻" },
    });
    result.textContent = `连接成功：${probe.latencyMs} ms，返回 ${probe.resultCount} 条。${probe.results.map((item) => item.title).join("；")}`;
  } catch (error) {
    result.textContent = error.message;
    result.className = "span-2 probe-result error";
  } finally {
    setButtonBusy($("#knowledge-provider-probe"), false);
  }
}

async function probeSavedKnowledgeProvider(provider) {
  try {
    const probe = await api(`/api/knowledge-providers/${encodeURIComponent(provider.id)}/test`, { method: "POST" });
    toast(`${provider.label} 搜索成功，返回 ${probe.resultCount} 条（${probe.latencyMs} ms）`);
  } catch (error) { toast(error.message, true); }
}

function applyKnowledgeProviderDefaults() {
  const form = $("#knowledge-provider-form");
  const defaults = {
    searxng: "http://searxng:8080",
    brave: "https://api.search.brave.com",
    tavily: "https://api.tavily.com/search",
  }[form.elements.kind.value];
  if (defaults) form.elements.baseUrl.value = defaults;
}

function openMcpServerForm(server = null) {
  state.editingMcpServer = server;
  const form = $("#mcp-server-form");
  form.reset();
  form.elements.id.readOnly = Boolean(server);
  form.elements.id.value = server?.id || "";
  form.elements.label.value = server?.label || "";
  form.elements.url.value = server?.url || "";
  form.elements.authType.value = server?.authType || "none";
  form.elements.authHeader.value = server?.authHeader || "Authorization";
  form.elements.secret.value = "";
  form.elements.headers.value = server?.headers && Object.keys(server.headers).length ? JSON.stringify(server.headers, null, 2) : "";
  form.elements.timeoutMs.value = server?.timeoutMs || 15000;
  form.elements.maxTools.value = server?.maxTools || 20;
  form.elements.enabled.checked = server?.enabled ?? true;
  form.elements.clearSecret.checked = false;
  $("#mcp-server-probe-result").textContent = "";
  $("#mcp-server-probe-result").className = "span-2 probe-result";
  $("#mcp-server-dialog").showModal();
}

function mcpServerFormValue() {
  const form = $("#mcp-server-form");
  let headers = {};
  if (form.elements.headers.value.trim()) {
    headers = JSON.parse(form.elements.headers.value);
    if (!headers || Array.isArray(headers) || typeof headers !== "object") throw new Error("附加 Headers 必须是 JSON 对象");
  }
  return {
    id: form.elements.id.value,
    label: form.elements.label.value,
    url: form.elements.url.value,
    authType: form.elements.authType.value,
    authHeader: form.elements.authHeader.value,
    secret: form.elements.secret.value || undefined,
    clearSecret: form.elements.clearSecret.checked,
    headers,
    timeoutMs: Number(form.elements.timeoutMs.value),
    maxTools: Number(form.elements.maxTools.value),
    enabled: form.elements.enabled.checked,
  };
}

async function saveMcpServer(event) {
  event.preventDefault();
  await withBusy(event.currentTarget.querySelector('button[type="submit"]'), async () => {
    try {
      await api("/api/mcp-servers", { method: "POST", body: mcpServerFormValue() });
      $("#mcp-server-dialog").close();
      toast("MCP 服务已保存并重新加载机器人工具");
      await reloadConfiguration();
    } catch (error) { toast(error.message, true); }
  });
}

async function probeMcpServerForm() {
  const form = $("#mcp-server-form");
  if (!form.reportValidity()) return;
  setButtonBusy($("#mcp-server-probe"), true);
  const result = $("#mcp-server-probe-result");
  result.textContent = "正在连接 MCP 并读取工具列表…";
  result.className = "span-2 probe-result";
  try {
    const probe = await api("/api/mcp-servers/probe", { method: "POST", body: mcpServerFormValue() });
    result.textContent = formatMcpProbe(probe);
  } catch (error) {
    result.textContent = error.message;
    result.className = "span-2 probe-result error";
  } finally {
    setButtonBusy($("#mcp-server-probe"), false);
  }
}

async function probeSavedMcpServer(server) {
  try {
    const probe = await api(`/api/mcp-servers/${encodeURIComponent(server.id)}/test`, { method: "POST" });
    toast(`${server.label} 连接成功：${probe.serverInfo?.name || "MCP Server"}，${probe.tools.length} 个工具（${probe.latencyMs} ms）`);
    openMcpServerForm(server);
    $("#mcp-server-probe-result").textContent = formatMcpProbe(probe);
  } catch (error) { toast(error.message, true); }
}

function formatMcpProbe(probe) {
  const server = probe.serverInfo ? `${probe.serverInfo.name} ${probe.serverInfo.version}` : "MCP Server";
  const tools = probe.tools.length ? probe.tools.map((tool) => `• ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`).join("\n") : "（没有工具）";
  return `${server} · ${probe.latencyMs} ms · ${probe.tools.length} 个工具\n${tools}`;
}

function applyMcpAuthDefaults() {
  const form = $("#mcp-server-form");
  form.elements.authHeader.value = form.elements.authType.value === "api-key" ? "X-API-Key" : "Authorization";
}

async function openModelForm(model = null) {
  if (state.providerProfiles.length === 0) {
    switchView("providers");
    toast("请先新增 Provider", true);
    return;
  }
  state.editingModel = model;
  const form = $("#model-form");
  form.reset();
  $("#model-test-result").textContent = "";
  $("#model-test-result").className = "span-2 probe-result";
  fillProviderProfileSelect();
  if (model) {
    form.elements.id.value = model.id;
    form.elements.id.readOnly = true;
    form.elements.label.value = model.label;
    form.elements.providerProfileId.value = model.providerProfileId;
    form.elements.api.value = model.api || "inherit";
    form.elements.thinkingLevel.value = model.thinkingLevel;
    form.elements.openaiThinkingFormat.value = model.openaiThinkingFormat || "";
    form.elements.maxRetryDelayMs.value = model.maxRetryDelayMs;
    form.elements.contextWindow.value = model.contextWindow;
    form.elements.maxTokens.value = model.maxTokens;
    form.elements.reasoning.checked = model.reasoning;
    form.elements.supportsImages.checked = model.input.includes("image");
    form.elements.enabled.checked = model.enabled;
  } else {
    form.elements.id.readOnly = false;
    form.elements.maxRetryDelayMs.value = 60000;
    form.elements.contextWindow.value = 128000;
    form.elements.maxTokens.value = 8192;
    form.elements.api.value = "auto";
    form.elements.enabled.checked = true;
  }
  await loadModelCatalog();
  if (model) {
    form.elements.modelId.value = model.modelId;
    form.elements.contextWindow.value = model.contextWindow;
    form.elements.maxTokens.value = model.maxTokens;
    form.elements.reasoning.checked = model.reasoning;
    form.elements.supportsImages.checked = model.input.includes("image");
  }
  $("#model-dialog").showModal();
}

async function loadModelCatalog() {
  const form = $("#model-form");
  const providerProfile = state.providerProfiles.find((item) => item.id === form.elements.providerProfileId.value);
  const dataList = $("#model-id-options");
  dataList.replaceChildren();
  if (!providerProfile) return;
  try {
    let models = state.discoveredModels.get(providerProfile.id);
    if (!models) {
      const data = await api(`/api/providers/${encodeURIComponent(providerProfile.id)}/test`, { method: "POST" });
      models = data.models;
      state.discoveredModels.set(providerProfile.id, models);
    }
    state.currentModelCatalog = models;
    dataList.append(...models.map((model) => option(model.id, `${model.name} · ${model.input.join("+")} · ${model.metadataSource || "provider"}`)));
  } catch (error) {
    state.currentModelCatalog = [];
    toast(`${error.message}；仍可手动填写模型 ID`, true);
  }
}

function applyDiscoveredModelDefaults() {
  const form = $("#model-form");
  const model = state.currentModelCatalog.find((item) => item.id === form.elements.modelId.value);
  if (!model) return;
  form.elements.contextWindow.value = model.contextWindow;
  form.elements.maxTokens.value = model.maxTokens;
  form.elements.reasoning.checked = model.reasoning;
  form.elements.supportsImages.checked = model.input.includes("image");
}

async function saveModel(event) {
  event.preventDefault();
  const value = modelFormValue(event.currentTarget);
  await withBusy(event.currentTarget.querySelector('button[type="submit"]'), async () => {
    try {
      await api("/api/models", { method: "POST", body: value });
      $("#model-dialog").close();
      toast("模型配置已保存");
      await reloadConfiguration();
    } catch (error) { toast(error.message, true); }
  });
}

function modelFormValue(form = $("#model-form")) {
  return {
    id: form.elements.id.value,
    label: form.elements.label.value,
    providerProfileId: form.elements.providerProfileId.value,
    modelId: form.elements.modelId.value,
    api: form.elements.api.value,
    input: form.elements.supportsImages.checked ? ["text", "image"] : ["text"],
    reasoning: form.elements.reasoning.checked,
    contextWindow: Number(form.elements.contextWindow.value),
    maxTokens: Number(form.elements.maxTokens.value),
    thinkingLevel: form.elements.thinkingLevel.value,
    openaiThinkingFormat: form.elements.openaiThinkingFormat.value || undefined,
    maxRetryDelayMs: Number(form.elements.maxRetryDelayMs.value),
    enabled: form.elements.enabled.checked,
  };
}

async function testModelForm(testImage) {
  const form = $("#model-form");
  if (!form.reportValidity()) return;
  if (testImage && !form.elements.supportsImages.checked) {
    toast("先勾选“支持图片输入”再进行图片测试", true);
    return;
  }
  const trigger = $(testImage ? "#model-image-test" : "#model-text-test");
  setButtonBusy(trigger, true);
  const result = $("#model-test-result");
  result.textContent = testImage ? "正在执行图片输入测试…" : "正在执行真实文本推理测试…";
  result.className = "span-2 probe-result";
  try {
    const probe = await api("/api/models/test", {
      method: "POST",
      body: { ...modelFormValue(form), testImage },
    });
    if (form.elements.api.value === "auto") form.elements.api.value = probe.api;
    result.textContent = `${testImage ? "图片" : "文本"}测试成功：已识别 ${providerApiLabel(probe.api)}，${probe.latencyMs} ms，模型 ${probe.responseModel}，返回“${probe.responseText}”。`;
  } catch (error) {
    result.textContent = error.message;
    result.className = "span-2 probe-result error";
  } finally {
    setButtonBusy(trigger, false);
  }
}

async function testSavedModel(model, testImage) {
  try {
    const probe = await api(`/api/models/${encodeURIComponent(model.id)}/test`, {
      method: "POST",
      body: { testImage },
    });
    toast(`${model.label} ${testImage ? "图片" : "文本"}测试成功：${providerApiLabel(probe.api)} · ${probe.responseText}（${probe.latencyMs} ms）`);
    if (model.api === "auto") await reloadConfiguration();
  } catch (error) { toast(error.message, true); }
}

function openBotForm(bot = null) {
  state.editingBot = bot;
  const form = $("#bot-form");
  form.reset();
  const defaults = bot?.limits || DEFAULT_LIMITS;
  form.elements.id.readOnly = Boolean(bot);
  form.elements.id.value = bot?.id || "";
  form.elements.identityId.value = bot?.identityId || "";
  form.elements.displayName.value = bot?.displayName || "";
  form.elements.defaultGroupActivation.value = bot?.defaultGroupActivation || "mention";
  fillModelSelect(form.elements.chatModelProfileId, bot?.chatModelProfileId, "继承全局");
  fillModelSelect(form.elements.fastChatModelProfileId, bot?.fastChatModelProfileId, "不启用简单任务快车道");
  fillModelSelect(form.elements.participationJudgeModelProfileId, bot?.participationJudgeModelProfileId, "不启用模型接话判断");
  form.elements.fallbackChatModelProfileIds.value = (bot?.fallbackChatModelProfileIds || (bot?.fallbackChatModelProfileId ? [bot.fallbackChatModelProfileId] : [])).join("\n");
  fillModelSelect(form.elements.visionModelProfileId, bot?.visionModelProfileId, "继承全局");
  form.elements.personaProfileId.replaceChildren(
    option("", "继承全局默认人设"),
    ...state.personas.map((persona) => option(persona.id, `${persona.label}${persona.enabled ? "" : "（停用）"}`)),
  );
  form.elements.personaProfileId.value = bot?.personaProfileId || "";
  form.elements.wakeWords.value = (bot?.wakeWords || []).join(", ");
  form.elements.operatorIds.value = (bot?.operatorIds || []).join(", ");
  form.elements.enabled.checked = bot?.enabled || false;
  form.elements.imageUnderstandingEnabled.checked = bot?.imageUnderstandingEnabled ?? true;
  const social = bot?.socialSchedule || DEFAULT_SOCIAL_SCHEDULE;
  form.elements.socialScheduleEnabled.checked = social.enabled;
  form.elements.timezoneOffsetMinutes.value = social.timezoneOffsetMinutes;
  form.elements.activeStartTime.value = minuteToTime(social.activeStartMinute);
  form.elements.activeEndTime.value = minuteToTime(social.activeEndMinute);
  form.elements.hotChatWindowMinutes.value = social.hotChatWindowMs / 60000;
  form.elements.hotChatMinMessages.value = social.hotChatMinMessages;
  form.elements.hotChatMinParticipants.value = social.hotChatMinParticipants;
  form.elements.hotChatCooldownMinutes.value = social.hotChatCooldownMs / 60000;
  form.elements.coldChatAfterHours.value = social.coldChatAfterMs / 3600000;
  form.elements.coldChatCooldownHours.value = social.coldChatCooldownMs / 3600000;
  form.elements.maxDailyAmbientMessages.value = social.maxDailyAmbientMessages;
  form.elements.goodnightEnabled.checked = social.goodnightEnabled;
  form.elements.goodnightTime.value = minuteToTime(social.goodnightMinute);
  form.elements.activeGroupMinMessages.value = social.activeGroupMinMessages;
  const channel = bot?.channel;
  const wxHook = channel?.type === "wx-hook-http" ? channel : null;
  const ipad = channel?.type === "wechat-ipad" ? channel : null;
  form.elements.channelType.value = channel?.type || "wx-hook-http";
  form.elements.accountId.value = channel?.accountId || "";
  form.elements.gatewayBaseUrl.value = wxHook?.gatewayBaseUrl || "http://192.168.31.200:8080";
  form.elements.apiTokenEnv.value = wxHook?.apiTokenEnv || "WX_HOOK_API_TOKEN";
  form.elements.gatewayTimeoutMs.value = wxHook?.gatewayTimeoutMs || 10000;
  form.elements.webhookHost.value = wxHook?.webhookHost || "0.0.0.0";
  form.elements.webhookPort.value = wxHook?.webhookPort || nextWebhookPort();
  form.elements.webhookPath.value = wxHook?.webhookPath || "/wechat/events";
  form.elements.webhookSecretEnv.value = wxHook?.webhookSecretEnv || "WX_HOOK_WEBHOOK_SECRET";
  form.elements.nativeQuoteReplies.checked = wxHook?.nativeQuoteReplies ?? true;
  form.elements.acceptUnknownGroupSenders.checked = wxHook?.acceptUnknownGroupSenders ?? true;
  form.elements.ipadApiBaseUrl.value = ipad?.apiBaseUrl || "http://wechat-ipad-874-api:8062/api";
  form.elements.ipadAccountWxid.value = ipad?.accountWxid || "";
  form.elements.ipadApiTokenEnv.value = ipad?.apiTokenEnv || "";
  form.elements.ipadApiTimeoutMs.value = ipad?.apiTimeoutMs || 35000;
  form.elements.ipadCallbackHost.value = ipad?.callbackHost || "0.0.0.0";
  form.elements.ipadCallbackPort.value = ipad?.callbackPort || nextWebhookPort();
  form.elements.ipadCallbackPathPrefix.value = ipad?.callbackPathPrefix || "/api/v1/wechat-client";
  form.elements.ipadCallbackAllowedSourceIps.value = (ipad?.callbackAllowedSourceIps || ["172.23.0.0/16"]).join("\n");
  form.elements.ipadCallbackMaxBodyBytes.value = ipad?.callbackMaxBodyBytes || 16777216;
  form.elements.ipadCallbackRouterBaseUrl.value = ipad?.callbackRouterBaseUrl || "http://wechat-874-callback-router:9000";
  form.elements.ipadCallbackAdvertiseHost.value = ipad?.callbackAdvertiseHost || "pi-wechat-agent";
  form.elements.ipadAutoRegisterCallback.checked = ipad?.autoRegisterCallback ?? true;
  form.elements.ipadRegisterIntervalMs.value = ipad?.registerIntervalMs || 60000;
  form.elements.ingestRetryMs.value = channel?.ingestRetryMs || 2000;
  Object.entries(defaults).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
  toggleBotChannelFields();
  $("#bot-dialog").showModal();
}

function toggleBotChannelFields() {
  const form = $("#bot-form");
  const type = form.elements.channelType.value;
  $$('[data-channel-fields]').forEach((section) => {
    const active = section.dataset.channelFields === type;
    section.hidden = !active;
    section.querySelectorAll("input, select, textarea").forEach((control) => { control.disabled = !active; });
  });
  $("#channel-section-title").textContent = type === "wechat-ipad" ? "WeChat iPad Channel" : "wx_hook_bridge Channel";
}

async function saveBot(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const old = state.editingBot;
  const limits = {};
  Object.keys(DEFAULT_LIMITS).forEach((key) => { limits[key] = Number(form.elements[key].value); });
  const channel = form.elements.channelType.value === "wechat-ipad"
    ? {
        type: "wechat-ipad",
        apiBaseUrl: form.elements.ipadApiBaseUrl.value,
        accountWxid: form.elements.ipadAccountWxid.value,
        apiTokenEnv: form.elements.ipadApiTokenEnv.value || undefined,
        apiTimeoutMs: Number(form.elements.ipadApiTimeoutMs.value),
        callbackHost: form.elements.ipadCallbackHost.value,
        callbackPort: Number(form.elements.ipadCallbackPort.value),
        callbackPathPrefix: form.elements.ipadCallbackPathPrefix.value,
        callbackAllowedSourceIps: delimitedList(form.elements.ipadCallbackAllowedSourceIps.value),
        callbackMaxBodyBytes: Number(form.elements.ipadCallbackMaxBodyBytes.value),
        callbackRouterBaseUrl: form.elements.ipadCallbackRouterBaseUrl.value,
        callbackAdvertiseHost: form.elements.ipadCallbackAdvertiseHost.value,
        autoRegisterCallback: form.elements.ipadAutoRegisterCallback.checked,
        registerIntervalMs: Number(form.elements.ipadRegisterIntervalMs.value),
        accountId: form.elements.accountId.value || undefined,
        ingestRetryMs: Number(form.elements.ingestRetryMs.value),
      }
    : {
        type: "wx-hook-http",
        gatewayBaseUrl: form.elements.gatewayBaseUrl.value,
        apiTokenEnv: form.elements.apiTokenEnv.value,
        gatewayTimeoutMs: Number(form.elements.gatewayTimeoutMs.value),
        webhookHost: form.elements.webhookHost.value,
        webhookPort: Number(form.elements.webhookPort.value),
        webhookPath: form.elements.webhookPath.value,
        webhookSecretEnv: form.elements.webhookSecretEnv.value,
        accountId: form.elements.accountId.value || undefined,
        acceptUnknownGroupSenders: form.elements.acceptUnknownGroupSenders.checked,
        nativeQuoteReplies: form.elements.nativeQuoteReplies.checked,
        ingestRetryMs: Number(form.elements.ingestRetryMs.value),
      };
  const value = {
    id,
    enabled: form.elements.enabled.checked,
    identityId: form.elements.identityId.value,
    displayName: form.elements.displayName.value,
    wakeWords: commaList(form.elements.wakeWords.value),
    operatorIds: commaList(form.elements.operatorIds.value),
    personaProfileId: form.elements.personaProfileId.value || null,
    ...(old?.soul ? { soul: old.soul } : {}),
    defaultGroupActivation: form.elements.defaultGroupActivation.value,
    chatModelProfileId: form.elements.chatModelProfileId.value || null,
    fastChatModelProfileId: form.elements.fastChatModelProfileId.value || null,
    participationJudgeModelProfileId: form.elements.participationJudgeModelProfileId.value || null,
    fallbackChatModelProfileIds: delimitedList(form.elements.fallbackChatModelProfileIds.value),
    visionModelProfileId: form.elements.visionModelProfileId.value || null,
    chatroomModelOverrides: old?.chatroomModelOverrides || [],
    imageUnderstandingEnabled: form.elements.imageUnderstandingEnabled.checked,
    databaseFile: old?.databaseFile || `bots/${id}/agent.sqlite`,
    channel,
    limits,
    socialSchedule: {
      enabled: form.elements.socialScheduleEnabled.checked,
      timezoneOffsetMinutes: Number(form.elements.timezoneOffsetMinutes.value),
      activeStartMinute: timeToMinute(form.elements.activeStartTime.value),
      activeEndMinute: timeToMinute(form.elements.activeEndTime.value),
      hotChatWindowMs: Number(form.elements.hotChatWindowMinutes.value) * 60000,
      hotChatMinMessages: Number(form.elements.hotChatMinMessages.value),
      hotChatMinParticipants: Number(form.elements.hotChatMinParticipants.value),
      hotChatCooldownMs: Number(form.elements.hotChatCooldownMinutes.value) * 60000,
      coldChatAfterMs: Number(form.elements.coldChatAfterHours.value) * 3600000,
      coldChatCooldownMs: Number(form.elements.coldChatCooldownHours.value) * 3600000,
      maxDailyAmbientMessages: Number(form.elements.maxDailyAmbientMessages.value),
      goodnightEnabled: form.elements.goodnightEnabled.checked,
      goodnightMinute: timeToMinute(form.elements.goodnightTime.value),
      activeGroupMinMessages: Number(form.elements.activeGroupMinMessages.value),
    },
    plugins: ensureBuiltInPluginConfigs(old?.plugins || []),
  };
  await withBusy(form.querySelector('button[type="submit"]'), async () => {
    try {
      await api("/api/bots", { method: "POST", body: value });
      $("#bot-dialog").close();
      toast("机器人配置已保存并应用");
      await reloadConfiguration();
    } catch (error) { toast(error.message, true); }
  });
}

function ensureBuiltInPluginConfigs(plugins) {
  const result = [...plugins];
  if (!result.some((plugin) => plugin.type === "morning-brief")) {
    result.push(structuredClone(DEFAULT_MORNING_BRIEF_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "pat-reply")) {
    result.push(structuredClone(DEFAULT_PAT_REPLY_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "group-summary")) {
    result.push(structuredClone(DEFAULT_GROUP_SUMMARY_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "scheduled-task")) {
    result.push(structuredClone(DEFAULT_SCHEDULED_TASK_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "auto-participation")) {
    result.push(structuredClone(DEFAULT_AUTO_PARTICIPATION_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "cold-chat-warmup")) {
    result.push(structuredClone(DEFAULT_COLD_CHAT_WARMUP_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "red-envelope-notify")) {
    result.push(structuredClone(DEFAULT_RED_ENVELOPE_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "repeater")) {
    result.push(structuredClone(DEFAULT_REPEATER_PLUGIN));
  }
  if (!result.some((plugin) => plugin.type === "magnet-code-search")) {
    result.push(structuredClone(DEFAULT_MAGNET_CODE_SEARCH_PLUGIN));
  }
  return result;
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = {
    defaultChatModelProfileId: form.elements.defaultChatModelProfileId.value || null,
    defaultVisionModelProfileId: form.elements.defaultVisionModelProfileId.value || null,
    defaultKnowledgeProfileId: form.elements.defaultKnowledgeProfileId.value || null,
    defaultPersonaProfileId: form.elements.defaultPersonaProfileId.value || null,
    logRetentionDays: Number(form.elements.logRetentionDays.value),
    maxLogRows: Number(form.elements.maxLogRows.value),
    statusRefreshMs: Number(form.elements.statusRefreshMs.value),
    participationRetentionDays: Number(form.elements.participationRetentionDays.value),
    maxParticipationCasesPerBot: Number(form.elements.maxParticipationCasesPerBot.value),
  };
  await withBusy(form.querySelector('button[type="submit"]'), async () => {
    try {
      const result = await api("/api/settings", { method: "PUT", body: value });
      state.settings = result.settings;
      state.status = result.status;
      scheduleRefresh();
      renderAll();
      toast("全局设置已保存并应用");
    } catch (error) { toast(error.message, true); }
  });
}

async function botAction(id, action) {
  try {
    await api(`/api/bots/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    toast(action === "gateway-check" ? "网关检查完成" : action === "webhook-test" ? "Webhook 测试已发送" : `操作 ${action} 已完成`);
    await reloadConfiguration();
  } catch (error) { toast(error.message, true); }
}

async function registerWebhook(bot) {
  const port = bot.channel.type === "wechat-ipad" ? bot.channel.callbackPort : bot.channel.webhookPort;
  const path = bot.channel.type === "wechat-ipad"
    ? `${bot.channel.callbackPathPrefix}/${encodeURIComponent(bot.channel.accountWxid)}/sync-message`
    : bot.channel.webhookPath;
  const url = `${location.protocol}//${location.hostname}:${port}${path}`;
  const target = bot.channel.type === "wechat-ipad"
    ? `${bot.channel.callbackAdvertiseHost}:${port}`
    : url;
  if (!(await confirmDialog({
    title: "注册回调",
    body: `向微信网关注册回调：\n${target}`,
  }))) return;
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/webhook-register`, {
      method: "POST",
      body: { url },
    });
    toast(result.created ? "Webhook 已注册" : "Webhook 已存在，无需重复注册");
  } catch (error) { toast(error.message, true); }
}

async function deleteBot(bot) {
  if (!(await confirmDialog({
    title: "删除机器人",
    body: `删除机器人配置“${bot.displayName}”？聊天数据库不会被物理删除。`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "DELETE" });
    toast("机器人配置已删除");
    await reloadConfiguration();
  } catch (error) { toast(error.message, true); }
}

async function deleteProvider(provider) {
  if (!(await confirmDialog({
    title: "删除 Provider",
    body: `删除 Provider 配置“${provider.label}”？`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
    toast("Provider 配置已删除");
    await reloadConfiguration();
  } catch (error) { toast(error.message, true); }
}

async function deleteKnowledgeProvider(provider) {
  if (!(await confirmDialog({
    title: "删除联网检索配置",
    body: `删除联网检索配置“${provider.label}”？`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/knowledge-providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
    toast("联网检索配置已删除");
    await reloadConfiguration();
  } catch (error) { toast(error.message, true); }
}

async function deleteMcpServer(server) {
  if (!(await confirmDialog({
    title: "删除 MCP 服务",
    body: `删除 MCP 服务“${server.label}”？`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/mcp-servers/${encodeURIComponent(server.id)}`, { method: "DELETE" });
    toast("MCP 服务已删除");
    await reloadConfiguration();
  } catch (error) { toast(error.message, true); }
}

async function deleteModel(model) {
  if (!(await confirmDialog({
    title: "删除模型配置",
    body: `删除模型配置“${model.label}”？`,
    danger: true,
    confirmText: "删除",
  }))) return;
  try {
    await api(`/api/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
    toast("模型配置已删除");
    await reloadConfiguration();
  } catch (error) { toast(error.message, true); }
}

async function pruneLogs() {
  try {
    const result = await api("/api/logs/prune", { method: "POST" });
    toast(`已清理 ${result.deleted} 条日志`);
    await refreshLogs();
  } catch (error) { toast(error.message, true); }
}

async function reloadConfiguration() {
  const [data, scheduledTasks, chatrooms] = await Promise.all([
    api("/api/bootstrap"),
    api("/api/scheduled-tasks"),
    api("/api/chatrooms"),
  ]);
  state.settings = data.settings;
  state.providerProfiles = data.providers;
  state.knowledgeProviders = data.knowledgeProviders || [];
  state.mcpServers = data.mcpServers || [];
  state.models = data.models;
  state.personas = data.personas || [];
  state.bots = data.bots;
  state.status = data.status;
  state.scheduledTasks = scheduledTasks.tasks || [];
  state.chatrooms = chatrooms.chatrooms || [];
  await refreshQualityOverview();
  renderAll();
}

async function refreshQualityOverview() {
  const entries = await Promise.all(state.bots.map(async (bot) => {
    try {
      const response = await api(`/api/participation/summary?botId=${encodeURIComponent(bot.id)}`);
      return [bot.id, response.summary];
    } catch {
      return [bot.id, null];
    }
  }));
  state.qualitySummaries = Object.fromEntries(entries.filter(([, summary]) => summary));
}

function applyProviderDefaults() {
  const form = $("#provider-form");
  const defaults = {
    openai: "https://api.openai.com/v1",
    xai: "https://api.x.ai/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    anthropic: "https://api.anthropic.com",
  }[form.elements.provider.value];
  if (!defaults) return;
  if (!form.elements.baseUrl.value) form.elements.baseUrl.value = defaults;
}

function providerApiLabel(api) {
  return {
    auto: "自动探测",
    "openai-completions": "OpenAI Completions / Grok",
    "openai-responses": "OpenAI Responses",
    "google-generative-ai": "Gemini",
    "anthropic-messages": "Anthropic Messages",
  }[api] || api;
}

function modelApiLabel(api, providerApi) {
  if (!api || api === "inherit") return `继承：${providerApiLabel(providerApi)}`;
  if (api === "auto") return "模型自动识别";
  return providerApiLabel(api);
}

function configuredModelChain(bot) {
  const primaryId = bot.chatModelProfileId || state.settings?.defaultChatModelProfileId;
  const primary = state.models.find((model) => model.id === primaryId);
  const stages = [];
  let internal = [];
  if (primary) {
    const category = modelCategory(primary);
    stages.push({ kind: "primary", label: primary.label, detail: category === "gemini" ? "Gemini 主模型" : "主模型" });
    if (category === "gemini") {
      internal = configuredInternalGeminiModels(primary);
      if (internal.length) {
        stages.push({
          kind: "gemini",
          label: `Gemini 内部轮转 ×${internal.length}`,
          detail: internal.map((model) => model.label).join(" / "),
        });
      }
    }
  }
  const internalIds = new Set(internal.map((model) => model.id));
  const external = (bot.fallbackChatModelProfileIds || []).map((id) =>
    state.models.find((model) => model.id === id) || { id, label: id, modelId: id, providerProfileId: "" })
    .filter((model) => model.id !== primaryId && !internalIds.has(model.id));
  external.forEach((model) => {
    const category = modelCategory(model);
    stages.push({
      kind: category === "local" ? "local" : category === "gemini" ? "gemini" : "remote",
      label: model.label,
      detail: category === "local" ? "本地最终降级" : category === "gemini" ? "Gemini 跨账户降级" : "GPT / 远程降级",
    });
  });
  return {
    stages,
    fastModel: state.models.find((model) => model.id === bot.fastChatModelProfileId),
    judgeModel: state.models.find((model) => model.id === bot.participationJudgeModelProfileId),
    hasGeminiPrimary: Boolean(primary && modelCategory(primary) === "gemini"),
    hasRemoteFallback: external.some((model) => modelCategory(model) === "remote"),
    hasLocalFallback: external.some((model) => modelCategory(model) === "local"),
  };
}

function configuredInternalGeminiModels(primary) {
  const order = [
    "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview",
    "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash",
    "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite",
  ];
  const primaryModelId = normalizedGeminiModelId(primary.modelId);
  const candidates = state.models.filter((candidate) => {
    const modelId = normalizedGeminiModelId(candidate.modelId);
    return candidate.enabled && candidate.id !== primary.id &&
      candidate.providerProfileId === primary.providerProfileId &&
      modelId.startsWith("gemini-") && !/(?:embedding|imagen|veo|tts|robotics|computer-use)/.test(modelId);
  });
  const byModelId = new Map();
  candidates.forEach((candidate) => {
    const modelId = normalizedGeminiModelId(candidate.modelId);
    if (!byModelId.has(modelId)) byModelId.set(modelId, candidate);
  });
  const primaryIndex = order.indexOf(primaryModelId);
  const preferred = primaryIndex >= 0
    ? [...order.slice(primaryIndex + 1), ...order.slice(0, primaryIndex)]
    : order;
  return [
    ...preferred.flatMap((modelId) => byModelId.has(modelId) ? [byModelId.get(modelId)] : []),
    ...[...byModelId.entries()]
      .filter(([modelId]) => !order.includes(modelId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, model]) => model),
  ];
}

function normalizedGeminiModelId(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().split("/").at(-1).replace(/-high$/, "");
}

function modelCategory(model) {
  const provider = state.providerProfiles.find((item) => item.id === model.providerProfileId);
  const modelId = String(model.modelId || "").normalize("NFKC").toLocaleLowerCase().split("/").at(-1);
  if (provider?.provider === "aistudio" || modelId.startsWith("gemini-")) return "gemini";
  if (provider && isLocalProvider(provider)) return "local";
  return "remote";
}

function isLocalProvider(provider) {
  const name = `${provider.id} ${provider.label} ${provider.provider}`.normalize("NFKC").toLocaleLowerCase();
  if (/(?:^|[\s._-])(?:local|ollama|lmstudio|llama\.cpp)(?:$|[\s._-])/.test(name)) return true;
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLocaleLowerCase();
    if (["localhost", "::1"].includes(hostname) || hostname.endsWith(".local")) return true;
    if (/^(?:127|10)\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
    const match = /^172\.(\d{1,2})\./.exec(hostname);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return false;
  }
}

function fillProviderProfileSelect() {
  const select = $("#model-form [name=providerProfileId]");
  const selected = state.editingModel?.providerProfileId || select.value;
  select.replaceChildren(
    option("", "选择 Provider 配置"),
    ...state.providerProfiles.map((provider) =>
      option(provider.id, `${provider.label} · ${provider.provider}${provider.enabled ? "" : "（停用）"}`),
    ),
  );
  select.value = selected || "";
}

function fillModelSelect(select, selected, emptyLabel) {
  select.replaceChildren(option("", emptyLabel), ...state.models.map((model) => option(model.id, model.label)));
  select.value = selected || "";
}

function fillLogBotFilter() {
  const select = $("#log-bot");
  const selected = select.value;
  select.replaceChildren(option("", "全部机器人"), ...state.bots.map((bot) => option(bot.id, bot.displayName)));
  select.value = selected;
}

function fillParticipationBotFilter() {
  const select = $("#participation-bot");
  const selected = select.value;
  select.replaceChildren(...state.bots.map((bot) => option(bot.id, bot.displayName)));
  if (state.bots.some((bot) => bot.id === selected)) select.value = selected;
}

function participationLabel(value) {
  return { speak: "应该说", silent: "不该说", unsure: "不确定" }[value] || "待评分";
}

function replyQualityLabel(value) {
  return { helpful: "有帮助", unhelpful: "需改进", unsure: "不确定" }[value] || "待评分";
}

function participationOutcome(value) {
  return {
    pending: "处理中",
    ignored: "保持沉默",
    silent: "模型主动沉默",
    replied: "已经回复",
    blocked: "输出被安全闸门拦截",
    failed: "执行失败",
  }[value] || value;
}

function nextWebhookPort() {
  const used = new Set(state.bots.map((bot) => bot.channel.type === "wechat-ipad" ? bot.channel.callbackPort : bot.channel.webhookPort));
  for (let port = 9000; port <= 9099; port += 1) if (!used.has(port)) return port;
  return 9100;
}

function phasePill(phase) {
  const labels = { running: "在线", offline: "离线", starting: "启动中", stopping: "停止中", stopped: "已停止", error: "异常" };
  return node("span", `pill ${phase}`, labels[phase] || phase);
}

function botAvailabilityPhase(bot) {
  if (!bot) return "stopped";
  return bot.phase === "running" && bot.gatewayHealthy === false ? "offline" : bot.phase;
}

function metric(value, label) {
  return node("div", "", [node("strong", "", String(value)), node("span", "", label)]);
}

function actionButton(label, handler, disabled = false, className = "") {
  const button = node("button", `small ${className}`.trim(), label);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function field(labelText, control) {
  const label = document.createElement("label");
  label.append(labelText, control);
  return label;
}

function empty(message) { return node("div", "empty", message); }
function option(value, label) { const item = document.createElement("option"); item.value = value; item.textContent = label; return item; }

function node(tag, className = "", content, attributes = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (Array.isArray(content)) element.append(...content);
  else if (content !== undefined && content !== null) element.textContent = String(content);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  });
  return element;
}

function prettyProtocol(value) {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value ?? ""); }
}

function showImagePreview(image, dataUrl) {
  image.hidden = !dataUrl;
  if (dataUrl) image.src = dataUrl;
  else image.removeAttribute("src");
}

async function imageFileDataUrl(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("只支持 JPEG、PNG 或 WebP 图片");
  }
  if (file.size < 16 || file.size > 5 * 1024 * 1024) throw new Error("图片必须小于 5 MiB");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取图片失败")));
    reader.addEventListener("error", () => reject(new Error("读取图片失败")));
    reader.readAsDataURL(file);
  });
}

function renderProtocolImage(container, value) {
  const encoded = findProtocolImage(value);
  const content = [node("pre", "protocol-json", prettyProtocol(value))];
  if (encoded) {
    const image = node("img", "protocol-image");
    image.alt = "微信二维码";
    image.src = encoded.startsWith("data:image/") ? encoded : `data:image/png;base64,${encoded}`;
    content.unshift(image);
  }
  container.replaceChildren(...content);
}

function findProtocolImage(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(value)) return value;
    if (value.length > 100 && /^[a-zA-Z0-9+/=\r\n]+$/.test(value)) return value.replace(/\s+/g, "");
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findProtocolImage(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value === "object") {
    const preferred = ["Base64", "base64", "QRCode", "QrCode", "qrcode", "Image", "image"];
    for (const key of preferred) if (key in value) { const found = findProtocolImage(value[key], depth + 1); if (found) return found; }
    for (const item of Object.values(value)) { const found = findProtocolImage(item, depth + 1); if (found) return found; }
  }
  return null;
}

function commaList(value) {
  return [...new Set(value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))];
}

function delimitedList(value) {
  return [...new Set(value.split(/[,，\n\r]/).map((item) => item.trim()).filter(Boolean))];
}

function minuteToTime(value) {
  const minute = Math.max(0, Math.min(1439, Number(value) || 0));
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function timeToMinute(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function timestampToLocalInput(timestamp, timezoneOffsetMinutes) {
  return new Date(timestamp + timezoneOffsetMinutes * 60000).toISOString().slice(0, 16);
}

function localInputToTimestamp(value, timezoneOffsetMinutes) {
  return Date.parse(`${value}:00Z`) - timezoneOffsetMinutes * 60000;
}

function taskStatusLabel(value) {
  return { never: "未运行", running: "运行中", succeeded: "上次成功", failed: "上次失败" }[value] || value;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("zh-CN", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value || 0);
}

function formatPercent(value) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value || 0);
}

function formatDuration(value) {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function formatUsd(value) {
  if (!value) return "$0";
  if (value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function toast(message, error = false) {
  const stack = $("#toast-stack");
  const text = String(message ?? "");
  const item = node("div", `toast${error ? " error" : ""}`);
  const dismiss = () => {
    if (!item.isConnected) return;
    item.classList.remove("show");
    setTimeout(() => item.remove(), 200);
  };
  const copy = node("button", "", "复制");
  copy.type = "button";
  copy.title = "复制详情文本";
  copy.addEventListener("click", async () => {
    const done = await copyText(text);
    copy.textContent = done ? "已复制" : "复制失败";
    setTimeout(() => { copy.textContent = "复制"; }, 1500);
  });
  const actions = node("div", "toast-actions", [copy]);
  if (error) {
    const close = node("button", "", "关闭");
    close.type = "button";
    close.addEventListener("click", dismiss);
    actions.append(close);
  }
  item.append(node("div", "toast-text", text), actions);
  stack.append(item);
  requestAnimationFrame(() => item.classList.add("show"));
  if (!error) setTimeout(dismiss, 3200);
  while (stack.children.length > 5) stack.firstElementChild.remove();
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 回退到 execCommand */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  } catch {
    return false;
  }
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${state.token}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}
