// Finding posts by their words, over the snapshot the page already reads:
// every word of the query must be in the post, any case and accents aside;
// a #tag or @handle matches only as a whole tag or handle. Newest first.

const fold = (text) => String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** The query's words: plain words, #tags and @handles, folded. */
export function terms(query) {
  return [...new Set(fold(query).split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}#@_]+|[^\p{L}\p{N}_]+$/gu, "")).filter((w) => w && w !== "#" && w !== "@"))];
}

/** Whether `text` holds every one of `words` (from `terms`). */
export function matches(text, words) {
  const t = fold(text);
  return words.length > 0 && words.every((w) => {
    if (w[0] !== "#" && w[0] !== "@") return t.includes(w);
    const at = new RegExp(`(^|[^\\p{L}\\p{N}_#@])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");
    return at.test(t);
  });
}

/** The posts (not reposts) whose text holds every word of `query`, newest first; at most `limit`. */
export function searchPosts(posts, query, { limit = 100, muted = new Set() } = {}) {
  const words = terms(query);
  if (!words.length) return [];
  return posts
    .filter((p) => !p.repost && !muted.has(p.author) && matches(p.text, words))
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, limit);
}
