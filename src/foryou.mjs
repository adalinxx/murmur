// For you: Murmur's ranked timeline, computed in the reader's browser from
// public records (posts, likes, follows) and the reader's own feedback, which
// never leaves the device.
//
// Accounts, likes and follows cost nothing but a moment of work, so raw
// counts can be farmed. Engagement here counts only in proportion to the
// engager's trust, which flows a few steps out from the reader along follows,
// split by how many each account follows (SybilRank's early-terminated walk).
// An account nobody the reader trusts follows adds nothing, however many it
// makes. On top come a hand-weighted value, time decay, and the rules X has
// kept through every release of its own: a discount for posts from outside
// your network, a diversity discount for an author's later posts, and a
// fatigue that fades after "not interested".
//
//   const g = index({ ...(await murmur.snapshot()), follows });   // follows: [[a, t]] account edges
//   const { items, suggestions } = forYou(g, me, { local });
//
// Every item says why it is shown ("Liked by @x"), and every weight is below.

/** Starting weights, from the systems surveyed: to be tuned, not measured optima. */
export const C = {
  windowDays: [7, 14, 30, Infinity], // widen until the pool holds enough
  minPool: 150,
  halfLifeHours: [18, 36, 72], // scores halve this often; longer when the network is quiet
  affinityHalfLifeDays: 30,
  cap: { perAuthor: 20, inNetwork: 400, social: 300, trend: 50, socialSeeds: 60 },
  trust: { steps: 3, restart: 0.5, floor: 0.01, engaged: 0.3 },
  act: { like: 1, repost: 2, quote: 3, reply: 3 },
  w: { affinity: 2.0, engagement: 1.5, trend: 0.5, mutual: 0.5, similar: 1.0 },
  // "Because you liked": what else those who engaged with your recent posts
  // engaged with, each by trust over the root of how much they engage.
  similar: { seedPosts: 30, perAccount: 50, min: 0.15 },
  outOfNetwork: 0.75,
  reply: 0.75,
  seen: 0.3,
  diversity: { decay: 0.5, floor: 0.25 },
  mix: { page: 30, outOfNetworkMax: 0.4, fewFollowsOutOfNetworkMax: 0.6, fewFollows: 10, friendEvery: 5 },
  fatigue: { start: 0.2, step: 0.2, stepDays: 35 },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANK = { like: 1, repost: 2, quote: 3, reply: 3 };
export const keyOf = (post) => `${post.author}/${post.id}`;
const refKey = (to) => `${to.author}/${to.id}`;

/**
 * The records a ranking reads, indexed: `{ posts, likes }` from a snapshot,
 * and `follows`, account → account edges (handles already resolved).
 */
export function index({ posts, likes, follows = [] }) {
  const byKey = new Map();
  const byAuthor = new Map();
  for (const post of posts) {
    byKey.set(keyOf(post), post);
    if (post.repost) continue;
    if (!byAuthor.has(post.author)) byAuthor.set(post.author, []);
    byAuthor.get(post.author).push(post);
  }
  for (const list of byAuthor.values()) list.sort((a, b) => b.at - a.at);

  // Who engaged with each post, each account once at its strongest action,
  // and what each account engaged with. Reposts, replies and quotes are posts
  // that point; a like is its own record.
  const engagers = new Map(); // post key → Map(account → kind)
  const engaged = new Map(); // account → Map(post key → kind)
  const likesOf = new Map(); // account → count of likes, to damp accounts that like everything
  const note = (account, key, kind) => {
    const post = byKey.get(key);
    if (!post || post.repost || account === post.author) return;
    if (!engagers.has(key)) engagers.set(key, new Map());
    const now = engagers.get(key).get(account);
    if (!now || RANK[kind] > RANK[now]) engagers.get(key).set(account, kind);
    if (!engaged.has(account)) engaged.set(account, new Map());
    const was = engaged.get(account).get(key);
    if (!was || RANK[kind] > RANK[was]) engaged.get(account).set(key, kind);
  };
  for (const post of posts) {
    for (const kind of ["reply", "repost", "quote"]) if (post[kind]) note(post.author, refKey(post[kind]), kind);
  }
  for (const { account, author, id } of likes) {
    note(account, `${author}/${id}`, "like");
    likesOf.set(account, (likesOf.get(account) ?? 0) + 1);
  }

  const followsOf = new Map();
  const followers = new Map();
  for (const [a, t] of follows) {
    if (a === t) continue;
    if (!followsOf.has(a)) followsOf.set(a, new Set());
    if (followsOf.get(a).has(t)) continue;
    followsOf.get(a).add(t);
    followers.set(t, (followers.get(t) ?? 0) + 1);
  }
  return { byKey, byAuthor, engagers, engaged, likesOf, followsOf, followers };
}

const following = (g, account) => g.followsOf.get(account) ?? new Set();

/**
 * How much `viewer` trusts each account, in (0, 1]: a few steps of trust out
 * along follows, each account's share split among those it follows, scaled so
 * one of the viewer's own follows is 1. Accounts the viewer engaged with get at
 * least `engaged`; muted accounts and the viewer get none.
 */
export function personalTrust(g, viewer, { muted = new Set() } = {}) {
  const T = C.trust;
  const trust = new Map();
  let mass = new Map([[viewer, 1]]);
  for (let step = 0; step < T.steps; step++) {
    const next = new Map();
    for (const [u, m] of mass) {
      const out = [...following(g, u)].filter((t) => !muted.has(t));
      for (const t of out) next.set(t, (next.get(t) ?? 0) + ((1 - T.restart) * m) / out.length);
    }
    for (const [t, m] of next) trust.set(t, (trust.get(t) ?? 0) + m);
    mass = next;
  }
  const direct = following(g, viewer);
  const unit = (1 - T.restart) / Math.max(1, direct.size);
  for (const [t, v] of trust) trust.set(t, Math.min(1, v / unit));
  for (const f of direct) trust.set(f, 1);
  for (const key of g.engaged.get(viewer)?.keys() ?? []) {
    const author = g.byKey.get(key)?.author;
    if (author) trust.set(author, Math.max(trust.get(author) ?? 0, T.engaged));
  }
  trust.delete(viewer);
  for (const a of muted) trust.delete(a);
  for (const [t, v] of trust) if (v < T.floor) trust.delete(t);
  return trust;
}

/** How close `viewer` is to each author, in [0, 1), from what the viewer liked, reposted, replied to and quoted. */
export function affinities(g, viewer, now) {
  const raw = new Map();
  for (const [key, kind] of g.engaged.get(viewer) ?? []) {
    const post = g.byKey.get(key);
    // A like has no time of its own: the post's stands in for it.
    const ageDays = Math.max(0, (now - post.at) / DAY);
    raw.set(post.author, (raw.get(post.author) ?? 0) + C.act[kind] * 2 ** (-ageDays / C.affinityHalfLifeDays));
  }
  const out = new Map();
  for (const [a, v] of raw) out.set(a, v / (v + 3));
  return out;
}

/**
 * Posts like those `viewer` engaged with lately: for each of the viewer's
 * last few engagements, those who also engaged with it, and what else they
 * engaged with, each such account counting its trust over the root of how
 * much it engages (item-to-item, as Pixie and GraphJet walk it). Untrusted
 * accounts count nothing. Map(key → { score, because: the viewer's post key }).
 */
export function similarTo(g, viewer, trust, { muted = new Set() } = {}) {
  const S = C.similar;
  const mine = g.engaged.get(viewer) ?? new Map();
  const seeds = [...mine.keys()].map((k) => g.byKey.get(k)).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, S.seedPosts);
  const out = new Map();
  for (const seed of seeds) {
    const sk = keyOf(seed);
    for (const [u] of g.engagers.get(sk) ?? []) {
      const t = trust.get(u) ?? 0;
      if (u === viewer || muted.has(u) || t === 0) continue;
      const theirs = g.engaged.get(u);
      const w = t / Math.sqrt(theirs.size);
      let n = 0;
      for (const k of theirs.keys()) {
        if (k === sk || mine.has(k)) continue;
        if (++n > S.perAccount) break;
        const e = out.get(k) ?? { score: 0, because: sk, best: 0 };
        e.score += w;
        if (w > e.best) (e.best = w), (e.because = sk);
        out.set(k, e);
      }
    }
  }
  return out;
}

