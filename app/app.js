// Murmur: short posts, with replies, reposts, quotes and likes, on a Lattice
// chain. The page has no server: it reads every record by CID from public
// nodes and asks Selfhold to sign each write. Nobody needs coins: Selfhold's
// window pays each fee with a moment of this device's work, through a fee
// sponsor. Whom you follow is Follows, the graph every Lattice app shares;
// your @handle is Moniker's, the names every app shows.
//
// Routes: #/                     For you: ranked here, from whom you follow and what they like
//         #/following            whom you follow, newest first
//         #/everyone             every post, newest first
//         #/search?q=<words>     posts holding every word
//         #/notifications        replies, quotes, mentions, reposts, likes and follows of yours
//         #/@<h> or #/<account>  a person: their card, counts and posts
//         #/<account>/<id>       a post, with the thread around it
//
// Pictures are kept off the chain for good by a storage sponsor, paid for
// with this device's work too, and read back from any node by CID.
//
// A link may carry `?node=` (comma-separated), `?chain=`, `?follows=`,
// `?moniker=`, `?sponsor=` and `?wallet=` to use other nodes, chains,
// sponsor or Selfhold.
import * as sdk from "../vendor/lattice-sdk.js";
import { createMurmur, MAX_MEDIA_BYTES, notifications, rank, searchPosts, records as m, StorageRefused, StorageStopped } from "../src/index.mjs";
import { createFollows } from "../vendor/follows/src/index.mjs";
import * as followRecords from "../vendor/follows/src/records/follows.mjs";
import { createMoniker } from "./vendor/moniker-sdk/src/index.mjs";
import { defineHandlePicker } from "./vendor/moniker-sdk/src/picker.mjs";
import { accountIcon, shortAccount } from "./vendor/moniker-sdk/src/records/account.mjs";
import { selfhold } from "./vendor/selfhold.mjs";
import { hasher, workDevice } from "./vendor/work/hash.mjs";
import { ago, count, esc, left, parseRoute, PROFILE_TABS, searchPath, parseWho, personPath, postPath, renderText, when } from "./lib.mjs";

const params = new URLSearchParams(location.search);
const list = (name) => params.get(name)?.split(",").filter(Boolean);
const path = (name) => params.get(name)?.split("/").filter(Boolean);
const NODES = list("node") ?? ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"];
// The sponsor that takes this device's work for fees and for keeping pictures, as Stoa uses it.
const SPONSOR = params.get("sponsor") ?? "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor";
const WALLET_PAGE = params.get("wallet") ?? "https://wallet.selfhold.app/";
const MONIKER_APP = "https://app.moniker.bio/";

const murmur = createMurmur({ sdk, nodes: NODES, storage: SPONSOR, ...(path("chain") && { chain: path("chain") }) });
const moniker = createMoniker({ sdk, app: MONIKER_APP, ...(path("moniker") && { chain: path("moniker") }), ...(list("node") && { nodes: NODES }) });
// Moniker as Follows reads it, where a Moniker that can't be read means nobody shows a
// handle just now: people show by account, and Murmur still works.
// Nor one that is slow to answer: past 8 s, nobody shows a handle, and for
// a minute after, Moniker isn't waited for at all.
let monikerRestsUntil = 0;
const late = (read, fallback) => {
  if (Date.now() < monikerRestsUntil) return Promise.resolve(fallback);
  return Promise.race([
    read().catch(() => fallback),
    new Promise((resolve) => setTimeout(() => ((monikerRestsUntil = Date.now() + 60_000), resolve(fallback)), 8_000)),
  ]);
};
const names = {
  state: (options) => late(() => moniker.state(options), null),
  pointer: (h) => late(() => moniker.pointer(h), undefined),
  pointers: (hs) => Promise.all(hs.map((h) => late(() => moniker.pointer(h), undefined))),
  handlesOf: (as) => late(() => moniker.handlesOf(as), as.map(() => undefined)),
};
const graph = createFollows({ sdk, moniker: names, nodes: NODES, ...(path("follows") && { chain: path("follows") }) });
// Follows' reads that take and give accounts only: no handle is looked up
// on Moniker, so a slow Moniker never makes whom you follow look empty.
const noNames = { pointers: async (hs) => hs.map(() => undefined), handlesOf: async (as) => as.map(() => undefined) };
const followGraph = {
  /** The accounts `account` follows. */
  following: async (account) => (await followRecords.following(await graph.state(), noNames, account)).map((p) => p.account),
  /** How many follow `account`, and how many it follows. */
  counts: async (account) => {
    const state = await graph.state();
    const [followers, following] = await Promise.all([followRecords.followers(state, noNames, account), followRecords.following(state, noNames, account)]);
    return { followers: followers.length, following: following.length };
  },
  /** Whether `account` follows `who`, both accounts. */
  follows: async (account, who) => followRecords.follows(await graph.state(), noNames, account, who),
};

// Selfhold's window, for Murmur's and Follows' chains (on the same hosts) and
// for Moniker's. It holds the key, shows each write, and has its fee paid in work.
const wallet = selfhold({ use: "window", wallet: WALLET_PAGE, hosts: () => NODES, sponsor: () => SPONSOR || undefined });
const monikerWallet = selfhold({ use: "window", wallet: WALLET_PAGE, hosts: () => moniker.hosts(), sponsor: () => SPONSOR || undefined });
defineHandlePicker(moniker, { app: MONIKER_APP, wallet: () => monikerWallet });

const main = document.querySelector("main");
const you = document.querySelector("#you");
const toast = document.querySelector("#toast");
let me = null; // the connected account

// ---------------------------------------------------------------- people

const handles = new Map(); // account → Promise<handle | undefined>
const cards = new Map(); // account → Promise<{ name?, bio? }>
/** Reads the handles and cards of `accounts` not read yet, all at once. */
async function know(accounts) {
  const fresh = [...new Set(accounts)].filter((a) => !handles.has(a));
  if (fresh.length) {
    const all = names.handlesOf(fresh);
    fresh.forEach((a, i) => handles.set(a, all.then((h) => h[i])));
  }
  for (const a of accounts) if (!cards.has(a)) cards.set(a, murmur.card(a).catch(() => ({})));
  await Promise.all(accounts.flatMap((a) => [handles.get(a), cards.get(a)]));
}
const handleOf = (a) => handles.get(a);
const cardOf = (a) => cards.get(a);
function forget(account) {
  handles.delete(account);
  cards.delete(account);
}

/** An account's picture: the pattern drawn from its ID, the same in every Lattice app. */
const avatar = (account, size = 40) => `<span class="avatar" style="--size:${size}px" aria-hidden="true">${accountIcon(account, size)}</span>`;

/** A name line: the card's name (no @ of its own), the verified @handle, else the account's short form. */
async function byline(account) {
  const [handle, card] = await Promise.all([handleOf(account), cardOf(account)]);
  const name = card?.name?.replace(/[@＠﹫]/g, "");
  const href = personPath(account, handle);
  const primary = name ?? (handle ? `@${handle}` : shortAccount(account));
  const secondary = name && handle ? `@${handle}` : name ? shortAccount(account) : "";
  return `<a class="name" href="${href}"><strong>${esc(primary)}</strong>${secondary ? ` <span class="muted">${esc(secondary)}</span>` : ""}</a>`;
}

// ---------------------------------------------------------------- posts

