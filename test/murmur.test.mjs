// The record code (src/records/murmur.mjs) against a chain in memory that
// admits a write the way consensus would: every old value must be what the
// key holds, and the built policy must accept the body.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import * as m from "../src/records/murmur.mjs";
import { transaction } from "../src/records/wallet.mjs";
import { context, validate } from "./host.mjs";

const PATH = ["Nexus", "murmur"];
const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];

function chain() {
  const map = new Map();
  const state = {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
  function submit(owner, { actions }) {
    const body = transaction({ owner, actions, fee: 0n, nonce: 0n, chainPath: PATH });
    for (const { key, oldValue } of actions) if (map.get(key) !== oldValue) return false;
    if (!validate(context(sdk.encodeTransactionBody(body).bytes, { path: PATH }))) return false;
    for (const { key, newValue } of actions) {
      if (newValue === undefined) map.delete(key);
      else map.set(key, newValue);
    }
    return true;
  }
  /** Writes `write` as `owner`, asserting the chain takes it; returns it. */
  const ok = (owner, write) => (assert.ok(submit(owner, write), JSON.stringify(write.actions)), write);
  return { map, state, submit, ok };
}

let clock = Date.UTC(2026, 10, 2);
const at = () => ({ id: m.newId((clock += 1000)) });

test("ids sort by time and say when", () => {
  const [a, b] = [m.newId(1_000), m.newId(2_000_000_000_000)];
  assert.ok(a < b && m.isId(a) && a.length === 13);
  assert.equal(m.timeOf(b), 2_000_000_000_000);
  assert.equal(m.timeOf("x"), undefined);
});

test("posts are read back, newest first, by author and as a feed", async () => {
  const { state, ok } = chain();
  const first = ok(ALICE, m.compose(ALICE, { text: "first" }, at()));
  ok(BOB, m.compose(BOB, { text: "bob here" }, at()));
  ok(ALICE, m.compose(ALICE, { text: "second" }, at()));
  assert.deepEqual((await m.postsBy(state, ALICE)).map((p) => p.text), ["second", "first"]);
  assert.deepEqual((await m.feed(state, [ALICE, BOB])).map((p) => p.text), ["second", "bob here", "first"]);
  assert.deepEqual((await m.feed(state, [ALICE, BOB], { limit: 2 })).map((p) => p.text), ["second", "bob here"]);
  assert.deepEqual((await m.everyone(state)).map((p) => p.text), ["second", "bob here", "first"]);
  const post = await m.getPost(state, ALICE, first.id);
  assert.equal(post.text, "first");
  assert.equal(post.at, m.timeOf(first.id));
});

test("a post is checked before it's sent: something, not too long", () => {
  assert.throws(() => m.compose(ALICE, { text: "  " }));
  assert.throws(() => m.compose(ALICE, { text: "x".repeat(281) }));
  assert.doesNotThrow(() => m.compose(ALICE, { text: "😀".repeat(280) }));
  assert.throws(() => m.compose(ALICE, { text: "a", reply: { author: BOB, id: "a" }, quote: { author: BOB, id: "a" } }));
  assert.throws(() => m.compose(ALICE, { text: "a", reply: { author: "bob", id: "a" } }));
});

test("a thread: replies listed under their post, and the posts above", async () => {
  const { state, ok } = chain();
  const root = ok(ALICE, m.compose(ALICE, { text: "root" }, at()));
  const r1 = ok(BOB, m.compose(BOB, { text: "r1", reply: { author: ALICE, id: root.id } }, at()));
  const r2 = ok(CAROL, m.compose(CAROL, { text: "r2", reply: { author: BOB, id: r1.id } }, at()));
  ok(CAROL, m.compose(CAROL, { text: "another", reply: { author: ALICE, id: root.id } }, at()));
  const t = await m.thread(state, { author: BOB, id: r1.id });
  assert.deepEqual(t.above.map((p) => p.text), ["root"]);
  assert.equal(t.post.text, "r1");
  assert.deepEqual(t.replies.map((p) => p.text), ["r2"]);
  assert.deepEqual((await m.pointing(state, "reply", { author: ALICE, id: root.id })).map((p) => p.text), ["r1", "another"]);
  // Deleting a reply takes it off its post's list.
  ok(CAROL, await m.remove(state, CAROL, r2.id));
  assert.deepEqual((await m.thread(state, { author: BOB, id: r1.id })).replies, []);
  // A reply whose post is gone shows the gap.
  ok(ALICE, await m.remove(state, ALICE, root.id));
  assert.deepEqual((await m.thread(state, { author: BOB, id: r1.id })).above, [{ author: ALICE, id: root.id, missing: true }]);
  assert.equal(await m.thread(state, { author: ALICE, id: root.id }), undefined);
  // Its replies are still listed under it.
  assert.deepEqual((await m.pointing(state, "reply", { author: ALICE, id: root.id })).map((p) => p.text), ["r1", "another"]);
});

test("a listed pointer counts only while its post points there", async () => {
  const { state, ok } = chain();
  const root = ok(ALICE, m.compose(ALICE, { text: "root" }, at()));
  const elsewhere = ok(ALICE, m.compose(ALICE, { text: "elsewhere" }, at()));
  // Bob lists a post under Alice's root that replies to another post.
  const lie = m.compose(BOB, { text: "lie", reply: { author: ALICE, id: elsewhere.id } }, at());
  ok(BOB, { actions: [lie.actions[0], { key: m.pointerKey("reply", { author: ALICE, id: root.id }, BOB, lie.id), newValue: "1" }] });
  // And an entry for a post he never made.
  ok(BOB, { actions: [{ key: m.pointerKey("repost", { author: ALICE, id: root.id }, BOB, "nothing"), newValue: "1" }] });
  assert.deepEqual(await m.pointing(state, "reply", { author: ALICE, id: root.id }), []);
  const s = await m.stats(state, { author: ALICE, id: root.id }, BOB);
  assert.deepEqual(s, { replies: 0, reposts: 0, quotes: 0, likes: 0, liked: false, reposted: false });
});

test("likes, unlikes, reposts and quotes, counted", async () => {
  const { state, ok } = chain();
  const root = ok(ALICE, m.compose(ALICE, { text: "root" }, at()));
  const to = { author: ALICE, id: root.id };
  ok(BOB, await m.like(state, BOB, to));
  ok(CAROL, await m.like(state, CAROL, to));
  assert.deepEqual(await m.like(state, BOB, to), { actions: [] });
  ok(BOB, await m.repost(state, BOB, to, at()));
  assert.deepEqual(await m.repost(state, BOB, to), { actions: [] });
  ok(CAROL, m.compose(CAROL, { text: "look", quote: to }, at()));
  assert.deepEqual(await m.stats(state, to, BOB), { replies: 0, reposts: 1, quotes: 1, likes: 2, liked: true, reposted: true });
  // A repost is a post in Bob's timeline, pointing at Alice's.
  const [shared] = await m.postsBy(state, BOB);
  assert.deepEqual(shared.repost, to);
  ok(BOB, await m.unlike(state, BOB, to));
  ok(BOB, await m.unrepost(state, BOB, to));
  assert.deepEqual(await m.unlike(state, BOB, to), { actions: [] });
  assert.deepEqual(await m.stats(state, to, BOB), { replies: 0, reposts: 0, quotes: 1, likes: 1, liked: false, reposted: false });
  assert.deepEqual(await m.postsBy(state, BOB), []);
  // A gone post can't be reposted.
  ok(ALICE, await m.remove(state, ALICE, root.id));
  await assert.rejects(m.repost(state, BOB, to));
});

test("cards are set, changed and cleared", async () => {
  const { state, ok } = chain();
  ok(ALICE, await m.setCard(state, ALICE, { name: " Alice ", bio: "hi" }));
  assert.deepEqual(await m.card(state, ALICE), { name: "Alice", bio: "hi" });
  assert.deepEqual(await m.setCard(state, ALICE, { name: "Alice", bio: "hi" }), { actions: [] });
  ok(ALICE, await m.setCard(state, ALICE, { name: "Al" }));
  assert.deepEqual(await m.card(state, ALICE), { name: "Al" });
  ok(ALICE, await m.setCard(state, ALICE, {}));
  assert.deepEqual(await m.card(state, ALICE), {});
  await assert.rejects(m.setCard(state, ALICE, { name: "x".repeat(51) }));
});

test("anything that isn't a post is ignored by readers", async () => {
  const { map, state } = chain();
  for (const [i, value] of ["nope", "[]", '{"text":5}', '{"text":"  "}', '{"text":"a","repost":{"author":"x","id":"a"}}', '{"text":"x","repost":{"author":"' + BOB + '","id":"a"}}', JSON.stringify({ text: "x".repeat(281) })].entries()) {
    map.set(`post/${ALICE}/bad${i}`, value);
  }
  map.set(`post/${ALICE}/good`, JSON.stringify({ text: "good" }));
  assert.deepEqual((await m.postsBy(state, ALICE)).map((p) => p.id), ["good"]);
  assert.deepEqual(m.parseCard('{"name":5,"bio":"b"}'), { bio: "b" });
  assert.deepEqual(m.parseCard("garbage"), {});
});

test("another account's post can't be deleted", async () => {
  const { state, ok, submit } = chain();
  const root = ok(ALICE, m.compose(ALICE, { text: "mine" }, at()));
  assert.equal(submit(BOB, await m.remove(state, ALICE, root.id)), false);
});

test("a post shows up to four pictures, with or without text", async () => {
  const { state, ok } = chain();
  const pic = (seed, extra = {}) => ({ cid: address(seed), type: "image/webp", ...extra });
  const only = ok(ALICE, m.compose(ALICE, { media: [pic(10, { alt: "  a heron  " })] }, at()));
  const both = ok(ALICE, m.compose(ALICE, { text: "four", media: [pic(11), pic(12), pic(13), pic(14)] }, at()));
  assert.deepEqual((await m.getPost(state, ALICE, only.id)).media, [{ cid: address(10), type: "image/webp", alt: "a heron" }]);
  assert.equal((await m.getPost(state, ALICE, both.id)).media.length, 4);
  // A full post in a four-byte script with four full descriptions fits what the policy keeps...
  ok(ALICE, m.compose(ALICE, { text: "𓀀".repeat(280), media: [10, 11, 12, 13].map((s) => pic(s, { alt: "a".repeat(420) })) }, at()));
  // ...but not with descriptions in a two-byte script too: refused before it's sent.
  assert.throws(() => m.compose(ALICE, { text: "𓀀".repeat(280), media: [10, 11, 12, 13].map((s) => pic(s, { alt: "é".repeat(420) })) }), /too long to keep/);
  assert.throws(() => m.compose(ALICE, { media: [pic(1), pic(2), pic(3), pic(4), pic(5)] }), /at most 4/);
  assert.throws(() => m.compose(ALICE, { media: [{ cid: address(1), type: "image/svg+xml" }] }), /can't be posted/);
  assert.throws(() => m.compose(ALICE, { media: [{ cid: "bafy-not", type: "image/png" }] }), /can't be posted/);
  assert.throws(() => m.compose(ALICE, { media: [pic(1, { alt: "x".repeat(421) })] }), /description/);
  assert.throws(() => m.compose(ALICE, { text: " ", media: [] }), /Write something/);
});

test("readers drop posts whose media aren't pictures they show", async () => {
  const { map, state } = chain();
  const bad = [
    { text: "x", media: [] },
    { text: "x", media: [{ cid: address(1), type: "image/svg+xml" }] },
    { text: "x", media: [{ cid: "nope", type: "image/png" }] },
    { text: "x", media: Array.from({ length: 5 }, (_, i) => ({ cid: address(i + 1), type: "image/png" })) },
    { text: "", repost: { author: BOB, id: "a" }, media: [{ cid: address(1), type: "image/png" }] },
  ];
  bad.forEach((value, i) => map.set(`post/${ALICE}/bad${i}`, JSON.stringify(value)));
  map.set(`post/${ALICE}/good`, JSON.stringify({ text: "", media: [{ cid: address(1), type: "image/png" }] }));
  assert.deepEqual((await m.postsBy(state, ALICE)).map((p) => p.id), ["good"]);
});

test("snapshot: every post and like on the chain, in two prefix reads, for ranking", async () => {
  const { state, ok } = chain();
  const first = ok(ALICE, m.compose(ALICE, { text: "first" }, at()));
  const second = ok(BOB, m.compose(BOB, { text: "second" }, at()));
  ok(CAROL, await m.like(state, CAROL, { author: ALICE, id: first.id }));
  ok(BOB, await m.repost(state, BOB, { author: ALICE, id: first.id }, at()));
  const { posts, likes } = await m.snapshot(state);
  assert.equal(posts.length, 3);
  assert.ok(posts.some((p) => p.id === second.id && p.text === "second"));
  assert.ok(posts.some((p) => p.repost?.id === first.id));
  assert.deepEqual(likes, [{ account: CAROL, author: ALICE, id: first.id }]);
});

test("likedBy: the posts an account likes, newest post first, leaving out deleted ones", async () => {
  const { state, ok } = chain();
  const older = ok(ALICE, m.compose(ALICE, { text: "older" }, at()));
  const newer = ok(BOB, m.compose(BOB, { text: "newer" }, at()));
  const gone = ok(BOB, m.compose(BOB, { text: "gone" }, at()));
  for (const [author, p] of [[ALICE, older], [BOB, newer], [BOB, gone]]) ok(CAROL, await m.like(state, CAROL, { author, id: p.id }));
  ok(BOB, await m.remove(state, BOB, gone.id));
  assert.deepEqual((await m.likedBy(state, CAROL)).map((p) => p.text), ["newer", "older"]);
  assert.deepEqual(await m.likedBy(state, ALICE), []);
});
