// Runs the built policy module the way the Lattice host does (host.mjs), on
// hand-made writes. Bodies are encoded by the Lattice SDK, whose encoding is
// pinned to Lattice's vectors.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   node --test test/
//
// With CONTEXT_DIR set, every context is recorded with its verdict so
// policy/host-check can replay it through Lattice's own evaluator.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { context, validate } from "./host.mjs";

const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];
const PATH = ["Nexus", "murmur"];

const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function accepts(actions, { signers = [ALICE], accountActions = [] } = {}) {
  const body = sdk.encodeTransactionBody({
    accountActions,
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 0n,
    chainPath: PATH,
  }).bytes;
  const bytes = context(body, { path: PATH });
  const accepted = validate(bytes);
  if (contextDirectory) writeFileSync(`${contextDirectory}/${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`, bytes);
  return accepted;
}

const ID = "lz3k9q2a0x7c1";
const post = (a, id = ID) => `post/${a}/${id}`;
const text = (t) => JSON.stringify({ text: t });
const reply = (author, id, a, rid) => `reply/${author}/${id}/${a}/${rid}`;
/** `a` liking `author`'s post `id`: both keys, each with `change`. */
const like = (a, author, id, change) => [
  { key: `like/${a}/${author}/${id}`, ...change },
  { key: `liked/${author}/${id}/${a}`, ...change },
];

test("an account posts, and deletes its post", () => {
  assert.ok(accepts([{ key: post(ALICE), newValue: text("hello") }]));
  assert.ok(accepts([{ key: post(ALICE), oldValue: text("hello") }]));
  // Many at once, any ids.
  assert.ok(accepts([{ key: post(ALICE, "a"), newValue: text("1") }, { key: post(ALICE, "z".repeat(16)), newValue: text("2") }]));
});

test("a post is never edited, and is never empty", () => {
  assert.ok(!accepts([{ key: post(ALICE), oldValue: text("hello"), newValue: text("goodbye") }]));
  assert.ok(!accepts([{ key: post(ALICE), oldValue: text("hello"), newValue: text("hello") }]));
  assert.ok(!accepts([{ key: post(ALICE), newValue: "" }]));
  assert.ok(!accepts([{ key: post(ALICE) }]));
});

test("a post or card holds at most 4096 bytes", () => {
  assert.ok(accepts([{ key: post(ALICE), newValue: "x".repeat(4096) }]));
  assert.ok(!accepts([{ key: post(ALICE), newValue: "x".repeat(4097) }]));
  // 280 characters of a four-byte script, as JSON, fit.
  assert.ok(accepts([{ key: post(ALICE), newValue: text("𓀀".repeat(280)) }]));
  assert.ok(accepts([{ key: `profile/${ALICE}`, newValue: "x".repeat(4096) }]));
  assert.ok(!accepts([{ key: `profile/${ALICE}`, newValue: "x".repeat(4097) }]));
  assert.ok(!accepts([{ key: `profile/${ALICE}`, newValue: "" }]));
});

test("a card is written, rewritten and deleted by its account", () => {
  const card = JSON.stringify({ name: "Alice", bio: "hi" });
  assert.ok(accepts([{ key: `profile/${ALICE}`, newValue: card }]));
  assert.ok(accepts([{ key: `profile/${ALICE}`, oldValue: card, newValue: JSON.stringify({ name: "Al" }) }]));
  assert.ok(accepts([{ key: `profile/${ALICE}`, oldValue: card }]));
});

test("a reply, repost or quote is a post and an entry under the post it points at", () => {
  for (const kind of ["reply", "repost", "quote"]) {
    const key = `${kind}/${BOB}/${ID}/${ALICE}/r1`;
    assert.ok(accepts([{ key: post(ALICE, "r1"), newValue: text("yes") }, { key, newValue: "1" }]), kind);
    assert.ok(accepts([{ key: post(ALICE, "r1"), oldValue: text("yes") }, { key, oldValue: "1" }]), kind);
    assert.ok(!accepts([{ key, newValue: "2" }]), kind);
    assert.ok(!accepts([{ key, newValue: "" }]), kind);
    assert.ok(!accepts([{ key: `${kind}/${ALICE}/${ID}/${BOB}/r1`, newValue: "1" }]), `${kind} by another`);
  }
});