/** The posts each of `posts` shows inside it, read once: reposted and quoted posts, by `author/id`. */
async function inner(posts) {
  const wanted = posts.flatMap((p) => [p.repost, p.quote].filter(Boolean));
  const found = new Map();
  await Promise.all(wanted.map(async (to) => found.set(`${to.author}/${to.id}`, await murmur.post(to).catch(() => undefined))));
  return found;
}

async function renderPosts(posts, { focus, headers } = {}) {
  if (posts.length === 0) return "";
  const nested = await inner(posts);
  await know([...posts.map((p) => p.author), ...[...nested.values()].filter(Boolean).map((p) => p.author), ...posts.flatMap((p) => (p.reply ? [p.reply.author] : []))]);
  const items = await Promise.all(
    posts.map(async (post) => {
      if (post.repost) {
        const original = nested.get(`${post.repost.author}/${post.repost.id}`);
        const header = `<p class="reposted muted small">${icon("repost")} ${await byline(post.author)} reposted</p>`;
        if (!original) return `<li class="post gone">${header}<p class="muted">This post was deleted.</p></li>`;
        return postItem(original, { header, nested });
      }
      return postItem(post, { nested, header: headers?.get(`${post.author}/${post.id}`) ?? "", focus: focus && post.author === focus.author && post.id === focus.id });
    }),
  );
  return items.join("");
}

async function postItem(post, { header = "", nested, focus = false }) {
  const quoted = post.quote && nested?.get(`${post.quote.author}/${post.quote.id}`);
  const replyTo = post.reply ? `<p class="muted small replying">Replying to <a href="${postPath(post.reply)}">${esc((await handleOf(post.reply.author)) ? `@${await handleOf(post.reply.author)}` : shortAccount(post.reply.author))}</a></p>` : "";
  const quote = !post.quote
    ? ""
    : quoted
      ? `<a class="quote" href="${postPath(quoted)}">${avatar(quoted.author, 20)} ${(await byline(quoted.author)).replace(/<a [^>]*>|<\/a>/g, "")} <span class="muted small">· ${esc(ago(quoted.at))}</span>${quoted.text ? `<span class="text">${renderText(quoted.text)}</span>` : ""}${mediaHTML(quoted.media, { still: true })}</a>`
      : `<p class="quote muted">This post was deleted.</p>`;
  const mine = post.author === me;
  return `<li class="post${focus ? " focus" : ""}" data-author="${post.author}" data-id="${post.id}">
    ${header}
    <div class="row">
      <a href="${personPath(post.author, await handleOf(post.author))}" tabindex="-1">${avatar(post.author)}</a>
      <div class="body">
        <p class="meta">${await byline(post.author)} <a class="time muted" href="${postPath(post)}" title="${esc(when(post.at))}">${esc(focus ? when(post.at) : ago(post.at))}</a></p>
        ${replyTo}
        ${post.text ? `<p class="text">${renderText(post.text)}</p>` : ""}
        ${mediaHTML(post.media)}
        ${quote}
        <div class="actions" role="group" aria-label="Post actions">
          <button class="act" data-act="reply" aria-label="Reply">${icon("reply")}<span data-n="replies"></span></button>
          <button class="act" data-act="repost" aria-label="Repost" aria-pressed="false">${icon("repost")}<span data-n="reposts"></span></button>
          <button class="act" data-act="quote" aria-label="Quote">${icon("quote")}<span data-n="quotes"></span></button>
          <button class="act" data-act="like" aria-label="Like" aria-pressed="false">${icon("like")}<span data-n="likes"></span></button>
          ${mine ? `<button class="act" data-act="delete" aria-label="Delete">${icon("delete")}</button>` : `<button class="act" data-act="more" aria-label="More: not interested, mute">${icon("more")}</button>`}
        </div>
      </div>
    </div>
  </li>`;
}

/** Fills each shown post's counts, and whether you liked or reposted it, as they arrive. */
function fillStats(root) {
  for (const li of root.querySelectorAll("li.post[data-id]")) {
    const to = { author: li.dataset.author, id: li.dataset.id };
    murmur.stats(to, me ?? undefined).then((s) => {
      for (const [n, value] of Object.entries(s)) {
        const span = li.querySelector(`[data-n="${n}"]`);
        if (span) span.textContent = count(value);
      }
      li.querySelector('[data-act="like"]').setAttribute("aria-pressed", String(s.liked));
      li.querySelector('[data-act="repost"]').setAttribute("aria-pressed", String(s.reposted));
    }, () => {});
  }
}

// ---------------------------------------------------------------- pictures

// Each picture read once a visit: it is content-addressed, so it never changes.
const pictures = new Map(); // cid → Promise<blob URL | null (not served or not a picture)>
function pictureURL(cid) {
  if (!pictures.has(cid)) {
    pictures.set(cid, murmur.media(cid).then(
      (file) => (file ? URL.createObjectURL(new Blob([file.bytes], { type: file.type })) : null),
      () => {
        // Not served just now: asked again after a while, not on every redraw.
        setTimeout(() => pictures.delete(cid), 60_000);
        return null;
      },
    ));
  }
  return pictures.get(cid);
}

/** A post's pictures, filled in by `fillMedia` once read. `still`: inside a link, so not buttons. */
function mediaHTML(media, { still = false } = {}) {
  if (!media?.length) return "";
  const one = ({ cid, alt }) => {
    const img = `<img data-cid="${cid}" alt="${esc(alt ?? "")}">`;
    return still ? `<span class="pic">${img}</span>` : `<button type="button" class="pic" data-act="view" data-cid="${cid}" aria-label="${esc(alt ? `Picture: ${alt}` : "Picture")}, open it">${img}</button>`;
  };
  return `<div class="media n${media.length}">${media.map(one).join("")}</div>`;
}

function fillMedia(root) {
  for (const img of root.querySelectorAll("img[data-cid]:not([src])")) {
    pictureURL(img.dataset.cid).then((url) => {
      if (url) img.src = url;
      else img.closest(".pic")?.classList.add("missing");
    });
  }
}

const ICONS = {
  picture: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4 18l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  reply: '<path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  repost: '<path d="M7 7h11l-3-3M17 17H6l3 3M18 7v5M6 17v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  quote: '<path d="M9 7H5v5h3c0 2-1 3-3 4M19 7h-4v5h3c0 2-1 3-3 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  like: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  delete: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};
ICONS.bell = '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2.2 2.2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
ICONS.follow = '<circle cx="10" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
ICONS.mention = '<circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
ICONS.more = '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>';
ICONS.spark = '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
const icon = (name) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------------------------------------------------------------- views

let showing = 0; // the render in progress: an older one that finishes late draws nothing

async function render() {
  const mine = ++showing;
  const route = parseRoute(location.hash);
  const draw = (html) => {
    if (mine !== showing) return false;
    // A redraw while someone types keeps where they were.
    const typing = document.activeElement?.closest?.("main form[data-compose]") && document.activeElement;
    const at = typing && { key: typing.closest("form").dataset.compose, name: typing.name, alt: typing.dataset.alt, start: typing.selectionStart, end: typing.selectionEnd };
    main.innerHTML = html;
    fillStats(main);
    fillMedia(main);
    if (at) {
      const form = main.querySelector(`form[data-compose="${CSS.escape(at.key)}"]`);
      const again = at.alt ? form?.querySelector(`[data-alt="${CSS.escape(at.alt)}"]`) : form?.elements[at.name];
      again?.focus();
      again?.setSelectionRange?.(at.start, at.end);
    }
    return true;
  };
  main.setAttribute("aria-busy", "true");
  if (!["home", "following", "everyone"].includes(route.view)) (timeline = null), (pill.hidden = true);
  try {
    if (route.view === "home") await home(draw, "foryou");
    else if (route.view === "following") await home(draw, me ? "following" : "foryou");
    else if (route.view === "everyone") await home(draw, "everyone");
    else if (route.view === "notifications") await notificationsPage(draw);
    else if (route.view === "search") await searchPage(draw, route.q);
    else if (route.view === "person") await person(draw, route.who, route.tab);
    else if (route.view === "post") await postPage(draw, route);
    else draw(`<p class="status">Nothing is here. <a href="#/">Go home</a>.</p>`);
  } catch (error) {
    console.error(error);
    draw(`<div class="status"><p>Murmur couldn't be read just now: ${esc(error.message)}</p><button class="secondary" data-act="retry">Try again</button></div>`);
  } finally {
    if (mine === showing) main.removeAttribute("aria-busy");
    checkUnread();
  }
}

