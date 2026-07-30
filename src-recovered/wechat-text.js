/** Convert common Markdown emitted by models into readable WeChat plain text. */
export function toWechatPlainText(value) {
    let text = value.replace(/\r\n?/gu, "\n");
    // Keep fenced-code contents, but discard the Markdown fence and language tag.
    text = text.replace(/^[ \t]*```[^\n]*\n?/gmu, "").replace(/^[ \t]*```[ \t]*$/gmu, "");
    text = text
        .replace(/!\[([^\]]*)\]\((\S+?)(?:\s+["'][^"']*["'])?\)/gu, (_match, label, url) => `${label.trim() || "图片"}：${url}`)
        .replace(/\[([^\]]+)\]\((\S+?)(?:\s+["'][^"']*["'])?\)/gu, (_match, label, url) => {
        const title = label.trim();
        return title === url ? url : `${title}：${url}`;
    })
        .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/giu, "$1")
        .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
        .replace(/^\s{0,3}>\s?/gmu, "")
        .replace(/^[ \t]*[-*+][ \t]+\[x\][ \t]+/gimu, "☑ ")
        .replace(/^[ \t]*[-*+][ \t]+\[[ \t]\][ \t]+/gmu, "☐ ")
        .replace(/^[ \t]*[-*+][ \t]+/gmu, "• ")
        .replace(/^[ \t]*(\d{1,3})[.)][ \t]+/gmu, "$1、")
        .replace(/^[ \t]*(?:-{3,}|_{3,}|\*{3,})[ \t]*$/gmu, "")
        .replace(/~~([^\n~]+)~~/gu, "$1")
        .replace(/\*\*([^\n*]+)\*\*/gu, "$1")
        .replace(/__([^\n_]+)__/gu, "$1")
        .replace(/(?<!\*)\*([^\n*]+)\*(?!\*)/gu, "$1")
        .replace(/(?<!_)_([^\n_]+)_(?!_)/gu, "$1")
        .replace(/`([^`\n]+)`/gu, "$1")
        .replace(/\\([\\`*_[\]{}()#+.!>-])/gu, "$1");
    const lines = text.split("\n");
    const plainLines = [];
    for (const line of lines) {
        if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(line))
            continue;
        if (/^\s*\|.*\|\s*$/u.test(line)) {
            const cells = line.trim().replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim()).filter(Boolean);
            plainLines.push(cells.join(" · "));
        }
        else {
            plainLines.push(line.replace(/[ \t]+$/gu, ""));
        }
    }
    return plainLines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}
//# sourceMappingURL=wechat-text.js.map