/** The fatigue multiplier for an author the viewer marked "not interested" at `at`: 0.2, rising 0.2 every 35 days. */
export function fatigue(at, now) {
  if (at === undefined) return 1;
  const F = C.fatigue;
  return Math.min(1, F.start + F.step * Math.floor(Math.max(0, now - at) / (F.stepDays * DAY)));
}

/**
 * The viewer's For you page: `{ items, suggestions }`. Each item is
 * `{ post, key, score, inNetwork, seen, why, parts }`, `why` the reason it is
 * shown (`{ type: "liked" | "reposted" | "replied" | "quoted", actors }`,
 * `{ type: "network", n }`, `{ type: "trend" }`, `{ type: "similar", because: post ref }`
 * or `{ type: "popular" }`), or
 * null for a post by someone the viewer follows.
 *
 * `local` is the viewer's own feedback, kept on the device:
 * `{ seen: Set<key>, hidden: Set<key>, muted: Set<account>, notInterested: Map<account, time> }`.
 * Without a viewer, or one who follows nobody, the page is what is popular,
 * every engager counted once.
 */
export function forYou(g, viewer, { local = {}, now = Date.now(), page = C.mix.page } = {}) {
  const seen = local.seen ?? new Set();
  const hidden = local.hidden ?? new Set();
  const muted = local.muted ?? new Set();
  const notInterested = local.notInterested ?? new Map();
  const direct = viewer ? following(g, viewer) : new Set();
  const cold = direct.size === 0;
  const trust = viewer && !cold ? personalTrust(g, viewer, { muted }) : new Map();
  const affinity = viewer ? affinities(g, viewer, now) : new Map();
  // Without trust, every engager counts once: "popular", gameable, and labeled so.
  const trustOf = (u) => (cold ? 1 : trust.get(u) ?? 0);
  const halfLife = halfLifeFor(g, direct, now, cold);
  const similar = viewer && !cold ? similarTo(g, viewer, trust, { muted }) : new Map();

  // ---- candidates
  const cands = new Map(); // key → { post, sources }
  const add = (post, source) => {
    const key = keyOf(post);
    if (!cands.has(key)) cands.set(key, { post, key, sources: new Set() });
    cands.get(key).sources.add(source);
  };
  const seeds = [...trust].sort((a, b) => b[1] - a[1]).slice(0, C.cap.socialSeeds).map(([u]) => u);
  for (const days of C.windowDays) {
    const since = now - days * DAY;
    for (const f of direct) for (const p of (g.byAuthor.get(f) ?? []).filter((p) => p.at >= since).slice(0, C.cap.perAuthor)) add(p, "in");
    for (const u of seeds) {
      for (const key of g.engaged.get(u)?.keys() ?? []) {
        const p = g.byKey.get(key);
        if (p.at >= since) add(p, "social");
      }
    }
    for (const [key, e] of similar) {
      const p = g.byKey.get(key);
      if (e.score >= C.similar.min && p.at >= since) add(p, "similar");
    }
    if (cold) for (const list of g.byAuthor.values()) for (const p of list.filter((p) => p.at >= since).slice(0, C.cap.perAuthor)) add(p, "popular");
    if (cands.size >= C.minPool) break;
  }

  // ---- features, eligibility, score
  const scored = [];
  for (const c of cands.values()) {
    const { post, key } = c;
    if (post.author === viewer || hidden.has(key) || muted.has(post.author)) continue;
    if (post.reply && muted.has(post.reply.author)) continue;
    let E = 0;
    let proof = 0;
    let n = 0;
    const directs = { reply: [], quote: [], repost: [], like: [] };
    for (const [u, kind] of g.engagers.get(key) ?? []) {
      if (u === viewer || muted.has(u)) continue;
      const t = trustOf(u);
      if (t === 0) continue;
      E += (t * C.act[kind]) / Math.sqrt(Math.max(1, (g.likesOf.get(u) ?? 0) / 20));
      proof += t;
      n++;
      if (direct.has(u)) directs[kind].push(u);
    }
    const inNetwork = direct.has(post.author);
    const anyDirect = Object.values(directs).some((l) => l.length);
    const trend = Math.min(1, Math.max(0, n - 1) ** 2 / 25);
    // Outside the network, a post needs social proof from people the viewer trusts.
    const like = similar.get(key);
    const sim = like && like.score >= C.similar.min ? Math.min(1, like.score) : 0;
    const eligible = cold || inNetwork || anyDirect || sim > 0 || (n >= 2 && proof >= 0.5) || (n >= 3 && now - post.at < DAY);
    if (!eligible) continue;
    // A reply is half a conversation: it shows when you follow both sides (or
    // it answers you), or when someone you follow engaged with it; never cold.
    if (post.reply && !anyDirect && (cold || !inNetwork || !(direct.has(post.reply.author) || post.reply.author === viewer))) continue;
    const mutual = viewer && following(g, post.author).has(viewer) ? 1 : 0;
    const aff = affinity.get(post.author) ?? 0;
    const value = 1 + C.w.affinity * aff + C.w.engagement * Math.log2(1 + E) + C.w.trend * trend + C.w.mutual * mutual + C.w.similar * sim;
    const decay = 2 ** (-Math.max(0, now - post.at) / HOUR / halfLife);
    let m = decay;
    if (!inNetwork && !cold) m *= C.outOfNetwork;
    if (post.reply) m *= C.reply;
    m *= fatigue(notInterested.get(post.author), now);
    const wasSeen = seen.has(key);
    if (wasSeen) m *= C.seen;
    scored.push({
      post,
      key,
      score: value * m,
      inNetwork,
      seen: wasSeen,
      why: reason({ inNetwork, cold, directs, n, trend, sim, because: like?.because && g.byKey.get(like.because) }),
      parts: { value, decay, affinity: aff, engagement: E, engagers: n, trend, mutual, similar: sim, halfLife },
    });
  }

  const outOfNetworkMax = direct.size < C.mix.fewFollows ? C.mix.fewFollowsOutOfNetworkMax : C.mix.outOfNetworkMax;
  const items = mix(scored, { page, outOfNetworkMax: cold ? 1 : outOfNetworkMax });
  return { items, suggestions: suggest(g, viewer, { direct, trust, muted, cold }) };
}