// Drafts outlive a redraw, pictures and all: keyed "home", "reply:<a>/<id>" or "quote:<a>/<id>".
const drafts = new Map(); // key → { text, media: [{ id, url, type?, cid?, volume?, alt, state, note, stop? }] }
const draftOf = (key) => drafts.get(key) ?? drafts.set(key, { text: "", media: [] }).get(key);

function composer(key, placeholder = "What's happening?") {
  const draft = draftOf(key);
  const [kind, to] = key.split(":");
  const points = kind === "reply" ? ` data-reply="${to}"` : kind === "quote" ? ` data-quote="${to}"` : "";
  const id = `draft-${key.replace(/[^a-z0-9]/gi, "-")}`;
  return `
  <form class="compose" data-compose="${esc(key)}"${points}>
    ${avatar(me)}
    <div class="body">
      <label class="sr" for="${id}">Your post</label>
      <textarea id="${id}" name="text" rows="3" maxlength="1200" placeholder="${esc(placeholder)}">${esc(draft.text)}</textarea>
      <ul class="attached" data-attached>${attachedHTML(draft)}</ul>
      <div class="compose-foot">
        <label class="act add-media" title="Add pictures">${icon("picture")}<span class="sr">Add pictures</span><input type="file" class="sr" data-pick multiple accept="${m.MEDIA_TYPES.join(",")}"></label>
        <span class="left muted small" aria-live="polite">${left(draft.text)}</span><button type="submit"${ready(draft) ? "" : " disabled"}>Post</button>
      </div>
    </div>
  </form>`;
}

function attachedHTML(draft) {
  return draft.media
    .map((item) => `
    <li data-mid="${item.id}">
      <img src="${item.url}" alt="">
      <div class="about">
        <label class="sr" for="alt-${item.id}">Describe this picture</label>
        <input id="alt-${item.id}" data-alt="${item.id}" maxlength="${m.MAX_ALT}" placeholder="Describe it for people who can't see it" value="${esc(item.alt)}">
        <p class="note small ${item.state === "failed" ? "bad" : "muted"}" aria-live="polite">${esc(item.note)}</p>
        ${item.state === "failed" && item.volume ? `<button type="button" class="secondary small-button" data-act="rekeep" data-mid="${item.id}">Try again</button>` : ""}
      </div>
      <button type="button" class="act" data-act="unattach" data-mid="${item.id}" aria-label="Remove this picture">✕</button>
    </li>`)
    .join("");
}

/** Whether a draft can be posted: something to say or show, not too long, every picture kept. */
const ready = (draft) => left(draft.text) >= 0 && (draft.text.trim() !== "" || draft.media.length > 0) && draft.media.every((item) => item.state === "kept");

/** Draws a draft's pictures again in every form showing it. */
function redrawAttached(key) {
  for (const form of document.querySelectorAll(`form[data-compose="${CSS.escape(key)}"]`)) {
    const focused = document.activeElement?.dataset?.alt;
    form.querySelector("[data-attached]").innerHTML = attachedHTML(draftOf(key));
    if (focused) form.querySelector(`[data-alt="${CSS.escape(focused)}"]`)?.focus();
    updateForm(form);
  }
}

/** One picture's note, changed in place: progress must not take the focus from its description. */
function noteOf(key, item) {
  for (const note of document.querySelectorAll(`form[data-compose="${CSS.escape(key)}"] li[data-mid="${item.id}"] .note`)) note.textContent = item.note;
}

/**
 * A chosen file as a picture to keep: re-encoded (which drops its metadata,
 * such as where it was taken), at most 2048 pixels across and 1 MB. A GIF is
 * kept as it is, so that it still moves.
 */
async function preparePicture(file) {
  if (file.type === "image/gif") {
    if (file.size > MAX_MEDIA_BYTES) throw new Error("That GIF is over 1 MB. Try a shorter one.");
    return { type: "image/gif", bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That isn't a picture this browser can read.");
  }
  let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  for (let tries = 0; tries < 8; tries++, scale *= 0.75) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.72]) {
      // WebP where the browser writes it, else JPEG.
      let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (blob?.type !== "image/webp") blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_MEDIA_BYTES) return { type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
    }
  }
  throw new Error("That picture couldn't be made small enough.");
}

async function attach(key, files) {
  const draft = draftOf(key);
  const room = m.MAX_MEDIA - draft.media.length;
  if (files.length > room) say(`A post shows at most ${m.MAX_MEDIA} pictures.`, { error: true });
  for (const file of [...files].slice(0, Math.max(0, room))) {
    const item = { id: crypto.randomUUID().slice(0, 8), url: URL.createObjectURL(file), alt: "", state: "preparing", note: "Getting it ready…" };
    draft.media.push(item);
    redrawAttached(key);
    try {
      const { type, bytes } = await preparePicture(file);
      const volume = murmur.mediaVolume(type, bytes);
      Object.assign(item, { type, volume, cid: volume.cid, url: URL.createObjectURL(new Blob([bytes], { type })) });
      keepPicture(key, item);
    } catch (error) {
      Object.assign(item, { state: "failed", note: error.message });
      redrawAttached(key);
    }
  }
}

/** Has the storage sponsor keep a picture for good, paid with this device's work, saying how far along it is. */
async function keepPicture(key, item) {
  const stop = new AbortController();
  Object.assign(item, { state: "keeping", note: "Sending it to be kept…", stop: () => stop.abort() });
  redrawAttached(key);
  const device = await workDevice();
  try {
    await murmur.keep(item.volume, {
      hash: hasher,
      signal: stop.signal,
      progress: ({ stage, done }) => {
        item.note = {
          upload: "Sending it to be kept…",
          work: `Keeping it for good: this device's ${device} pays with a moment of work…`,
          busy: "The storage sponsor is busy: waiting a moment…",
          grind: `Keeping it for good: this device's ${device} pays with work… ${Math.round((done ?? 0) * 100)}%`,
          pin: "Paid. It's being kept…",
        }[stage] ?? item.note;
        noteOf(key, item);
      },
    });
    // Kept: shown from here at once, without reading it back.
    pictures.set(item.cid, Promise.resolve(item.url));
    Object.assign(item, { state: "kept", note: "Kept for good." });
  } catch (error) {
    if (error instanceof StorageStopped) return;
    Object.assign(item, { state: "failed", note: error instanceof StorageRefused ? error.message : `Couldn't keep it: ${error?.message ?? error}` });
  }
  redrawAttached(key);
}

