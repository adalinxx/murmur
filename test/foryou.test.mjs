// For you's ranking (src/foryou.mjs), over records made here: what it shows,
// why, in what order, and that accounts nobody you trust follows can't push
// anything into it however many they make.
import assert from "node:assert/strict";
import { test } from "node:test";
import { C, fatigue, forYou, index, keyOf, personalTrust } from "../src/foryou.mjs";

const NOW = Date.UTC(2026, 10, 2, 12);
const HOUR = 3_600_000;
let n = 0;
const post = (author, hoursAgo, extra = {}) => ({ author, id: `p${(n++).toString(36)}`, at: NOW - hoursAgo * HOUR, text: "hi", ...extra });
const like = (account, p) => ({ account, author: p.author, id: p.id });
const ids = (items) => items.map((i) => i.key);

test("posts from whom you follow show; a stranger's shows only with proof from people you trust, saying whose", () => {
  const friend = post("ann", 1);
  const stranger = post("zed", 1);
  const likedByFriend = post("yan", 2);
  const g = index({
    posts: [friend, stranger, likedByFriend],
    likes: [like("ann", likedByFriend)],
    follows: [["me", "ann"]],
  });
  const { items } = forYou(g, "me", { now: NOW });
  assert.deepEqual(new Set(ids(items)), new Set([keyOf(friend), keyOf(likedByFriend)]));
  const shown = items.find((i) => i.key === keyOf(likedByFriend));
  assert.deepEqual(shown.why, { type: "liked", actors: ["ann"] });
  assert.equal(shown.inNetwork, false);
  assert.equal(items.find((i) => i.key === keyOf(friend)).why, null);
});

test("a repost credits the original, which shows once, as reposted by whom you follow", () => {
  const original = post("zed", 3);
  const repost = post("ann", 1, { text: "", repost: { author: original.author, id: original.id } });
  const g = index({ posts: [original, repost], likes: [], follows: [["me", "ann"]] });
  const { items } = forYou(g, "me", { now: NOW });
  assert.deepEqual(ids(items), [keyOf(original)]);
  assert.deepEqual(items[0].why, { type: "reposted", actors: ["ann"] });
});

test("an author's later posts are discounted, so one prolific friend doesn't fill the page", () => {
  const loud = Array.from({ length: 6 }, (_, i) => post("loud", i * 0.1));
  const quiet = post("quiet", 3);
  const g = index({ posts: [...loud, quiet], likes: [], follows: [["me", "loud"], ["me", "quiet"]] });
  const { items } = forYou(g, "me", { now: NOW });
  assert.ok(ids(items).indexOf(keyOf(quiet)) <= 2, `quiet came ${ids(items).indexOf(keyOf(quiet))}`);
});

test("posts from outside your network fill at most 40% of the page while there are posts from inside", () => {
  const friends = Array.from({ length: 10 }, (_, i) => `f${i}`);
  const inside = friends.map((f, i) => post(f, 20 + i));
  const outside = Array.from({ length: 20 }, (_, i) => post(`o${i}`, 1));
  const likes = outside.flatMap((p) => friends.slice(0, 3).map((f) => like(f, p)));
  const g = index({ posts: [...inside, ...outside], likes, follows: friends.map((f) => ["me", f]) });
  const { items } = forYou(g, "me", { now: NOW, page: 10 });
  assert.equal(items.length, 10);
  assert.ok(items.filter((i) => !i.inNetwork).length <= 4, items.map((i) => i.inNetwork).join());
});

test("one post per conversation: a reply and its parent don't both take a slot", () => {
  const parent = post("ann", 2);
  const reply = post("bob", 1, { reply: { author: parent.author, id: parent.id } });
  const g = index({ posts: [parent, reply], likes: [], follows: [["me", "ann"], ["me", "bob"]] });
  assert.equal(forYou(g, "me", { now: NOW }).items.length, 1);
});

