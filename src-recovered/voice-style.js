export const DEFAULT_TTS_VOICE = "Leda";
export const DEFAULT_TTS_STYLE = "年轻、愉悦、自然、有亲和力、感情丰富但不过度夸张的女性语气";
export const AISTUDIO_TTS_VOICES = [
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
    "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
    "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];
export const TTS_VOICE_PRESETS = Object.freeze([
    {
        id: "young-pleasant",
        label: "年轻愉悦女声",
        voice: "Leda",
        style: DEFAULT_TTS_STYLE,
        aliases: ["年轻女声", "年轻女生", "愉悦女声", "默认女声"],
    },
    {
        id: "light-lively",
        label: "轻盈活泼女声",
        voice: "Aoede",
        style: "年轻、轻盈、活泼、俏皮、有感染力的女性语气，节奏自然，不要过度卖萌",
        aliases: ["活泼女声", "轻盈女声", "俏皮女声", "元气女声"],
    },
    {
        id: "bright-friendly",
        label: "明亮亲切女声",
        voice: "Zephyr",
        style: "明亮、清晰、亲切、令人愉悦的年轻女性语气，带自然笑意和适度情感",
        aliases: ["明亮女声", "亲切女声", "阳光女声"],
    },
    {
        id: "warm-gentle",
        label: "温暖温柔女声",
        voice: "Sulafat",
        style: "温暖、温柔、细腻、富有同理心的女性语气，语速舒缓，感情真诚自然",
        aliases: ["温柔女声", "温暖女声", "治愈女声"],
    },
    {
        id: "calm-confident",
        label: "沉稳自信女声",
        voice: "Kore",
        style: "清晰、沉稳、自信、可靠的女性语气，表达坚定但不生硬，情绪克制自然",
        aliases: ["沉稳女声", "坚定女声", "知性女声"],
    },
    {
        id: "playful-energetic",
        label: "俏皮元气声",
        voice: "Puck",
        style: "活泼、俏皮、元气十足、节奏轻快的年轻语气，情绪丰富但不要浮夸",
        aliases: ["俏皮声音", "元气声音", "活泼声音"],
    },
]);
export function normalizeTtsVoice(value) {
    const requested = value?.normalize("NFKC").trim() || DEFAULT_TTS_VOICE;
    const voice = AISTUDIO_TTS_VOICES.find((candidate) => candidate.toLocaleLowerCase() === requested.toLocaleLowerCase());
    if (!voice)
        throw new Error(`AIStudio TTS voice is unsupported: ${requested}`);
    return voice;
}
export function ttsVoicePreset(value) {
    const key = voiceStyleKey(value ?? "");
    if (!key)
        return undefined;
    return TTS_VOICE_PRESETS.find((preset) => voiceStyleKey(preset.id) === key ||
        voiceStyleKey(preset.label) === key ||
        preset.aliases.some((alias) => voiceStyleKey(alias) === key));
}
export function matchingTtsVoicePreset(voice, style) {
    if (!voice || !style)
        return undefined;
    const normalizedVoice = normalizeTtsVoice(voice);
    const normalizedStyle = normalizeTtsStyle(style);
    return TTS_VOICE_PRESETS.find((preset) => preset.voice === normalizedVoice && normalizeTtsStyle(preset.style) === normalizedStyle);
}
export function resolveTtsVoiceStyleQuery(value, current = {}) {
    const query = normalizeTtsStyle(value);
    const exactPreset = ttsVoicePreset(query);
    if (exactPreset)
        return presetSelection(exactPreset);
    const lower = query.toLocaleLowerCase();
    const explicitVoice = AISTUDIO_TTS_VOICES.find((voice) => lower.includes(voice.toLocaleLowerCase()));
    if (explicitVoice) {
        const style = query
            .replace(new RegExp(explicitVoice, "igu"), " ")
            .replace(/(?:音色|声音|语音|voice|风格|使用|改用|选择)/giu, " ")
            .replace(/^[\s,，:：·；;、-]+|[\s,，:：·；;、-]+$/gu, "")
            .trim();
        return {
            voice: explicitVoice,
            style: style || normalizeTtsStyle(current.style || DEFAULT_TTS_STYLE),
            presetId: null,
            presetLabel: null,
        };
    }
    const describedPreset = TTS_VOICE_PRESETS.find((preset) => [preset.label, ...preset.aliases].some((alias) => lower.includes(alias.toLocaleLowerCase())));
    return {
        voice: describedPreset?.voice ?? normalizeTtsVoice(current.voice),
        style: query,
        presetId: null,
        presetLabel: null,
    };
}
export function normalizeTtsStyle(value) {
    const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (!normalized)
        throw new Error("AIStudio speech style cannot be empty");
    if ([...normalized].length > 200)
        throw new Error("AIStudio speech style exceeds 200 characters");
    return normalized;
}
function presetSelection(preset) {
    return {
        voice: preset.voice,
        style: preset.style,
        presetId: preset.id,
        presetLabel: preset.label,
    };
}
function voiceStyleKey(value) {
    return value.normalize("NFKC").trim().replace(/[\s_.,，。:：·；;、-]+/gu, "").toLocaleLowerCase();
}
//# sourceMappingURL=voice-style.js.map