// How many pages of a timeline show, until the route changes; and what the
// shown timeline holds, to tell when there are newer posts than it.
let pages = { view: null, n: 1 };
let timeline = null; // { newest: post id, authors: Set | null (everyone) }
const pagesOf = (view) => (pages.view === view ? pages.n : ((pages = { view, n: 1 }), 1));
const moreButton = (shown, total) => (shown < total ? `<div class="more"><button class="secondary" data-act="show-more">Show more</button></div>` : "");
function watching(posts, authors) {
  const newest = posts.reduce((n, p) => (p.id > n ? p.id : n), "");
  timeline = { newest, authors };
  pill.hidden = true;
}

const pill = Object.assign(document.createElement("button"), { className: "new-posts", hidden: true, textContent: "↑ New posts" });
pill.dataset.act = "new-posts";
document.body.append(pill);
/** Once a minute, while a timeline shows: are there posts newer than it, from whom it shows? */
setInterval(async () => {
  const view = parseRoute(location.hash).view;
  if (!timeline || document.hidden || !["home", "following", "everyone"].includes(view) || !pill.hidden) return;
  try {
    const latest = await murmur.everyone({ limit: 20 });
    const fresh = latest.filter((p) => p.id > timeline.newest && p.author !== me && (!timeline.authors || timeline.authors.has(p.author)) && !mutedSet().has(p.author));
    pill.hidden = fresh.length === 0;
  } catch {}
}, 60_000);

async function home(draw, view) {
  const tab = (href, label, v) => `<a href="${href}" ${view === v ? 'aria-current="page"' : ""}>${label}</a>`;
  const tabs = `<nav class="tabs" aria-label="Timelines">${tab("#/", "For you", "foryou")}${me ? tab("#/following", "Following", "following") : ""}${tab("#/everyone", "Everyone", "everyone")}</nav>`;
  // Made at each draw, so a draft typed while the timeline loads is kept.
  const intro = () => me
    ? composer("home")
    : `<section class="intro"><h1 tabindex="-1">Say it on Murmur.</h1><p class="muted">Short posts no one can take down or sell. Nothing to install and no coins needed: your device does a moment of work for each post.</p><button data-act="connect">Connect with Selfhold</button></section>`;
  const top = () => `${intro()}${tabs}${pendingList()}`;
  draw(`${top()}<p class="status muted">Reading…</p>`);
  if (view === "foryou") return forYouPage(draw, top);
  const muted = mutedSet();
  let posts;
  let following = [];
  const limit = 50 * pagesOf(view);
  if (view === "everyone") {
    posts = await murmur.everyone({ limit: limit + 1 });
  } else {
    // Not read is not nobody: it says so, and shows your own posts meanwhile.
    following = await within(followGraph.following(me).catch(() => null), 8_000, null);
    posts = await murmur.feed([me, ...(following ?? [])], { limit: limit + 1 });
  }
  const more = moreButton(limit, posts.length);
  posts = posts.slice(0, limit);
  watching(posts, view === "everyone" ? null : new Set([me, ...(following ?? [])]));
  const html = await renderPosts(posts.filter((p) => !muted.has(p.author)));
  if (view === "following" && following === null) {
    return draw(`${top()}<div class="status"><p class="muted">Whom you follow couldn't be read just now.</p><button class="secondary" data-act="retry">Try again</button></div><ul class="posts">${html}</ul>`);
  }
  if (view === "following" && following.length === 0) {
    return draw(`${top()}<p class="status muted">You follow nobody yet. Find people on <a href="#/">For you</a> or <a href="#/everyone">Everyone</a>, then follow them from their page.</p><ul class="posts">${html}</ul>`);
  }
  draw(`${top()}${html ? `<ul class="posts">${html}</ul>${more}` : `<p class="status muted">No posts yet. Be the first.</p>`}`);
}

// ---------------------------------------------------------------- search

async function searchPage(draw, q) {
  document.querySelector("#q").value = q;
  const top = `<h1 class="page-title" tabindex="-1">Search: ${esc(q)}</h1>`;
  draw(`${top}<p class="status muted">Searching…</p>`);
  const { posts } = await murmur.snapshot();
  const found = searchPosts(posts, q, { muted: mutedSet() });
  // A single word that could be a handle: offer the person too, when someone shows it.
  const word = q.trim().replace(/^[@＠]/, "").toLowerCase();
  const who = parseWho(word);
  const person = who?.handle ? await within(graph.person(`@${who.handle}`).catch(() => ({})), 8_000, {}) : {};
  let people = "";
  if (person.account) {
    await know([person.account]);
    people = `<ul class="suggest-list"><li class="suggest-item">${avatar(person.account)}<div class="body">${await byline(person.account)}</div></li></ul>`;
  }
  const html = await renderPosts(found);
  draw(`${top}${people}${html ? `<ul class="posts">${html}</ul>` : `<p class="status muted">No posts hold ${esc(q)}. Search finds posts holding every word you type.</p>`}`);
}

// ---------------------------------------------------------------- notifications

// Nothing tells you what happened; the page reads it from the chain. Likes
// and follows carry no time, so this device keeps when it first saw each, and
// when you last looked. Seen nowhere else.
const notifyStore = {
  key: () => `murmur:notify:${me}`,
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(this.key()) ?? "null");
      return v && typeof v === "object" ? { firstSeen: v.firstSeen ?? {}, readAt: v.readAt ?? 0, started: true } : { firstSeen: {}, readAt: 0, started: false };
    } catch {
      return { firstSeen: {}, readAt: 0, started: false };
    }
  },
  save(v) {
    try {
      localStorage.setItem(this.key(), JSON.stringify({ firstSeen: v.firstSeen, readAt: v.readAt }));
    } catch {}
  },
};

/** What happened to you, with each like and follow stamped the first time this device sees it. */
async function readNotifications() {
  const account = me;
  const [snapshot, followers, handle] = await Promise.all([murmur.snapshot(), within(graph.followers(account).catch(() => []), 8_000, []), know([account]).then(() => handleOf(account))]);
  const saved = notifyStore.load();
  const firstSeen = new Map(Object.entries(saved.firstSeen).filter(([, t]) => t > 0));
  const muted = mutedSet();
  const { items, keys } = notifications(snapshot, account, { followers, handle, firstSeen, muted });
  // The first look stamps what's there already as old (0), so it isn't all "now".
  const now = Date.now();
  let changed = false;
  for (const k of keys) if (!(k in saved.firstSeen)) (saved.firstSeen[k] = saved.started ? now : 0), (changed = true);
  if (changed && account === me) notifyStore.save(saved);
  if (!changed) return { items, saved };
  // Read again with the new stamps, so they sort as new.
  const again = new Map(Object.entries(saved.firstSeen).filter(([, t]) => t > 0));
  return { items: notifications(snapshot, account, { followers, handle, firstSeen: again, muted }).items, saved };
}

let unreadAt = 0;
/** Lights the bell when something happened since you last looked; at most once a minute. */
async function checkUnread({ force = false } = {}) {
  if (!me || (!force && Date.now() - unreadAt < 60_000)) return;
  unreadAt = Date.now();
  try {
    const { items, saved } = await readNotifications();
    const n = items.filter((i) => i.at > saved.readAt).length;
    const dot = you.querySelector(".bell .dot");
    if (!dot) return;
    dot.hidden = n === 0 || parseRoute(location.hash).view === "notifications";
    you.querySelector(".bell").setAttribute("aria-label", n ? `Notifications, ${n} new` : "Notifications");
  } catch (error) {
    console.error(error);
  }
}