/** Scores halve every 18 h, or every 36 or 72 h when the posts from whom you follow are few. */
function halfLifeFor(g, direct, now, cold) {
  const since = now - 2 * DAY;
  let recent = 0;
  for (const a of cold ? g.byAuthor.keys() : direct) for (const p of g.byAuthor.get(a) ?? []) if (p.at >= since) recent++;
  const [fast, slow, slowest] = C.halfLifeHours;
  return recent >= 100 ? fast : recent >= 30 ? slow : slowest;
}

function reason({ inNetwork, cold, directs, n, trend, sim, because }) {
  for (const kind of ["reply", "quote", "repost", "like"]) {
    if (directs[kind].length) return { type: { reply: "replied", quote: "quoted", repost: "reposted", like: "liked" }[kind], actors: directs[kind] };
  }
  if (inNetwork) return null;
  if (cold) return n ? { type: "popular" } : { type: "new" };
  if (sim > 0 && because) return { type: "similar", because: { author: because.author, id: because.id } };
  if (trend > 0 && n >= 3) return { type: "trend" };
  return { type: "network", n };
}

/**
 * X's mixer, simplified: fill the page by score, discounting each author's
 * later posts ((1 − 0.25)·0.5ⁿ + 0.25), one post per conversation, posts from
 * outside the network at most `outOfNetworkMax` of the page (more only when
 * nothing in-network is left), and a post from whom you follow at least every
 * fifth slot. Posts seen before go after the rest.
 */
