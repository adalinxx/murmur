// What happened to you on Murmur, read from public records: replies, quotes,
// reposts and likes of your posts, posts that mention your @handle, and new
// followers. Nothing tells you; the page works it out from the chain.
//
// Posts carry their time. Likes and follows don't, so the reader passes
// `firstSeen`: when this device first saw each one (`like:<a>/<author>/<id>`,
// `follow:<a>`), kept on the device. Unseen ones count from the time of the
// liked post, or from 0 for a follow.
//
//   const { items } = notifications(await murmur.snapshot(), me, { followers, handle, firstSeen });

/** The @handles a post's text names, lowercased, as the page links them. */
export function mentioned(text) {
  const found = new Set();
  for (const match of String(text ?? "").matchAll(/(^|[^a-z0-9_@])@([a-z0-9_]{1,30})(?![a-z0-9_])/gi)) found.add(match[2].toLowerCase());
  return found;
}

const keyOf = (to) => `${to.author}/${to.id}`;
const DAY = 86_400_000;

/**
 * `{ items, keys }`: what happened to `me`, newest first, and the like and
 * follow keys seen (for the caller to stamp in `firstSeen`). Each item is one of:
 *   { type: "reply" | "quote" | "mention", at, post, target? }     one post
 *   { type: "like" | "repost", at, target, actors }               grouped by your post
 *   { type: "follow", at, actors }                                grouped by day
 * `actors` newest first. Muted accounts and your own actions are left out.
 */
export function notifications({ posts, likes }, me, { followers = [], handle, firstSeen = new Map(), muted = new Set(), limit = 100 } = {}) {
  const byKey = new Map(posts.map((p) => [keyOf(p), p]));
  const mine = (to) => to && to.author === me && byKey.has(keyOf(to)) && !byKey.get(keyOf(to)).repost;
  const items = [];
  const groups = new Map(); // "like|repost <key>" → item
  const group = (type, target, actor, at) => {
    const k = `${type} ${keyOf(target)}`;
    if (!groups.has(k)) groups.set(k, { type, target, actors: [], at: 0, times: new Map() });
    const g = groups.get(k);
    if (g.times.has(actor)) return;
    g.times.set(actor, at);
    g.at = Math.max(g.at, at);
  };
  const me_ = handle?.toLowerCase();
  for (const p of posts) {
    if (p.author === me || muted.has(p.author)) continue;
    if (mine(p.reply)) items.push({ type: "reply", at: p.at, post: p, target: byKey.get(keyOf(p.reply)) });
    else if (mine(p.quote)) items.push({ type: "quote", at: p.at, post: p, target: byKey.get(keyOf(p.quote)) });
    else if (mine(p.repost)) group("repost", byKey.get(keyOf(p.repost)), p.author, p.at);
    else if (me_ && !p.repost && mentioned(p.text).has(me_)) items.push({ type: "mention", at: p.at, post: p });
  }
  const keys = [];
  for (const { account, author, id } of likes) {
    if (author !== me || account === me || muted.has(account)) continue;
    const target = byKey.get(`${author}/${id}`);
    if (!target || target.repost) continue;
    const key = `like:${account}/${author}/${id}`;
    keys.push(key);
    group("like", target, account, firstSeen.get(key) ?? target.at);
  }
  for (const g of groups.values()) {
    g.actors = [...g.times].sort((a, b) => b[1] - a[1]).map(([a]) => a);
    delete g.times;
    items.push(g);
  }
  const follows = new Map(); // day → { at, actors: [[a, at]] }
  for (const account of followers) {
    if (account === me || muted.has(account)) continue;
    const key = `follow:${account}`;
    keys.push(key);
    const at = firstSeen.get(key) ?? 0;
    const day = Math.floor(at / DAY);
    if (!follows.has(day)) follows.set(day, { type: "follow", at: 0, actors: [] });
    const f = follows.get(day);
    f.actors.push([account, at]);
    f.at = Math.max(f.at, at);
  }
  for (const f of follows.values()) items.push({ ...f, actors: f.actors.sort((a, b) => b[1] - a[1]).map(([a]) => a) });
  items.sort((a, b) => b.at - a.at);
  return { items: items.slice(0, limit), keys };
}