async function notificationsPage(draw) {
  const top = `<h1 class="page-title" tabindex="-1">Notifications</h1>`;
  if (!me) return draw(`${top}<section class="intro"><p class="muted">Connect to see who replied to you, liked or reposted your posts, mentioned you and followed you.</p><button data-act="connect">Connect with Selfhold</button></section>`);
  draw(`${top}<p class="status muted">Reading…</p>`);
  const { items, saved } = await readNotifications();
  const readAt = saved.readAt;
  saved.readAt = Date.now();
  notifyStore.save(saved);
  const dot = you.querySelector(".bell .dot");
  if (dot) dot.hidden = true;
  if (!items.length) return draw(`${top}<p class="status muted">Nothing yet. When someone replies to you, likes or reposts your posts, mentions your @handle or follows you, it shows here.</p>`);
  await know(items.flatMap((i) => [...(i.actors?.slice(0, 6) ?? []), i.post?.author].filter(Boolean)));
  const rows = await Promise.all(items.map(async (item) => {
    const fresh = item.at > readAt ? " unread" : "";
    if (item.post) {
      const [verb, name] = { reply: ["replied", "reply"], quote: ["quoted your post", "quote"], mention: ["mentioned you", "mention"] }[item.type];
      const header = `<p class="reposted muted small">${icon(name)} <span>${await nameLink(item.post.author)} ${verb}</span></p>`;
      const html = await renderPosts([item.post], { headers: new Map([[`${item.post.author}/${item.post.id}`, header]]) });
      return fresh ? html.replace('class="post', `class="post${fresh}`) : html;
    }
    const others = item.actors.length - 1;
    const who = `${await nameLink(item.actors[0])}${others ? ` and ${others} other${others === 1 ? "" : "s"}` : ""}`;
    const [name, verb] = { like: ["like", "liked your post"], repost: ["repost", "reposted your post"], follow: ["follow", "followed you"] }[item.type];
    const faces = item.actors.slice(0, 6).map((a) => `<a href="${personPath(a)}" aria-hidden="true" tabindex="-1">${avatar(a, 28)}</a>`).join("");
    const target = item.target
      ? `<a class="notice-target muted" href="${postPath(item.target)}">${esc(item.target.text?.trim() || (item.target.media?.length ? "A picture" : "Your post"))}</a>`
      : "";
    return `<li class="notice ${item.type}${fresh}"><span class="notice-icon">${icon(name)}</span><div class="body"><div class="faces">${faces}</div><p>${who} ${verb}</p>${target}</div></li>`;
  }));
  draw(`${top}<ul class="posts notices">${rows.join("")}</ul>`);
}

// ---------------------------------------------------------------- For you

// What you tell Murmur about your feed stays on this device: posts you've
// seen, posts you're not interested in, and whom you've muted. Nothing of it
// is written to the chain or sent anywhere.
const SEEN_DAYS = 30;
const feedback = {
  key: () => `murmur:feedback:${me ?? "anyone"}`,
  load() {
    try {
      const v = JSON.parse(localStorage.getItem(this.key()) ?? "{}");
      return { seen: v.seen ?? {}, hidden: v.hidden ?? {}, muted: v.muted ?? {}, notInterested: v.notInterested ?? {} };
    } catch {
      return { seen: {}, hidden: {}, muted: {}, notInterested: {} };
    }
  },
  update(change) {
    const v = this.load();
    change(v);
    const old = Date.now() - SEEN_DAYS * 86_400_000;
    v.seen = Object.fromEntries(Object.entries(v.seen).filter(([, t]) => t > old).sort((a, b) => b[1] - a[1]).slice(0, 3000));
    try {
      localStorage.setItem(this.key(), JSON.stringify(v));
    } catch {}
  },
};
const mutedSet = () => new Set(Object.keys(feedback.load().muted));
// What earlier visits showed, read once a visit, so this visit's order holds still.
let seenBefore = null;

/**
 * `promise`, or `fallback` once `ms` pass: for reads of Follows, which waits
 * as long as its hosts do. A page without follows beats a page that never draws.
 */
let followsRestsUntil = 0;
const within = (promise, ms, fallback) => {
  if (Date.now() < followsRestsUntil) return Promise.resolve(fallback);
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => ((followsRestsUntil = Date.now() + 60_000), resolve(fallback)), ms))]);
};

/** Every follow on Follows: account to account, as Follows keeps them. */
async function followEdges() {
  const state = await graph.state();
  const edges = [];
  for await (const [key] of state.list("follows/")) {
    const [a, t, ...rest] = key.slice("follows/".length).split("/");
    if (!rest.length && followRecords.isAddress(a) && followRecords.isAddress(t)) edges.push([a, t]);
  }
  return edges;
}

async function forYouPage(draw, top) {
  const [snapshot, follows] = await Promise.all([murmur.snapshot(), within(followEdges().catch(() => []), 8_000, [])]);
  const g = rank.index({ ...snapshot, follows });
  const saved = feedback.load();
  seenBefore ??= new Set(Object.keys(saved.seen));
  const page = rank.C.mix.page * pagesOf("foryou");
  const { items, suggestions } = rank.forYou(g, me, {
    page: page + 1,
    local: {
      seen: seenBefore,
      hidden: new Set(Object.keys(saved.hidden)),
      muted: new Set(Object.keys(saved.muted)),
      notInterested: new Map(Object.entries(saved.notInterested)),
    },
  });
  const more = moreButton(page, items.length);
  items.splice(page);
  const followed = g.followsOf.get(me);
  watching(items.map((i) => i.post), followed?.size ? new Set([me, ...followed]) : null);
  const now = Date.now();
  feedback.update((v) => items.forEach((i) => (v.seen[i.key] ??= now)));
  const cold = !me || !g.followsOf.get(me)?.size;
  const hint = cold && me ? `<p class="status muted small">These are popular on Murmur. Follow people and For you becomes yours: what they post, and what they like.</p>` : "";
  const suggest = await suggestionsHTML(suggestions);
  if (!items.length) return draw(`${top()}${hint}<p class="status muted">Nothing here yet. Be the first to post.</p>${suggest}`);
  await know(items.flatMap((i) => [i.post.author, ...(i.why?.actors?.slice(0, 1) ?? []), ...(i.why?.because ? [i.why.because.author] : [])]));
  const headers = new Map(await Promise.all(items.map(async (i) => [i.key, await whyHTML(i)])));
  const fresh = items.filter((i) => !i.seen).map((i) => i.post);
  const old = items.filter((i) => i.seen).map((i) => i.post);
  const [first, rest, seen] = await Promise.all([renderPosts(fresh.slice(0, 3), { headers }), renderPosts(fresh.slice(3), { headers }), renderPosts(old, { headers })]);
  draw(`${top()}${hint}
    ${first ? `<ul class="posts">${first}</ul>` : ""}
    ${suggest}
    ${rest ? `<ul class="posts">${rest}</ul>` : ""}
    ${seen ? `<p class="caught-up muted small">${fresh.length ? "You're caught up. Seen before:" : "Nothing new since you last looked. Seen before:"}</p><ul class="posts">${seen}</ul>` : ""}
    ${more}`);
}

/** A person's name as a link, for a line of text. */
async function nameLink(account) {
  const [handle, card] = await Promise.all([handleOf(account), cardOf(account)]);
  const name = card?.name?.replace(/[@＠﹫]/g, "") ?? (handle ? `@${handle}` : shortAccount(account));
  return `<a class="name" href="${personPath(account, handle)}">${esc(name)}</a>`;
}