test("a like is both keys at once, the same value", () => {
  assert.ok(accepts(like(ALICE, BOB, ID, { newValue: "1" })));
  assert.ok(accepts(like(ALICE, BOB, ID, { oldValue: "1" })));
  // One's own post too.
  assert.ok(accepts(like(ALICE, ALICE, ID, { newValue: "1" })));
  const [first, twin] = like(ALICE, BOB, ID, { newValue: "1" });
  assert.ok(!accepts([first]));
  assert.ok(!accepts([twin]));
  assert.ok(!accepts([twin, first]));
  assert.ok(!accepts([first, { ...twin, newValue: undefined, oldValue: "1" }]));
  assert.ok(!accepts(like(ALICE, BOB, ID, { newValue: "2" })));
  // A twin of another post, another author or another account is no twin.
  assert.ok(!accepts([first, like(ALICE, BOB, "other", { newValue: "1" })[1]]));
  assert.ok(!accepts([first, like(ALICE, CAROL, ID, { newValue: "1" })[1]]));
  assert.ok(!accepts([first, like(BOB, BOB, ID, { newValue: "1" })[1]], { signers: [ALICE, BOB] }));
  // Twins of the first key's own kind only.
  assert.ok(!accepts([first, { key: `reply/${BOB}/${ID}/${ALICE}/r1`, newValue: "1" }]));
});

test("nobody writes or deletes another account's keys", () => {
  assert.ok(!accepts([{ key: post(BOB), newValue: text("forged") }]));
  assert.ok(!accepts([{ key: post(BOB), oldValue: text("hers") }]));
  assert.ok(!accepts([{ key: `profile/${BOB}`, newValue: "{}" }]));
  assert.ok(!accepts([{ key: reply(ALICE, ID, BOB, "r1"), newValue: "1" }]));
  assert.ok(!accepts(like(BOB, ALICE, ID, { newValue: "1" })));
  assert.ok(!accepts(like(BOB, ALICE, ID, { oldValue: "1" })));
  // The author of a post can't touch who liked it.
  assert.ok(!accepts([{ key: `liked/${ALICE}/${ID}/${BOB}`, oldValue: "1" }]));
  // Signed by both, each writes their own.
  assert.ok(accepts([{ key: post(ALICE), newValue: text("a") }, { key: post(BOB), newValue: text("b") }], { signers: [ALICE, BOB] }));
});

test("only the records above are records", () => {
  for (const key of [
    `post/${ALICE}`,
    `post/${ALICE}/`,
    `post/${ALICE}/${"a".repeat(17)}`,
    `post/${ALICE}/ABC`,
    `post/${ALICE}/a-b`,
    `post/${ALICE}/${ID}/x`,
    `post/alice/${ID}`,
    `post/${ALICE.toUpperCase()}/${ID}`,
    `profile/${ALICE}/x`,
    `profile/`,
    `reply/${BOB}/${ID}/${ALICE}`,
    `reply/${BOB}/${ID}/${ALICE}/r1/x`,
    `reply/bob/${ID}/${ALICE}/r1`,
    `repost/${ALICE}/${BOB}/${ID}`,
    `reposted/${BOB}/${ID}/${ALICE}`,
    `user/${ALICE}/post/${ID}`,
    `posts/${ALICE}/${ID}`,
    "",
  ]) {
    assert.ok(!accepts([{ key, newValue: "1" }]), key);
  }
  assert.ok(!accepts([{ key: `like/${ALICE}/bob/${ID}`, newValue: "1" }, { key: `liked/bob/${ID}/${ALICE}`, newValue: "1" }]));
  // One bad action rejects the whole write.
  assert.ok(!accepts([{ key: post(ALICE), newValue: text("ok") }, { key: `user/${ALICE}/x`, newValue: "1" }]));
});

test("the work grows with the transaction, no faster", () => {
  const time = (n) => {
    const actions = [];
    for (let i = 0; i < n; i++) actions.push(...like(ALICE, BOB, i.toString(36), { newValue: "1" }));
    const start = performance.now();
    assert.ok(accepts(actions));
    return performance.now() - start;
  };
  time(500);
  // The best of three: other work on the machine only ever adds time.
  const best = (n) => Math.min(time(n), time(n), time(n));
  const [small, large] = [best(2000), best(8000)];
  assert.ok(large < small * 8, `${small.toFixed(1)}ms for 2000, ${large.toFixed(1)}ms for 8000`);
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([], { accountActions: [{ owner: ALICE, delta: -5n }, { owner: BOB, delta: 5n }] }));
  // A sponsor signing and paying beside the author changes nothing.
  assert.ok(accepts([{ key: post(ALICE), newValue: text("free") }], { signers: [ALICE, BOB], accountActions: [{ owner: BOB, delta: -1n }] }));
});

test("a malformed or missing body is rejected", () => {
  assert.ok(!validate(context(undefined, { path: PATH })));
  assert.ok(!validate(context(Uint8Array.of(0xa0, 0x00), { path: PATH })));
  assert.ok(!validate(Uint8Array.of(1, 2, 3)));
});
