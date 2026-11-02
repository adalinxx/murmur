// Murmur's records: short posts, replies, reposts, quotes, likes and cards,
// each key belonging to the account named in it (the chain's policy).
//
//   post/<a>/<id>                       a post: JSON { text, media?, reply?, repost?, quote? }
//   reply|repost|quote/<p>/<pid>/<a>/<id>  "1": post <id> points at post <pid> by <p>
//   like/<a>/<p>/<pid>, liked/<p>/<pid>/<a>  "1": <a> likes the post, both ends
//   profile/<a>                         a card: JSON { name?, bio? }
//
// A post is created once and deleted, never edited. Its id is its time in
// base 36 and a few random characters, so a prefix read of one author's posts
// is in time order. A pointer (`reply`, `repost`, `quote`) is a claim made by
// its post's author: a reader keeps one only while that post exists and
// points where the key says.
//
// A post's media are pictures named by CID, `{ cid, type, alt? }`, at most
// four: each one Volume of one block, DAG-CBOR `{ type, bytes }`, kept off
// the chain by whoever pins it (see ../media.mjs).
//
// Every read takes a state view `{ get(key), list(prefix) }`; every write
// returns `{ actions }` for the person's wallet to sign.

export const MAX_TEXT = 280;
export const MAX_NAME = 50;
export const MAX_BIO = 300;
/** The most bytes the policy takes in one post or card. */
export const MAX_VALUE = 4096;
export const MAX_MEDIA = 4;
export const MAX_ALT = 420;
/** Raster images only: an SVG is a document that can run script. */
export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
export const POINTERS = ["reply", "repost", "quote"];

/** Whether `text` is an account address in its one canonical spelling, as the policy checks it. */
export function isAddress(text) {
  const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
  return (
    typeof text === "string" &&
    text.length === 59 &&
    text.startsWith("bafyrei") &&
    [...text.slice(7)].every((c) => BASE32.includes(c)) &&
    BASE32.indexOf(text[7]) < 8 &&
    BASE32.indexOf(text[58]) % 4 === 0
  );
}

/** Whether `text` is a CID as a media Volume's root has it: a dag-cbor sha2-256 CIDv1, spelled as an address is. */
export const isMediaCID = isAddress;

/** A media entry as kept: `{ cid, type, alt? }`, or undefined if it isn't one. */
function parseMedia(entry) {
  if (typeof entry !== "object" || entry === null || !isMediaCID(entry.cid) || !MEDIA_TYPES.includes(entry.type)) return undefined;
  if (entry.alt !== undefined && (typeof entry.alt !== "string" || length(entry.alt) > MAX_ALT)) return undefined;
  return { cid: entry.cid, type: entry.type, ...(entry.alt?.trim() && { alt: entry.alt.trim() }) };
}

/** Whether `text` is a post id: 1 to 16 lowercase letters and digits. */
export const isId = (text) => typeof text === "string" && /^[a-z0-9]{1,16}$/.test(text);

const TIME_DIGITS = 9; // base 36: milliseconds until the year 5188
/** A new post id: the time, then four random characters, so ids sort by time. */
export function newId(now = Date.now(), random = Math.random) {
  const time = Math.floor(now).toString(36).padStart(TIME_DIGITS, "0");
  let tail = "";
  for (let i = 0; i < 4; i++) tail += Math.floor(random() * 36).toString(36);
  return time + tail;
}
/** When a post with `id` was made, in milliseconds, or undefined for an id no client made. */
export function timeOf(id) {
  if (!isId(id) || id.length < TIME_DIGITS) return undefined;
  const time = parseInt(id.slice(0, TIME_DIGITS), 36);
  return Number.isSafeInteger(time) ? time : undefined;
}

function need(test, what, value) {
  if (!test(value)) throw new Error(`not ${what}: ${value}`);
}
const ref = ({ author, id }) => (need(isAddress, "an account", author), need(isId, "a post id", id), { author, id });