test("your feedback stays yours: muted and hidden go, not interested fades over 140 days, seen goes last", () => {
  const a = post("ann", 1);
  const b = post("bob", 1);
  const c = post("cat", 1);
  const d = post("dan", 1);
  const g = index({ posts: [a, b, c, d], likes: [], follows: ["ann", "bob", "cat", "dan"].map((f) => ["me", f]) });
  const { items } = forYou(g, "me", {
    now: NOW,
    local: { muted: new Set(["ann"]), hidden: new Set([keyOf(b)]), seen: new Set([keyOf(c)]), notInterested: new Map() },
  });
  assert.deepEqual(ids(items), [keyOf(d), keyOf(c)]);
  assert.equal(fatigue(NOW, NOW), 0.2);
  assert.equal(fatigue(NOW - 70 * 24 * HOUR, NOW), 0.6000000000000001);
  assert.equal(fatigue(NOW - 140 * 24 * HOUR, NOW), 1);
  assert.equal(fatigue(undefined, NOW), 1);
  const tired = forYou(g, "me", { now: NOW, local: { notInterested: new Map([["dan", NOW]]) } }).items;
  assert.equal(tired.at(-1).key, keyOf(d));
});

test("before you follow anyone, the page is what's popular, labeled so, and whom many follow is suggested", () => {
  const hot = post("ann", 2);
  const cool = post("bob", 1);
  const g = index({
    posts: [hot, cool],
    likes: ["x", "y", "z"].map((u) => like(u, hot)),
    follows: [["x", "ann"], ["y", "ann"], ["z", "bob"]],
  });
  for (const viewer of [null, "me"]) {
    const { items, suggestions } = forYou(g, viewer, { now: NOW });
    assert.equal(items[0].key, keyOf(hot));
    assert.deepEqual(items[0].why, { type: "popular" });
    assert.equal(suggestions[0].account, "ann");
  }
});

test("whom to follow: those whom you follow follow, most first, saying through whom", () => {
  const g = index({
    posts: [post("cat", 1), post("dan", 1)],
    likes: [],
    follows: [["me", "ann"], ["me", "bob"], ["ann", "cat"], ["bob", "cat"], ["ann", "dan"], ["ann", "me"]],
  });
  const { suggestions } = forYou(g, "me", { now: NOW });
  assert.deepEqual(suggestions.map((s) => [s.account, s.via.length]), [["cat", 2], ["dan", 1]]);
});

test("trust: your follows 1, halving each step out and split by how many each follows, nothing below the floor", () => {
  const many = Array.from({ length: 200 }, (_, i) => `x${i}`);
  const follows = [["me", "ann"], ["ann", "bob"], ["ann", "cat"], ["bob", "dan"], ["dan", "eve"], ["cat", "me"], ...many.map((x) => ["bob", x])];
  const trust = personalTrust(index({ posts: [], likes: [], follows }), "me");
  assert.equal(trust.get("ann"), 1);
  assert.equal(trust.get("bob"), 0.25);
  assert.equal(trust.get("cat"), 0.25);
  // bob follows 201 accounts: each gets 1/201 of his share, under the floor.
  assert.equal(trust.has("dan"), false);
  assert.equal(trust.has("x0"), false);
  assert.equal(trust.has("eve"), false); // four steps out
  assert.equal(trust.has("me"), false);
});

// ---------------------------------------------------------------- sybils

/** A deterministic random number source. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * 300 honest accounts following each other, the viewer following 20 of them,
 * and a farm of 1,000 accounts that follow each other and all like one spam
 * post, joined to the honest side by `edges` follows from honest accounts.
 */
function world(edges) {
  const random = rng(7);
  const honest = Array.from({ length: 300 }, (_, i) => `h${i}`);
  const farm = Array.from({ length: 1000 }, (_, i) => `s${i}`);
  const follows = honest.slice(0, 20).map((h) => ["me", h]);
  for (const h of honest) for (let k = 0; k < 15; k++) follows.push([h, honest[Math.floor(random() * honest.length)]]);
  for (const s of farm) for (let k = 0; k < 10; k++) follows.push([s, farm[Math.floor(random() * farm.length)]]);
  // Attack edges: honest accounts (none the viewer follows) following farm accounts.
  for (let e = 0; e < edges; e++) follows.push([honest[100 + e], farm[e]]);
  const posts = honest.map((h, i) => post(h, (i % 48) + 1));
  const spam = post("s999", 1, { text: "buy now" });
  posts.push(spam);
  const likes = farm.map((s) => like(s, spam));
  for (let i = 0; i < 600; i++) likes.push(like(honest[Math.floor(random() * 300)], posts[Math.floor(random() * 300)]));
  return { g: index({ posts, likes, follows }), spam };
}