/** Why a post is in For you, for the line above it: "Liked by @x and 2 others you follow". */
async function whyHTML({ why, parts }) {
  const debug = params.has("debug") ? ` title="${esc(Object.entries(parts).map(([k, v]) => `${k} ${Math.round(v * 1000) / 1000}`).join(" · "))}"` : "";
  const line = (name, text) => `<p class="reposted muted small"${debug}>${icon(name)} <span>${text}</span></p>`;
  if (!why) return params.has("debug") ? line("spark", "From whom you follow") : "";
  if (why.actors) {
    const others = why.actors.length - 1;
    const more = others ? ` and ${others} other${others === 1 ? "" : "s"} you follow` : "";
    const [verb, name] = { liked: ["Liked by", "like"], reposted: ["Reposted by", "repost"], replied: ["Replied to by", "reply"], quoted: ["Quoted by", "quote"] }[why.type];
    return line(name, `${verb} ${await nameLink(why.actors[0])}${more}`);
  }
  if (why.type === "similar") {
    await know([why.because.author]);
    const whose = why.because.author === me ? "your" : `${await nameLink(why.because.author)}'s`;
    return line("like", `Because you liked ${whose} <a href="${postPath(why.because)}">post</a>`);
  }
  if (why.type === "trend") return line("spark", "Popular in your network today");
  if (why.type === "network") return line("like", "Liked by people your follows follow");
  if (why.type === "popular") return line("spark", "Popular on Murmur");
  return "";
}

/** Whom to follow, with whom of yours follows them. */
async function suggestionsHTML(list) {
  if (!list.length) return "";
  await know([...list.map((s) => s.account), ...list.flatMap((s) => s.via.slice(0, 1))]);
  const rows = await Promise.all(list.map(async (s) => {
    const why = s.via.length
      ? `Followed by ${await nameLink(s.via[0])}${s.via.length > 1 ? ` and ${s.via.length - 1} more you follow` : ""}`
      : `${s.followers.toLocaleString("en-US")} ${s.followers === 1 ? "follower" : "followers"}`;
    return `<li class="suggest-item">${avatar(s.account)}<div class="body">${await byline(s.account)}<p class="muted small">${why}</p></div><button data-act="follow" data-who="${s.account}" aria-pressed="false">Follow</button></li>`;
  }));
  return `<section class="suggest" aria-labelledby="suggest-title"><h2 id="suggest-title">Who to follow</h2><ul>${rows.join("")}</ul></section>`;
}

async function person(draw, who, tab = "posts") {
  const found = await within(graph.person(who.account ?? `@${who.handle}`), 8_000, who.account ? { account: who.account } : null);
  if (!found) throw new Error(`no host answered who @${who.handle} is`);
  if (!found.account) return draw(`<p class="status">Nobody shows @${esc(who.handle)} now. <a href="${MONIKER_APP}">It may be free on Moniker.</a></p>`);
  const account = found.account;
  await know([account]);
  const [handle, card, counts, posts, following] = await Promise.all([
    handleOf(account),
    cardOf(account),
    within(followGraph.counts(account).catch(() => undefined), 8_000, undefined),
    tab === "likes" ? murmur.likedBy(account, { limit: 100 }) : murmur.postsBy(account, { limit: tab === "posts" ? 300 : 500 }),
    me && me !== account ? within(followGraph.follows(me, account).catch(() => false), 8_000, false) : false,
  ]);
  const self = account === me;
  const name = card.name?.replace(/[@＠﹫]/g, "");
  const actions = self
    ? `<button class="secondary" data-act="edit-card">Edit profile</button>${handle ? "" : `<button class="secondary" data-act="pick-handle">Choose a @handle</button>`}`
    : `${mutedSet().has(account) ? `<button class="secondary" data-act="unmute" data-who="${account}">Unmute</button>` : ""}<button data-act="${following ? "unfollow" : "follow"}" data-who="${account}" aria-pressed="${following}">${following ? "Following" : "Follow"}</button>`;
  // Posts leaves out replies, as X does; Replies is everything; Media, posts with pictures.
  const shown = {
    posts: posts.filter((p) => !p.reply).slice(0, 100),
    replies: posts.slice(0, 100),
    media: posts.filter((p) => p.media?.length).slice(0, 100),
    likes: posts,
  }[tab].filter((p) => tab !== "likes" || !mutedSet().has(p.author));
  const html = await renderPosts(shown);
  const base = personPath(account, handle);
  const tabs = `<nav class="tabs" aria-label="${esc(name ?? handle ?? "Their")} posts">${[["posts", "Posts"], ...PROFILE_TABS.map((t) => [t, t[0].toUpperCase() + t.slice(1)])]
    .map(([t, label]) => `<a href="${t === "posts" ? base : `${base}/${t}`}" ${t === tab ? 'aria-current="page"' : ""}>${label}</a>`)
    .join("")}</nav>`;
  const none = { posts: "No posts yet.", replies: "No posts or replies yet.", media: "No pictures yet.", likes: "No likes yet." }[tab];
  draw(`
    <section class="profile">
      ${avatar(account, 72)}
      <div class="who">
        <h1 tabindex="-1">${esc(name ?? (handle ? `@${handle}` : shortAccount(account)))}</h1>
        <p class="muted">${handle && name ? `@${esc(handle)} · ` : ""}<span class="mono" title="${account}">${esc(shortAccount(account))}</span></p>
        ${card.bio ? `<p class="bio">${renderText(card.bio)}</p>` : ""}
        ${counts ? `<p class="counts small"><span><strong>${counts.following.toLocaleString("en-US")}</strong> following</span><span><strong>${counts.followers.toLocaleString("en-US")}</strong> ${counts.followers === 1 ? "follower" : "followers"}</span></p>` : ""}
      </div>
      <div class="profile-actions">${actions}</div>
    </section>
    ${tabs}
    ${self && tab === "posts" ? pendingList() : ""}
    ${html ? `<ul class="posts">${html}</ul>` : `<p class="status muted">${none}</p>`}`);
}

async function postPage(draw, to) {
  const thread = await murmur.thread(to);
  if (!thread) return draw(`<p class="status">This post was deleted, or never was. <a href="#/">Go home</a>.</p>`);
  const above = thread.above.filter((p) => !p.missing);
  const gap = thread.above.some((p) => p.missing) ? `<p class="status muted small">An earlier post in this thread was deleted.</p>` : "";
  const [aboveHTML, focusHTML, repliesHTML] = await Promise.all([renderPosts(above), renderPosts([thread.post], { focus: to }), renderPosts(thread.replies.filter((p) => !mutedSet().has(p.author)))]);
  draw(`
    <a class="back" href="#/">← Home</a>
    ${gap}
    <ul class="posts thread">${aboveHTML}${focusHTML}</ul>
    ${me ? composer(`reply:${to.author}/${to.id}`, "Post your reply") : `<p class="status"><button data-act="connect">Connect to reply</button></p>`}
    ${pendingList(to)}
    ${repliesHTML ? `<ul class="posts">${repliesHTML}</ul>` : ""}`);
}

// ---------------------------------------------------------------- writing

/** Posts sent and not yet seen on the chain, newest first: { author, id, text, reply?, quote? }. */
const pending = [];
function pendingList(replyTo) {
  const shown = pending.filter((p) => (replyTo ? p.reply?.author === replyTo.author && p.reply?.id === replyTo.id : !p.reply));
  if (!shown.length) return "";
  return `<ul class="posts pending">${shown.map((p) => `<li class="post"><div class="row">${avatar(p.author)}<div class="body"><p class="meta muted small">Saving… about a minute</p>${p.text ? `<p class="text">${renderText(p.text)}</p>` : ""}${p.urls?.length ? `<div class="media n${p.urls.length}">${p.urls.map((url) => `<span class="pic"><img src="${url}" alt=""></span>`).join("")}</div>` : ""}</div></div></li>`).join("")}</ul>`;
}