export const postKey = (author, id) => (need(isAddress, "an account", author), need(isId, "a post id", id), `post/${author}/${id}`);
export const pointerKey = (kind, to, author, id) => {
  if (!POINTERS.includes(kind)) throw new Error(`not a pointer: ${kind}`);
  const { author: p, id: pid } = ref(to);
  return `${kind}/${p}/${pid}/${postKey(author, id).slice("post/".length)}`;
};
export const likeKey = (account, to) => (need(isAddress, "an account", account), `like/${account}/${ref(to).author}/${to.id}`);
export const likedKey = (account, to) => (need(isAddress, "an account", account), `liked/${ref(to).author}/${to.id}/${account}`);
export const profileKey = (account) => (need(isAddress, "an account", account), `profile/${account}`);

/** The number of characters a person sees in `text`, counted as code points. */
export const length = (text) => [...text].length;

/**
 * A post's value as a post: `{ text, media?, reply?, repost?, quote? }`, or
 * undefined for anything else. A post points at most one way.
 */
export function parsePost(value) {
  let json;
  try {
    json = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  if (typeof json.text !== "string" || length(json.text) > MAX_TEXT) return undefined;
  const post = { text: json.text };
  if (json.media !== undefined) {
    if (!Array.isArray(json.media) || json.media.length === 0 || json.media.length > MAX_MEDIA) return undefined;
    const media = json.media.map(parseMedia);
    if (media.includes(undefined)) return undefined;
    post.media = media;
  }
  const kinds = POINTERS.filter((kind) => json[kind] !== undefined);
  if (kinds.length > 1) return undefined;
  for (const kind of kinds) {
    const to = json[kind];
    if (typeof to !== "object" || to === null || !isAddress(to.author) || !isId(to.id)) return undefined;
    post[kind] = { author: to.author, id: to.id };
  }
  // A repost says and shows nothing of its own; any other post says or shows something.
  if (post.repost ? post.text !== "" || post.media : post.text.trim() === "" && !post.media) return undefined;
  return post;
}

/** A card's value as a card: `{ name?, bio? }`, cut to size; anything else is an empty card. */
export function parseCard(value) {
  try {
    const json = JSON.parse(value);
    const card = {};
    if (typeof json?.name === "string" && json.name.trim()) card.name = [...json.name.trim()].slice(0, MAX_NAME).join("");
    if (typeof json?.bio === "string" && json.bio.trim()) card.bio = [...json.bio.trim()].slice(0, MAX_BIO).join("");
    return card;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- reads

/** The post `author` made as `id`: `{ author, id, at, text, reply?, repost?, quote? }`, or undefined. */
export async function getPost(state, author, id) {
  const value = await state.get(postKey(author, id));
  const post = value === undefined ? undefined : parsePost(value);
  return post && { author, id, at: timeOf(id), ...post };
}

/** The keys under `prefix` with exactly `segments` more segments, split. */
async function entries(state, prefix, segments) {
  const found = [];
  for await (const [key, value] of state.list(prefix)) {
    const parts = key.slice(prefix.length).split("/");
    if (parts.length === segments) found.push({ parts, value });
  }
  return found;
}

const newestFirst = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : a.author < b.author ? 1 : -1);

/** `author`'s posts, newest first; at most `limit`. */
export async function postsBy(state, author, { limit = Infinity } = {}) {
  need(isAddress, "an account", author);
  const posts = [];
  for (const { parts: [id], value } of await entries(state, `post/${author}/`, 1)) {
    const post = isId(id) && parsePost(value);
    if (post) posts.push({ author, id, at: timeOf(id), ...post });
  }
  return posts.sort(newestFirst).slice(0, limit);
}

/** The posts of all of `authors`, newest first: a timeline. At most `limit`. */
export async function feed(state, authors, { limit = 100 } = {}) {
  const each = await Promise.all([...new Set(authors)].map((a) => postsBy(state, a, { limit })));
  return each.flat().sort(newestFirst).slice(0, limit);
}

/** Every post on the chain, newest first: the whole chain, so for a small one. At most `limit`. */
export async function everyone(state, { limit = 100 } = {}) {
  const posts = [];
  for (const { parts: [author, id], value } of await entries(state, "post/", 2)) {
    const post = isAddress(author) && isId(id) && parsePost(value);
    if (post) posts.push({ author, id, at: timeOf(id), ...post });
  }
  return posts.sort(newestFirst).slice(0, limit);
}

/**
 * The posts that reply to, repost or quote (`kind`) the post `to`, oldest
 * first, each checked: it exists and points at `to` that way.
 */
export async function pointing(state, kind, to) {
  const { author, id } = ref(to);
  if (!POINTERS.includes(kind)) throw new Error(`not a pointer: ${kind}`);
  const listed = await entries(state, `${kind}/${author}/${id}/`, 2);
  const posts = await Promise.all(
    listed.map(async ({ parts: [a, rid] }) => {
      if (!isAddress(a) || !isId(rid)) return undefined;
      const post = await getPost(state, a, rid);
      return post?.[kind]?.author === author && post[kind].id === id ? post : undefined;
    }),
  );
  return posts.filter(Boolean).sort(newestFirst).reverse();
}

/** The accounts that like the post `to`. */
export async function likers(state, to) {
  const { author, id } = ref(to);
  return (await entries(state, `liked/${author}/${id}/`, 1)).map(({ parts: [a] }) => a).filter(isAddress);
}

/** Whether `account` likes the post `to`. */
export const likes = async (state, account, to) => (await state.get(likeKey(account, to))) !== undefined;

/** `account`'s reposts of `to`, as posts: none, or one (two if sent twice at once). */
export async function repostsOf(state, account, to) {
  return (await pointing(state, "repost", to)).filter((post) => post.author === account);
}

/** How many reply to, repost, quote and like the post `to`, and what `reader` did: `{ replies, reposts, quotes, likes, liked, reposted }`. */
export async function stats(state, to, reader) {
  const [replies, reposts, quotes, likedBy] = await Promise.all([
    pointing(state, "reply", to),
    pointing(state, "repost", to),
    pointing(state, "quote", to),
    likers(state, to),
  ]);
  return {
    replies: replies.length,
    reposts: new Set(reposts.map((p) => p.author)).size,
    quotes: quotes.length,
    likes: likedBy.length,
    liked: reader !== undefined && likedBy.includes(reader),
    reposted: reader !== undefined && reposts.some((p) => p.author === reader),
  };
}

/** The thread around the post `to`: the posts it replies to, oldest first, then it, then its replies. */
export async function thread(state, to, { depth = 20 } = {}) {
  const post = await getPost(state, to.author, to.id);
  if (!post) return undefined;
  const above = [];
  for (let at = post; at.reply && above.length < depth; ) {
    const parent = await getPost(state, at.reply.author, at.reply.id);
    if (!parent) {
      above.unshift({ ...at.reply, missing: true });
      break;
    }
    above.unshift(parent);
    at = parent;
  }
  return { above, post, replies: await pointing(state, "reply", to) };
}

/** `account`'s card: `{ name?, bio? }`. */
export async function card(state, account) {
  const value = await state.get(profileKey(account));
  return value === undefined ? {} : parseCard(value);
}

// ---------------------------------------------------------------- writes

/**
 * A new post by `author`: `{ text, media?, reply?, quote? }`, `media` the
 * kept pictures as `{ cid, type, alt? }`. Returns `{ id, actions }`: the post,
 * and its entry under the post it replies to or quotes.
 */
export function compose(author, { text = "", media = [], reply, quote }, { id = newId() } = {}) {
  if (typeof text !== "string") throw new Error("Write something first.");
  if (text.trim() === "" && media.length === 0) throw new Error("Write something or add a picture first.");
  if (length(text) > MAX_TEXT) throw new Error(`A post is at most ${MAX_TEXT} characters.`);
  if (media.length > MAX_MEDIA) throw new Error(`A post shows at most ${MAX_MEDIA} pictures.`);
  const kept = media.map((entry) => {
    const parsed = parseMedia(entry);
    if (!parsed) throw new Error(entry?.alt && length(entry.alt) > MAX_ALT ? `A description is at most ${MAX_ALT} characters.` : "That picture can't be posted.");
    return parsed;
  });
  if (reply && quote) throw new Error("A post replies or quotes, not both.");
  const body = { text, ...(kept.length && { media: kept }), ...(reply && { reply: ref(reply) }), ...(quote && { quote: ref(quote) }) };
  return written(author, id, body);
}

function written(author, id, body) {
  const value = JSON.stringify(body);
  if (new TextEncoder().encode(value).length > MAX_VALUE) throw new Error("That post is too long to keep.");
  const actions = [{ key: postKey(author, id), newValue: value }];
  for (const kind of POINTERS) if (body[kind]) actions.push({ key: pointerKey(kind, body[kind], author, id), newValue: "1" });
  return { id, actions };
}

/** `author` deletes their post `id`, and its entry under the post it points at. Nothing if it is gone. */
export async function remove(state, author, id) {
  const oldValue = await state.get(postKey(author, id));
  if (oldValue === undefined) return { actions: [] };
  const actions = [{ key: postKey(author, id), oldValue }];
  const post = parsePost(oldValue);
  for (const kind of POINTERS) {
    if (!post?.[kind]) continue;
    const key = pointerKey(kind, post[kind], author, id);
    const was = await state.get(key);
    if (was !== undefined) actions.push({ key, oldValue: was });
  }
  return { actions };
}

/** `account` reposts `to`, unless it does already. */
export async function repost(state, account, to, { id = newId() } = {}) {
  if (!(await getPost(state, to.author, to.id))) throw new Error("That post is gone.");
  if ((await repostsOf(state, account, to)).length > 0) return { actions: [] };
  return written(account, id, { text: "", repost: ref(to) });
}

/** `account` takes back every repost of `to`. */
export async function unrepost(state, account, to) {
  const removals = await Promise.all((await repostsOf(state, account, to)).map((post) => remove(state, account, post.id)));
  return { actions: removals.flatMap((r) => r.actions) };
}

/** `account` likes `to`, unless it does already. */
export async function like(state, account, to) {
  if (await likes(state, account, to)) return { actions: [] };
  return {
    actions: [
      { key: likeKey(account, to), newValue: "1" },
      { key: likedKey(account, to), newValue: "1" },
    ],
  };
}

/** `account` stops liking `to`. */
export async function unlike(state, account, to) {
  const [mine, twin] = await Promise.all([state.get(likeKey(account, to)), state.get(likedKey(account, to))]);
  if (mine === undefined) return { actions: [] };
  return {
    actions: [
      { key: likeKey(account, to), oldValue: mine },
      { key: likedKey(account, to), ...(twin !== undefined && { oldValue: twin }) },
    ],
  };
}

/** `account` sets its card to `{ name?, bio? }`; an empty card deletes it. */
export async function setCard(state, account, { name, bio } = {}) {
  const next = {};
  if (name?.trim()) next.name = name.trim();
  if (bio?.trim()) next.bio = bio.trim();
  if (next.name && length(next.name) > MAX_NAME) throw new Error(`A name is at most ${MAX_NAME} characters.`);
  if (next.bio && length(next.bio) > MAX_BIO) throw new Error(`A bio is at most ${MAX_BIO} characters.`);
  const oldValue = await state.get(profileKey(account));
  const newValue = Object.keys(next).length ? JSON.stringify(next) : undefined;
  if (oldValue === newValue) return { actions: [] };
  return { actions: [{ key: profileKey(account), ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) }] };
}