export function mix(scored, { page = C.mix.page, outOfNetworkMax = C.mix.outOfNetworkMax } = {}) {
  const out = [];
  const byAuthor = new Map();
  const conversations = new Set();
  const conversation = (c) => (c.post.reply ? refKey(c.post.reply) : c.key);
  let pool = [...scored];
  const D = C.diversity;
  const adjusted = (c) => c.score * ((1 - D.floor) * D.decay ** (byAuthor.get(c.post.author) ?? 0) + D.floor);
  const best = (list) => list.reduce((a, b) => (a === null || adjusted(b) > adjusted(a) ? b : a), null);
  while (out.length < page && pool.length) {
    pool = pool.filter((c) => !conversations.has(conversation(c)));
    if (!pool.length) break;
    const slot = out.length + 1;
    const outside = out.filter((c) => !c.inNetwork).length;
    const anyInside = pool.some((c) => c.inNetwork);
    const fits = (c) => c.inNetwork || (outside + 1) / slot <= outOfNetworkMax || !anyInside;
    let pick = null;
    if (slot % C.mix.friendEvery === 0 && !out.slice(-4).some((c) => c.inNetwork)) pick = best(pool.filter((c) => c.inNetwork));
    pick ??= best(pool.filter(fits)) ?? best(pool);
    out.push(pick);
    byAuthor.set(pick.post.author, (byAuthor.get(pick.post.author) ?? 0) + 1);
    conversations.add(conversation(pick));
    if (pick.post.reply) conversations.add(pick.key);
    pool = pool.filter((c) => c !== pick);
  }
  // Seen posts last, so a visit starts with what's new.
  return [...out.filter((c) => !c.seen), ...out.filter((c) => c.seen)];
}

/**
 * Whom to follow: accounts followed by those you follow, most such first,
 * with who of yours follows them; or, before you follow anyone, the most
 * followed accounts. Only accounts that have posted.
 */
export function suggest(g, viewer, { direct = new Set(), trust = new Map(), muted = new Set(), cold = false, limit = 3 } = {}) {
  const via = new Map();
  if (!cold) {
    for (const f of direct) {
      for (const t of following(g, f)) {
        if (t === viewer || direct.has(t) || muted.has(t)) continue;
        if (!via.has(t)) via.set(t, []);
        via.get(t).push(f);
      }
    }
  }
  const posted = (a) => (g.byAuthor.get(a)?.length ?? 0) > 0;
  const list = cold
    ? [...g.followers].filter(([a]) => a !== viewer && !muted.has(a) && posted(a)).sort((a, b) => b[1] - a[1]).map(([account, n]) => ({ account, via: [], followers: n }))
    : [...via].filter(([a]) => posted(a)).sort((a, b) => b[1].length - a[1].length || (trust.get(b[0]) ?? 0) - (trust.get(a[0]) ?? 0)).map(([account, by]) => ({ account, via: by, followers: g.followers.get(account) ?? 0 }));
  return list.slice(0, limit);
}