test("sybils: a farm with no follows from honest accounts gets nothing in, however many likes it makes", () => {
  const { g, spam } = world(0);
  const { items } = forYou(g, "me", { now: NOW, page: 300 });
  assert.equal(items.some((i) => i.key === keyOf(spam)), false);
});

test("sybils: each follow into the farm buys at most a bounded, roughly linear share of the spam's engagement", () => {
  const engagement = (edges) => {
    const { g, spam } = world(edges);
    const trust = personalTrust(g, "me");
    let E = 0;
    for (const [u] of g.engagers.get(keyOf(spam)) ?? []) E += trust.get(u) ?? 0;
    return E;
  };
  const one = engagement(1);
  const twenty = engagement(20);
  assert.ok(one < 1, `one attack edge buys ${one}`);
  assert.ok(twenty <= 20 * Math.max(one, C.trust.floor) + 1e-9, `20 edges buy ${twenty} vs ${one} for one`);
  // Even then the spam stays out of the top of the page.
  const { g, spam } = world(20);
  const rank = forYou(g, "me", { now: NOW, page: 100 }).items.findIndex((i) => i.key === keyOf(spam));
  assert.ok(rank === -1 || rank >= 50, `spam ranked ${rank}`);
});

test("a reply shows when you follow both sides, it answers you, or someone you follow engaged with it; not before you follow anyone", () => {
  const theirs = post("zed", 5);
  const friends = post("bob", 5);
  const mine = post("me", 5);
  const toStranger = post("ann", 1, { reply: { author: theirs.author, id: theirs.id } });
  const toFriend = post("ann", 1, { reply: { author: friends.author, id: friends.id } });
  const toMe = post("ann", 1, { reply: { author: mine.author, id: mine.id } });
  const strangers = post("yan", 1, { reply: { author: theirs.author, id: theirs.id } });
  const elsewhere = post("wes", 5);
  const liked = post("xia", 1, { reply: { author: elsewhere.author, id: elsewhere.id } });
  const g = index({
    posts: [theirs, friends, mine, elsewhere, toStranger, toFriend, toMe, strangers, liked],
    likes: [like("bob", liked)],
    follows: [["me", "ann"], ["me", "bob"]],
  });
  const shown = new Set(ids(forYou(g, "me", { now: NOW, page: 50 }).items));
  // ann's reply to a stranger doesn't show; the stranger's post does, as "Replied to by ann".
  assert.equal(shown.has(keyOf(toStranger)), false);
  assert.equal(shown.has(keyOf(theirs)), true);
  assert.equal(shown.has(keyOf(strangers)), false);
  assert.equal(shown.has(keyOf(toMe)), true);
  assert.equal(shown.has(keyOf(liked)), true);
  // toFriend and friends are one conversation: one of them shows.
  assert.equal(shown.has(keyOf(toFriend)) || shown.has(keyOf(friends)), true);
  const cold = forYou(g, null, { now: NOW, page: 50 }).items;
  assert.equal(cold.some((i) => i.post.reply), false);
});

test("because you liked: what trusted people who liked the same post also liked; an untrusted co-liker adds nothing", () => {
  const liked = post("zed", 30);
  const alsoLiked = post("yan", 2);
  const farmPick = post("spam", 2);
  const g = index({
    posts: [liked, alsoLiked, farmPick, post("ann", 1)],
    likes: [like("me", liked), like("bob", liked), like("bob", alsoLiked), like("sybil", liked), like("sybil", farmPick)],
    follows: [["me", "ann"], ["ann", "bob"]],
  });
  const { items } = forYou(g, "me", { now: NOW });
  const shown = items.find((i) => i.key === keyOf(alsoLiked));
  assert.ok(shown, "the co-liked post shows");
  assert.deepEqual(shown.why, { type: "similar", because: { author: liked.author, id: liked.id } });
  assert.equal(items.some((i) => i.key === keyOf(farmPick)), false);
});
