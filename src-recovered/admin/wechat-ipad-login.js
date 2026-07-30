import { randomBytes } from "node:crypto";
import { AdminStore } from "./admin-store.js";
import { AgentSupervisor } from "./supervisor.js";
import { runWechatIpadProtocolRequest } from "../wechat-ipad-request-queue.js";
const DEFAULT_UUID_BASE_URL = "http://wechat-uuid:9000";
const DEFAULT_SLIDER_BASE_URL = "http://wechat-slider:9000";
const DEFAULT_SESSION_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_CLIENT_VERSION = 0x27002f34;
const DEFAULT_DEVICE_TYPE = "iPad13,18";
/**
 * Owns short-lived iPad login credentials. Secrets never leave this object and
 * are intentionally discarded when the process restarts or login completes.
 */
export class WechatIpadLoginManager {
    #store;
    #supervisor;
    #env;
    #fetch;
    #uuidBaseUrl;
    #sliderBaseUrl;
    #sliderToken;
    #timeoutMs;
    #sessionTtlMs;
    #sessions = new Map();
    constructor(options) {
        this.#store = options.store;
        this.#supervisor = options.supervisor;
        this.#env = options.env ?? process.env;
        this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.#uuidBaseUrl = normalizedBaseUrl(options.uuidBaseUrl ?? this.#env.WECHAT_IPAD_UUID_BASE_URL ?? DEFAULT_UUID_BASE_URL);
        this.#sliderBaseUrl = normalizedBaseUrl(options.sliderBaseUrl ?? this.#env.WECHAT_IPAD_SLIDER_BASE_URL ?? DEFAULT_SLIDER_BASE_URL);
        this.#sliderToken = options.sliderToken?.trim() || this.#env.WECHAT_IPAD_SLIDER_TOKEN?.trim() || undefined;
        this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "login timeoutMs");
        this.#sessionTtlMs = positiveInteger(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, "login sessionTtlMs");
    }
    async status(botId) {
        const bot = this.#ipadBot(botId);
        const online = await this.#onlineStatus(bot).catch(() => undefined);
        if (online)
            return online;
        const session = this.#sessions.get(botId);
        if (!session) {
            return {
                phase: "offline",
                accountWxid: bot.channel.accountWxid,
                sliderAvailable: this.sliderAvailable(),
                message: "微信未在线，可以申请新的登录二维码",
            };
        }
        if (session.expiresAt <= Date.now() && session.phase !== "expired") {
            session.phase = "expired";
            session.message = "二维码已过期，请重新申请";
            this.#clearSecrets(session);
        }
        return this.#publicStatus(session);
    }
    async start(botId, input = {}) {
        const bot = this.#ipadBot(botId);
        const online = await this.#onlineStatus(bot).catch(() => undefined);
        if (online)
            return online;
        const loginType = loginTypeValue(input.loginType ?? "ipad");
        const deviceName = safeDeviceName(input.deviceName ?? loginDeviceName(loginType));
        const deviceId = await this.#newDeviceId();
        const envelope = await this.#protocolRequest(bot.channel, loginEndpoint(loginType), {
            DeviceID: deviceId,
            DeviceName: deviceName,
            LoginType: loginType,
            Proxy: {},
        });
        if (envelope.Success !== true)
            throw protocolError(envelope, "申请微信登录二维码失败");
        const data = recordOrEmpty(envelope.Data);
        const wxid = findWxid(envelope.Data);
        if (wxid)
            return this.#finalize(bot, wxid, envelope.Data);
        const uuid = firstString(data, "Uuid", "UUID", "uuid") ?? firstString(envelope, "Uuid", "UUID", "uuid");
        if (!uuid)
            throw new Error("微信协议没有返回二维码 UUID");
        const data62 = firstString(data, "Data62", "data62") ?? firstString(envelope, "Data62", "data62");
        const qrBase64 = firstString(data, "QrBase64", "QRCodeBase64", "qrBase64", "qrcodeBase64");
        const qrUrl = firstString(data, "QrUrl", "QRCodeURL", "qrUrl", "qrcodeUrl");
        const session = {
            botId,
            phase: "qr",
            loginType,
            uuid,
            ...(data62 ? { data62 } : {}),
            ...(qrBase64 ? { qrImage: imageDataUrl(qrBase64) } : {}),
            qrContent: qrUrl ?? `http://weixin.qq.com/x/${uuid}`,
            expiresAt: Date.now() + this.#sessionTtlMs,
            message: "请使用微信扫码，并在手机上确认登录",
        };
        this.#sessions.set(botId, session);
        this.#log("info", "ipad.login.qr_created", "已创建微信登录二维码", botId);
        return this.#publicStatus(session);
    }
    async poll(botId) {
        const bot = this.#ipadBot(botId);
        const session = this.#requiredSession(botId);
        if (session.phase === "expired" || session.phase === "error")
            return this.#publicStatus(session);
        if (session.expiresAt <= Date.now()) {
            session.phase = "expired";
            session.message = "二维码已过期，请重新申请";
            this.#clearSecrets(session);
            return this.#publicStatus(session);
        }
        const envelope = await this.#protocolRequest(bot.channel, `/Login/LoginCheckQR?uuid=${encodeURIComponent(session.uuid)}`, {}, true);
        const data = recordOrEmpty(envelope.Data);
        const ticket = firstString(data, "Ticket", "ticket") ??
            firstString(envelope, "Ticket", "ticket") ??
            (codeString(envelope.Code) === "-3" && typeof envelope.Data === "string" ? envelope.Data.trim() : undefined);
        if (ticket) {
            if (session.phase === "waiting-confirmation" && session.ticket === ticket) {
                session.message = "验证已提交，请继续在手机上确认登录";
                return this.#publicStatus(session);
            }
            session.ticket = ticket;
            session.phase = "verification";
            session.message = "手机要求安全验证，请选择六位安全码或滑块验证";
            this.#log("info", "ipad.login.verification_required", "微信登录需要安全验证", botId);
            return this.#publicStatus(session);
        }
        const wxid = findWxid(envelope.Data);
        if (wxid)
            return this.#finalize(bot, wxid, envelope.Data);
        const status = numberValue(data.Status ?? data.status);
        const expiredSeconds = numberValue(data.ExpiredTime ?? data.expiredTime);
        if (status === 4 || (expiredSeconds !== undefined && expiredSeconds < 10)) {
            session.phase = "expired";
            session.message = "二维码已过期，请重新申请";
            this.#clearSecrets(session);
            return this.#publicStatus(session);
        }
        if (envelope.Success !== true && codeString(envelope.Code) !== "0") {
            session.phase = "error";
            session.message = safeProtocolMessage(envelope, "登录状态检查失败");
            return this.#publicStatus(session);
        }
        const nickname = firstString(data, "NickName", "nickName", "Nickname", "nickname");
        const headImageUrl = firstString(data, "HeadImgUrl", "headImgUrl", "HeadUrl", "headUrl");
        if (nickname)
            session.nickname = nickname;
        if (headImageUrl)
            session.headImageUrl = headImageUrl;
        if (headImageUrl || status === 2 || status === 3) {
            session.phase = "scanned";
            session.message = "二维码已扫描，请在手机上确认登录";
        }
        if (expiredSeconds !== undefined) {
            session.expiresAt = Math.min(session.expiresAt, Date.now() + Math.max(0, expiredSeconds) * 1000);
        }
        return this.#publicStatus(session);
    }
    async submitSecurityCode(botId, code) {
        const bot = this.#ipadBot(botId);
        const session = this.#requiredSession(botId);
        if (!/^\d{6}$/.test(code))
            throw new Error("安全码必须是六位数字");
        if (!session.ticket || !session.data62)
            throw new Error("当前登录会话没有可用的安全验证信息");
        const envelope = await this.#protocolRequest(bot.channel, "/Login/YPayVerificationcode", {
            Code: code,
            Data62: session.data62,
            Ticket: session.ticket,
            Uuid: session.uuid,
        });
        if (envelope.Success !== true)
            throw protocolError(envelope, "安全码提交失败");
        session.phase = "waiting-confirmation";
        session.message = "安全码已提交，请在手机上确认；系统会继续检查登录状态";
        this.#log("info", "ipad.login.security_code_submitted", "微信安全码已提交", botId);
        return this.#publicStatus(session);
    }
    cancel(botId) {
        const bot = this.#ipadBot(botId);
        this.#sessions.delete(botId);
        this.#log("info", "ipad.login.cancelled", "微信登录会话已取消", botId);
        return {
            phase: "offline",
            accountWxid: bot.channel.accountWxid,
            sliderAvailable: this.sliderAvailable(),
            message: "登录会话已取消",
        };
    }
    sliderAvailable() {
        if (!this.#sliderToken)
            return false;
        const expiresAt = jwtExpiration(this.#sliderToken);
        return expiresAt === undefined || expiresAt > Date.now() + 30_000;
    }
    createSliderUrl(botId) {
        const session = this.#requiredSession(botId);
        if (!session.ticket || !session.data62 || session.phase !== "verification") {
            throw new Error("当前登录会话不需要滑块验证");
        }
        if (!this.sliderAvailable())
            throw new Error("滑块服务令牌未配置或已过期，请改用手机显示的六位安全码");
        session.sliderNonce = randomBytes(32).toString("base64url");
        return `/ipad-login/slider/${session.sliderNonce}`;
    }
    async sliderPage(nonce) {
        const session = this.#sessionByNonce(nonce);
        const query = new URLSearchParams({
            data62: session.data62,
            ticket: session.ticket,
            device_type: DEFAULT_DEVICE_TYPE,
            client_version: String(DEFAULT_CLIENT_VERSION),
        });
        const payload = await this.#sliderRequest(`/api/v1/slider-verify-html?${query}`, { method: "GET" });
        const html = typeof payload === "string" ? payload : firstString(recordOrEmpty(payload), "data", "Data");
        if (!html || !html.includes("<"))
            throw new Error("滑块服务没有返回验证页面");
        const submitPath = `/ipad-login/slider-submit/${nonce}?`;
        return html
            .replaceAll("/api/v1/robot/login/slider-verify-submit?", submitPath)
            .replaceAll("/api/v1/slider-verify-submit?", submitPath);
    }
    async submitSlider(nonce, params) {
        const session = this.#sessionByNonce(nonce);
        const body = {
            data: params.get("data") ?? "",
            verifyid: params.get("verifyid") ?? params.get("verify_id") ?? "",
            secticket: params.get("secticket") ?? "",
            randstr: params.get("randstr") ?? "",
            ticket: params.get("ticket") ?? session.ticket,
            client_version: numberValue(params.get("client_version")) ?? DEFAULT_CLIENT_VERSION,
            device_type: params.get("device_type") ?? DEFAULT_DEVICE_TYPE,
            ret: numberValue(params.get("ret")) ?? 0,
            errorCode: numberValue(params.get("errorCode")) ?? 0,
            errorMessage: params.get("errorMessage") ?? "",
        };
        const result = await this.#sliderRequest("/api/v1/commit-verify-code", {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(body),
        });
        session.phase = "waiting-confirmation";
        session.message = "滑块验证已提交，请在手机上确认登录";
        this.#log("info", "ipad.login.slider_submitted", "微信滑块验证已提交", session.botId);
        return result;
    }
    #ipadBot(botId) {
        const bot = this.#store.getBot(botId);
        if (!bot)
            throw new Error(`机器人 ${botId} 不存在`);
        if (bot.channel.type !== "wechat-ipad")
            throw new Error("该机器人不是 wechat-ipad Channel");
        return bot;
    }
    #requiredSession(botId) {
        const session = this.#sessions.get(botId);
        if (!session)
            throw new Error("没有进行中的微信登录会话");
        return session;
    }
    #sessionByNonce(nonce) {
        if (!/^[a-zA-Z0-9_-]{40,100}$/.test(nonce))
            throw new Error("滑块会话无效");
        const session = [...this.#sessions.values()].find((candidate) => candidate.sliderNonce === nonce);
        if (!session || session.expiresAt <= Date.now())
            throw new Error("滑块会话无效或已过期");
        return session;
    }
    async #onlineStatus(bot) {
        await this.#protocolRequest(bot.channel, `/Login/AutoHeartBeat?wxid=${encodeURIComponent(bot.channel.accountWxid)}`, {}, false, 5_000);
        const envelope = await this.#protocolRequest(bot.channel, `/Login/GetCacheInfo?wxid=${encodeURIComponent(bot.channel.accountWxid)}`, {}, true);
        if (envelope.Success !== true)
            return undefined;
        const data = recordOrEmpty(envelope.Data);
        const wxid = firstString(data, "Wxid", "WxId", "wxid");
        if (!wxid || wxid !== bot.channel.accountWxid)
            return undefined;
        this.#sessions.delete(bot.id);
        const nickname = firstString(data, "NickName", "Nickname", "nickName");
        const headImageUrl = firstString(data, "HeadUrl", "HeadImgUrl", "headImgUrl");
        return {
            phase: "online",
            accountWxid: wxid,
            ...(nickname ? { nickname } : {}),
            ...(headImageUrl ? { headImageUrl } : {}),
            sliderAvailable: this.sliderAvailable(),
            message: "微信已在线，当前登录态受到保护",
        };
    }
    async #finalize(bot, wxid, data) {
        await this.#protocolRequest(bot.channel, `/Login/AutoHeartBeat?wxid=${encodeURIComponent(wxid)}`, {});
        const updated = {
            ...bot,
            identityId: wxid,
            channel: { ...bot.channel, accountWxid: wxid },
        };
        this.#store.saveBot(updated);
        await this.#registerCallback(updated.channel, wxid);
        await this.#supervisor.reconcileBot(bot.id);
        this.#sessions.delete(bot.id);
        const object = recordOrEmpty(data);
        const nickname = firstString(object, "NickName", "Nickname", "nickName");
        this.#log("info", "ipad.login.succeeded", `微信账号 ${wxid} 登录成功`, bot.id);
        return {
            phase: "online",
            accountWxid: wxid,
            ...(nickname ? { nickname } : {}),
            sliderAvailable: this.sliderAvailable(),
            message: "微信登录成功，心跳、回调和机器人身份已自动更新",
        };
    }
    async #registerCallback(config, wxid) {
        const response = await this.#fetch(new URL("register", `${config.callbackRouterBaseUrl.replace(/\/$/, "")}/`), {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ wxid, client_host: `${config.callbackAdvertiseHost}:${config.callbackPort}` }),
            signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (!response.ok)
            throw new Error(`微信回调注册失败（HTTP ${response.status}）`);
    }
    async #newDeviceId() {
        const response = await this.#fetch(new URL("api/v1/uuid", `${this.#uuidBaseUrl}/`), {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ data: "0" }),
            signal: AbortSignal.timeout(this.#timeoutMs),
        });
        const payload = await jsonResponse(response, "设备标识服务");
        const object = recordOrEmpty(payload);
        const deviceId = firstString(object, "data", "Data");
        if (!response.ok || !deviceId)
            throw new Error("设备标识服务没有返回有效 DeviceID");
        return deviceId;
    }
    async #protocolRequest(config, path, body, allowFailure = false, timeoutMs = Math.min(config.apiTimeoutMs, this.#timeoutMs)) {
        return runWechatIpadProtocolRequest(config.apiBaseUrl, config.accountWxid, () => this.#protocolRequestNow(config, path, body, allowFailure, timeoutMs));
    }
    async #protocolRequestNow(config, path, body, allowFailure, timeoutMs) {
        const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json; charset=utf-8" });
        if (config.apiTokenEnv) {
            const token = this.#env[config.apiTokenEnv]?.trim();
            if (!token)
                throw new Error(`环境变量 ${config.apiTokenEnv} 未配置`);
            headers.set("Authorization", `Bearer ${token}`);
        }
        const response = await this.#fetch(new URL(path.replace(/^\//, ""), `${config.apiBaseUrl.replace(/\/$/, "")}/`), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const payload = await jsonResponse(response, "微信协议服务");
        if (!isRecord(payload))
            throw new Error("微信协议服务返回格式错误");
        const envelope = payload;
        if ((!response.ok || envelope.Success !== true) && !allowFailure)
            throw protocolError(envelope, "微信协议请求失败");
        return envelope;
    }
    async #sliderRequest(path, init) {
        if (!this.#sliderToken || !this.sliderAvailable())
            throw new Error("滑块服务令牌未配置或已过期");
        for (const authorization of [this.#sliderToken, `Bearer ${this.#sliderToken}`]) {
            const headers = new Headers(init.headers);
            headers.set("Accept", "application/json, text/html;q=0.9");
            headers.set("Authorization", authorization);
            const response = await this.#fetch(new URL(path.replace(/^\//, ""), `${this.#sliderBaseUrl}/`), {
                ...init,
                headers,
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
            const text = await response.text();
            const payload = parseMaybeJson(text);
            const object = recordOrEmpty(payload);
            const code = numberValue(object.code ?? object.Code);
            if (code === 401)
                continue;
            if (!response.ok || (code !== undefined && code !== 0 && code !== 200)) {
                throw new Error(firstString(object, "message", "Message") ?? `滑块服务请求失败（HTTP ${response.status}）`);
            }
            return payload;
        }
        throw new Error("滑块服务拒绝了当前令牌，请更新 WECHAT_IPAD_SLIDER_TOKEN");
    }
    #publicStatus(session) {
        return {
            phase: session.phase,
            ...(session.qrImage && session.phase !== "expired" ? { qrImage: session.qrImage } : {}),
            ...(session.qrContent && session.phase !== "expired" ? { qrContent: session.qrContent } : {}),
            ...(session.nickname ? { nickname: session.nickname } : {}),
            ...(session.headImageUrl ? { headImageUrl: session.headImageUrl } : {}),
            expiresInSeconds: Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)),
            loginType: session.loginType,
            sliderAvailable: this.sliderAvailable(),
            message: session.message,
        };
    }
    #clearSecrets(session) {
        session.uuid = "";
        delete session.data62;
        delete session.ticket;
        delete session.qrImage;
        delete session.qrContent;
        delete session.sliderNonce;
    }
    #log(level, event, message, botId) {
        try {
            this.#store.appendLog({ level, scope: "channel", event, message, botId });
        }
        catch {
            // Login must not fail because control-plane logging is unavailable.
        }
    }
}
function loginEndpoint(type) {
    switch (type) {
        case "ipad": return "/Login/LoginGetQR";
        case "win": return "/Login/LoginGetQRWinUnified";
        case "mac": return "/Login/LoginGetQRMac";
        case "car": return "/Login/LoginGetQRCar";
        case "android-pad": return "/Login/LoginGetQRPad";
    }
}
function loginDeviceName(type) {
    switch (type) {
        case "ipad": return "iPad";
        case "win": return "Windows";
        case "mac": return "Mac";
        case "car": return "Car";
        case "android-pad": return "Android Pad";
    }
}
function loginTypeValue(value) {
    if (value === "ipad" || value === "win" || value === "mac" || value === "car" || value === "android-pad")
        return value;
    throw new Error("不支持的微信登录类型");
}
function safeDeviceName(value) {
    const normalized = value.trim();
    if (!normalized || normalized.length > 80 || /[\u0000-\u001f]/u.test(normalized))
        throw new Error("设备名称无效");
    return normalized;
}
function imageDataUrl(value) {
    const normalized = value.trim();
    if (normalized.startsWith("data:image/"))
        return normalized;
    return `data:image/png;base64,${normalized.replace(/\s+/g, "")}`;
}
function findWxid(value, depth = 0) {
    if (depth > 8)
        return undefined;
    if (Array.isArray(value)) {
        for (const child of value) {
            const found = findWxid(child, depth + 1);
            if (found)
                return found;
        }
        return undefined;
    }
    if (!isRecord(value))
        return undefined;
    for (const key of ["userName", "UserName", "username", "Wxid", "WxId", "wxid"]) {
        const found = stringValue(value[key]);
        if (found?.startsWith("wxid_"))
            return found;
    }
    for (const child of Object.values(value)) {
        const found = findWxid(child, depth + 1);
        if (found)
            return found;
    }
    return undefined;
}
function firstString(object, ...keys) {
    for (const key of keys) {
        const value = stringValue(object[key]);
        if (value)
            return value;
    }
    return undefined;
}
function stringValue(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return undefined;
    const normalized = String(value).trim();
    return normalized || undefined;
}
function numberValue(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
function codeString(value) {
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
function protocolError(envelope, fallback) {
    return new Error(safeProtocolMessage(envelope, fallback));
}
function safeProtocolMessage(envelope, fallback) {
    const message = stringValue(envelope.Message);
    if (!message || message.length > 300)
        return fallback;
    return `${fallback}：${message}`;
}
function jwtExpiration(token) {
    const payload = token.split(".")[1];
    if (!payload)
        return undefined;
    try {
        const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return typeof value.exp === "number" && Number.isFinite(value.exp) ? value.exp * 1000 : undefined;
    }
    catch {
        return undefined;
    }
}
async function jsonResponse(response, service) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : {};
    }
    catch {
        throw new Error(`${service}返回了非 JSON 内容`);
    }
}
function parseMaybeJson(text) {
    try {
        return text ? JSON.parse(text) : {};
    }
    catch {
        return text;
    }
}
function recordOrEmpty(value) {
    return isRecord(value) ? value : {};
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizedBaseUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("服务地址必须使用 HTTP 或 HTTPS");
    return url.toString().replace(/\/$/, "");
}
function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer`);
    return value;
}
//# sourceMappingURL=wechat-ipad-login.js.map