const MAX_TERMS = 96;
/**
 * Produces an embedding-free search index that still works for Chinese text.
 * Latin words are indexed whole; CJK runs are indexed as overlapping bigrams
 * and trigrams, with single characters kept only for one-character runs.
 */
export function extractSearchTerms(input, maxTerms = MAX_TERMS) {
    const normalized = input.normalize("NFKC").toLocaleLowerCase().trim();
    const terms = new Set();
    for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
        const chars = [...match[0]];
        if (chars.length === 1) {
            terms.add(chars[0]);
            continue;
        }
        for (const size of [2, 3]) {
            for (let index = 0; index <= chars.length - size; index += 1) {
                terms.add(chars.slice(index, index + size).join(""));
                if (terms.size >= maxTerms)
                    return [...terms];
            }
        }
    }
    for (const match of normalized.matchAll(/[\p{L}\p{N}_@.+#:/-]+/gu)) {
        const token = match[0].replace(/^[_.+:/-]+|[_.+:/-]+$/g, "");
        if (token.length >= 2 && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) {
            terms.add(token);
            if (terms.size >= maxTerms)
                break;
        }
    }
    return [...terms];
}
//# sourceMappingURL=search-terms.js.map