/** Waits until `landed()`, checking every few seconds for up to 10 minutes, then shows the page again. */
async function whenLanded(landed, done) {
  for (const deadline = Date.now() + 600_000; Date.now() < deadline; ) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    if (await landed().catch(() => false)) break;
  }
  done?.();
  render();
}

function say(text, { error = false } = {}) {
  toast.textContent = text;
  toast.classList.toggle("bad", error);
  toast.hidden = !text;
  clearTimeout(say.timer);
  if (text && !error) say.timer = setTimeout(() => (toast.hidden = true), 6000);
}

/** What went wrong with a write, for a person. */
function walletMessage(error) {
  if (error?.code === "NeedsCoins") {
    const why = {
      down: "The fee sponsor isn't answering right now, so this device's work can't pay the fee.",
      dear: "This device can't do the fee's work in reasonable time right now.",
      most: "The fee sponsor pays only so much for one write, and this one costs more.",
    }[error.sponsor] ?? "The fee sponsor couldn't pay this fee.";
    return `${why} Try again in a few minutes.`;
  }
  const text = String(error?.message ?? error);
  if (error?.code === "PopupBlocked") return "Your browser blocked Selfhold's window. Allow pop-ups for this page, then try again.";
  if (error?.code === "Closed") return "Selfhold's window was closed. Nothing was sent.";
  if (/just declined|ask again in a moment/i.test(text)) return "Selfhold waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in Selfhold. Nothing was sent.";
  return text;
}

/** Runs `write` (which sends through the wallet), saying how it goes. */
async function writing(label, write) {
  if (!me) await connect();
  if (!me) return false;
  say(`Approve it in Selfhold…`);
  try {
    const sent = await write({ wallet, account: me, progress: (text) => say(`${text}…`.replace(/[.…]+…$/, "…")) });
    say(sent === null ? "" : `${label} Saving… about a minute.`);
    return true;
  } catch (error) {
    if (/may still land/i.test(String(error?.message))) {
      say(`${label} Saving… about a minute.`);
      return true;
    }
    if (error?.code === "AccountChanged" || error?.code === "NotConnected") setMe(await wallet.address().catch(() => null));
    say(walletMessage(error), { error: true });
    return false;
  }
}

async function post(form) {
  const key = form.dataset.compose;
  const saved = draftOf(key);
  if (!ready(saved)) return false;
  const [author, id] = form.dataset.reply?.split("/") ?? [];
  const quoteOf = form.dataset.quote?.split("/");
  const media = saved.media.map(({ cid, type, alt }) => ({ cid, type, ...(alt.trim() && { alt }) }));
  const draft = { text: saved.text, ...(media.length && { media }), ...(author && { reply: { author, id } }), ...(quoteOf && { quote: { author: quoteOf[0], id: quoteOf[1] } }) };
  try {
    m.compose(me, draft);
  } catch (error) {
    return say(error.message, { error: true });
  }
  form.querySelector("button[type=submit]").disabled = true;
  let posted;
  const ok = await writing("Posted.", async (how) => {
    posted = await murmur.compose(draft, how);
    return posted.sent;
  });
  form.querySelector("button[type=submit]").disabled = false;
  if (!ok) return false;
  drafts.delete(key);
  form.elements.text.value = "";
  form.querySelector("[data-attached]").innerHTML = "";
  updateForm(form);
  const entry = { author: me, id: posted.id, ...draft, urls: saved.media.map((item) => item.url) };
  pending.unshift(entry);
  render();
  whenLanded(async () => Boolean(await murmur.post(entry)), () => pending.splice(pending.indexOf(entry), 1));
  return true;
}

async function act(button) {
  const li = button.closest("li.post");
  const to = li && { author: li.dataset.author, id: li.dataset.id };
  const pressed = button.getAttribute("aria-pressed") === "true";
  switch (button.dataset.act) {
    case "connect":
      return connect();
    case "retry":
      return render();
    case "show-more": {
      pages.n += 1;
      const y = scrollY;
      await render();
      return scrollTo(0, y);
    }
    case "new-posts":
      // Seen-before stays as this visit had it, so the new posts come first.
      seenBefore = null;
      pill.hidden = true;
      scrollTo({ top: 0, behavior: "smooth" });
      return render();
    case "reply":
      return me ? openComposer({ reply: to }) : connect();
    case "quote":
      return me ? openComposer({ quote: to }) : connect();
    case "like":
      if (await writing(pressed ? "Unliked." : "Liked.", (how) => (pressed ? murmur.unlike(to, how) : murmur.like(to, how)))) {
        flip(button, !pressed, "likes");
        whenLanded(async () => (await murmur.stats(to, me)).liked === !pressed);
      }
      return;
    case "repost":
      if (await writing(pressed ? "Repost taken back." : "Reposted.", (how) => (pressed ? murmur.unrepost(to, how) : murmur.repost(to, how)))) {
        flip(button, !pressed, "reposts");
        whenLanded(async () => (await murmur.stats(to, me)).reposted === !pressed);
      }
      return;
    case "delete":
      if (await writing("Deleted.", (how) => murmur.remove(to.id, how))) {
        li.classList.add("leaving");
        whenLanded(async () => !(await murmur.post(to)));
      }
      return;
    case "follow":
    case "unfollow": {
      const who = button.dataset.who;
      const follow = button.dataset.act === "follow";
      const ok = await writing(follow ? "Following." : "Unfollowed.", async ({ wallet, account, progress }) => {
        await names.state({ fresh: true });
        const state = await graph.state({ fresh: true });
        const write = follow ? await followRecords.follow(state, names, account, who) : await followRecords.unfollow(state, names, account, who);
        if (write.actions.length === 0) return null;
        return wallet.writeRecords({ chainPath: graph.chain, actions: write.actions }, { account, progress });
      });
      if (ok) {
        button.dataset.act = follow ? "unfollow" : "follow";
        button.textContent = follow ? "Following" : "Follow";
        button.setAttribute("aria-pressed", String(follow));
        whenLanded(async () => (await followGraph.follows(me, who)) === follow);
      }
      return;
    }
    case "unattach":
    case "rekeep": {
      const key = button.closest("form[data-compose]").dataset.compose;
      const draft = draftOf(key);
      const item = draft.media.find((x) => x.id === button.dataset.mid);
      if (!item) return;
      if (button.dataset.act === "rekeep") return keepPicture(key, item);
      item.stop?.();
      draft.media.splice(draft.media.indexOf(item), 1);
      return redrawAttached(key);
    }
    case "view": {
      const url = await pictureURL(button.dataset.cid);
      if (!url) return say("That picture isn't being served just now.", { error: true });
      const alt = button.querySelector("img")?.alt ?? "";
      dialog.innerHTML = `
        <form method="dialog" class="dialog-head"><h2>Picture</h2><button class="secondary" value="cancel">Close</button></form>
        <img class="full" src="${url}" alt="${esc(alt)}">
        ${alt ? `<p class="small muted alt-text">${esc(alt)}</p>` : ""}`;
      return dialog.showModal();
    }
    case "more": {
      await know([to.author]);
      dialog.innerHTML = `
        <form method="dialog" class="dialog-head"><h2>This post</h2><button class="secondary" value="cancel">Close</button></form>
        <div class="menu">
          <button class="secondary" data-act="not-interested" data-key="${to.author}/${to.id}" data-who="${to.author}">Not interested in this post</button>
          <button class="secondary" data-act="mute" data-who="${to.author}">Mute ${await nameLink(to.author)}</button>
          <p class="muted small">Only this device knows. Not interested hides this post and shows you less from its author for a while; mute hides them everywhere until you unmute. Nobody is told.</p>
        </div>`;
      dialog.querySelectorAll(".menu a").forEach((a) => a.replaceWith(a.textContent));
      return dialog.showModal();
    }
    case "not-interested": {
      const now = Date.now();
      feedback.update((v) => {
        v.hidden[button.dataset.key] = now;
        v.notInterested[button.dataset.who] = now;
      });
      if (dialog.open) dialog.close();
      say("You'll see less like this.");
      return render();
    }
    case "mute":
      feedback.update((v) => (v.muted[button.dataset.who] = Date.now()));
      if (dialog.open) dialog.close();
      say("Muted. Only this device knows; unmute from their page.");
      return render();
    case "unmute":
      feedback.update((v) => delete v.muted[button.dataset.who]);
      say("Unmuted.");
      return render();
    case "edit-card":
      return editCard();
    case "pick-handle": {
      const handle = await document.querySelector("moniker-handle-picker").open();
      if (handle) {
        forget(me);
        render();
      }
      return;
    }
  }
}

/** Shows a like or repost as done (or undone) at once, before the chain has it. */
function flip(button, on, n) {
  button.setAttribute("aria-pressed", String(on));
  const span = button.querySelector(`[data-n="${n}"]`);
  const value = Number(span.textContent.replace(/,/g, "") || 0) + (on ? 1 : -1);
  span.textContent = count(Math.max(0, value));
}

// ---------------------------------------------------------------- dialogs

const dialog = document.querySelector("#dialog");
async function openComposer({ reply, quote }) {
  const to = reply ?? quote;
  const target = await murmur.post(to);
  if (!target) return say("That post was deleted.", { error: true });
  const shown = await renderPosts([target]);
  dialog.innerHTML = `
    <form method="dialog" class="dialog-head"><h2>${reply ? "Reply" : "Quote"}</h2><button class="secondary" value="cancel" aria-label="Close">Close</button></form>
    ${reply ? `<ul class="posts quoted-in-dialog">${shown}</ul>` : ""}
    ${composer(`${reply ? "reply" : "quote"}:${to.author}/${to.id}`, reply ? "Post your reply" : "Add a comment")}
    ${quote ? `<ul class="posts quoted-in-dialog">${shown}</ul>` : ""}`;
  dialog.querySelectorAll(".actions").forEach((a) => a.remove());
  fillMedia(dialog);
  dialog.showModal();
  dialog.querySelector("textarea").focus();
}

async function editCard() {
  const card = await murmur.card(me);
  dialog.innerHTML = `
    <form method="dialog" class="dialog-head"><h2>Edit profile</h2><button class="secondary" value="cancel">Close</button></form>
    <form class="card-form" data-card>
      <label>Name <input name="name" maxlength="50" value="${esc(card.name ?? "")}" autocomplete="name"></label>
      <label>Bio <textarea name="bio" rows="3" maxlength="300">${esc(card.bio ?? "")}</textarea></label>
      <p class="muted small">Your @handle comes from Moniker and shows in every Lattice app.</p>
      <button type="submit">Save</button>
    </form>`;
  dialog.showModal();
}

// ---------------------------------------------------------------- the account

function setMe(address) {
  if ((address ?? null) !== me) seenBefore = null;
  me = address ?? null;
  you.innerHTML = me
    ? `<a class="bell" href="#/notifications" aria-label="Notifications">${icon("bell")}<span class="dot" hidden></span></a><a class="me" href="${personPath(me)}" aria-label="Your profile">${avatar(me, 32)}</a>`
    : `<button data-act="connect">Connect</button>`;
  if (me) checkUnread();
}

async function connect() {
  try {
    setMe(await wallet.connect());
    render();
  } catch (error) {
    say(walletMessage(error), { error: true });
  }
}

// ---------------------------------------------------------------- events

function updateForm(form) {
  const draft = draftOf(form.dataset.compose);
  const n = left(draft.text);
  const out = form.querySelector(".left");
  out.textContent = String(n);
  out.classList.toggle("over", n < 0);
  form.querySelector("button[type=submit]").disabled = !ready(draft);
  form.querySelector(".add-media").hidden = draft.media.length >= m.MAX_MEDIA;
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-act]");
  if (button) {
    event.preventDefault();
    act(button);
  }
});
document.addEventListener("input", (event) => {
  const form = event.target.closest("form[data-compose]");
  if (!form) return;
  const draft = draftOf(form.dataset.compose);
  if (event.target.name === "text") draft.text = event.target.value;
  const item = event.target.dataset.alt && draft.media.find((x) => x.id === event.target.dataset.alt);
  if (item) item.alt = event.target.value;
  updateForm(form);
});
document.addEventListener("change", (event) => {
  if (!event.target.matches("input[data-pick]")) return;
  const files = [...event.target.files];
  event.target.value = "";
  if (files.length) attach(event.target.closest("form[data-compose]").dataset.compose, files);
});
// Pictures pasted or dropped into a draft are added to it.
document.addEventListener("paste", (event) => {
  const form = event.target.closest?.("form[data-compose]");
  const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (form && files.length) {
    event.preventDefault();
    attach(form.dataset.compose, files);
  }
});
document.addEventListener("dragover", (event) => event.target.closest?.("form[data-compose]") && event.preventDefault());
document.addEventListener("drop", (event) => {
  const form = event.target.closest?.("form[data-compose]");
  if (!form) return;
  event.preventDefault();
  const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) attach(form.dataset.compose, files);
});
document.addEventListener("keydown", (event) => {
  // ⌘/Ctrl-Enter posts.
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.target.closest("form[data-compose]")?.requestSubmit();
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.matches("[data-compose]")) {
    event.preventDefault();
    if ((await post(form)) && dialog.open) dialog.close();
  } else if (form.matches("[data-card]")) {
    event.preventDefault();
    const card = { name: form.elements.name.value, bio: form.elements.bio.value };
    if (await writing("Profile saved.", (how) => murmur.setCard(card, how))) {
      dialog.close();
      whenLanded(async () => {
        const now = await murmur.card(me);
        return (now.name ?? "") === card.name.trim() && (now.bio ?? "") === card.bio.trim();
      }, () => forget(me));
    }
  }
});
document.querySelector("#find").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = event.target.elements.q;
  const typed = input.value.trim();
  if (!typed) return;
  // @someone or an account ID goes to them; anything else searches posts.
  const who = /^[@＠]/.test(typed) || followRecords.isAddress(typed) ? parseWho(typed.replace(/^＠/, "@")) : null;
  location.hash = who ? personPath(who.account, who.handle) : searchPath(typed);
  if (who) input.value = "";
});
addEventListener("hashchange", () => {
  if (dialog.open) dialog.close();
  render();
  scrollTo(0, 0);
});

setMe(await wallet.address().catch(() => null));
// The remembered account from Selfhold's window, or none: either way the first page.
document.querySelector("moniker-handle-picker")?.addEventListener("moniker:shown", () => {
  forget(me);
  render();
});
render();
