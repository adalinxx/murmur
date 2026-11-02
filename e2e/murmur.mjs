// Murmur against a real node, with no coins: a private host mines Nexus, a
// Murmur chain launched from chain/spec.json with the built policy, and a
// Follows chain under Follows' own policy (e2e/follows/), with fast blocks.
// The host takes no fee under 1, as the shared testnet hosts do, so nothing
// is free; a fee sponsor (lattice-sponsor) pays every fee in exchange for
// shares of work this script grinds, as Selfhold's window does in a page.
// Alice, Bob and Carol never hold a coin.
//
// The same sponsor sells storage (--sell-storage): Alice pays for a picture
// with work, it is pinned for good, she posts it, and a reader fetches it
// from the node and finds the same bytes.
//
// Alice sets her card and posts; a zero-fee post of hers is refused. Bob
// follows her on Follows, and his timeline is her posts. Bob replies, likes
// and reposts; Carol quotes. The counts, the thread and the timelines read
// back. Forging Alice's post, editing it, and a like without its twin are
// refused. Then Alice deletes her post and Bob takes back his like and
// repost. Last: Alice, Bob and Carol still hold nothing; the sponsor paid.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   LATTICE=<lattice-node>/.build/debug/lattice node e2e/murmur.mjs
//
// LATTICE_SPONSOR names lattice-sponsor if it isn't beside LATTICE; it must
// sell storage (0xLattice/lattice-sponsor), and LATTICE a node it runs beside.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { createMurmur } from "../src/index.mjs";
import * as m from "../src/records/murmur.mjs";
import { transaction } from "../src/records/wallet.mjs";
import * as follows from "../vendor/follows/src/records/follows.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const MURMUR = ["Nexus", "murmur"];
const FOLLOWS = ["Nexus", "follows"];
const [listen, rpc, publicRead, sponsorPort] = [25061, 29410, 29411, 29412];
const node = `http://127.0.0.1:${publicRead}`;
const sponsorURL = `http://127.0.0.1:${sponsorPort}`;

const root = mkdtempSync(`${tmpdir()}/murmur-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}
/** A chain spec with 2-second blocks and no premine, written next to the node. */
function fast(file, name) {
  const out = `${root}/${name}-spec.json`;
  writeFileSync(out, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), targetBlockTime: 2000, premine: 0 }));
  return out;
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [alice, bob, carol] = [account(), account(), account()];

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function accountState(chain, address) {
  const response = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`, { cache: "no-store" });
  return response.ok ? await response.json() : {};
}
const used = new Map(); // "<chain> <account>" → the nonce after the last one sent
/**
 * The next nonce for `who` on `chain`. A host takes one waiting write per
 * account and no nonce ahead of the chain, so this waits for the last write
 * sent to land first, as a wallet does.
 */
async function nonce(chain, who) {
  const key = `${chain.join("/")} ${who.address}`;
  const want = used.get(key) ?? 0n;
  const next = await until(`${who.address.slice(-6)}'s last write on ${chain.join("/")} to land`, async () => {
    const n = BigInt((await accountState(chain, who.address)).nonce ?? 0);
    return n >= want ? n + 1n : false;
  });
  used.set(key, next);
  return next - 1n;
}
/** Gives back a nonce a refused write didn't use. */
const unuse = (chain, who, n) => used.set(`${chain.join("/")} ${who.address}`, n);
const balance = async (chain, address) => BigInt((await accountState(chain, address)).balance ?? 0);

async function submit(signatures, body) {
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload(signatures, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

/** A `width` × `height` PNG of a soft gradient: a real picture, made here. */
function png(width, height) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const t = x / width, u = y / height;
      rows.set([Math.round(20 + 60 * u), Math.round(120 + 100 * t), Math.round(110 + 90 * (1 - t) * (1 - u))], row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}

/** Grinds a sponsor's work on this machine, as the page does on a device: `hash(work, found, hashed)` for `keep`. */
function hash(work, found, hashed) {
  let stopped = false;
  const done = (async () => {
    let count = 0;
    for (const nonce of shares(work)) {
      if (stopped) return;
      found(nonce);
      // Let the shares go out while the hashing runs on.
      if (++count % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    hashed(Number(work.count));
  })();
  return { done, stop: () => (stopped = true) };
}

// ---------------------------------------------------------------- the fee sponsor, as a wallet uses it

async function ask(path, body) {
  const response = await fetch(`${sponsorURL}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${path}: ${response.status} ${text}`), { status: response.status });
  return JSON.parse(text);
}

/** The nonces in `work`'s range whose SHA-256 over its prefix and the nonce (8 bytes, big-endian) is at or under its share target. */
function* shares(work) {
  const prefix = Buffer.from(work.prefixHex, "hex");
  const target = BigInt(`0x${work.shareTarget}`);
  const input = Buffer.alloc(prefix.length + 8);
  prefix.copy(input);
  for (let n = BigInt(work.startNonce), end = n + BigInt(work.count); n < end; n++) {
    input.writeBigUInt64BE(n, prefix.length);
    if (BigInt(`0x${createHash("sha256").update(input).digest("hex")}`) <= target) yield n;
  }
}

const clients = new Map(); // account → the sponsor's token for it
let sharesGround = 0;
/** `draft` (fee 0, one signer) with the sponsor's fee debit and signature, earned with work first when the credit is short. */
async function sponsored(who, draft) {
  const toWire = (body) => sdk.transactionPayload({}, body).transaction.body;
  const fromWire = (body) => ({ ...body, accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })), nonce: BigInt(body.nonce) });
  const sign = async () => {
    const answer = await ask("sponsor", { client: clients.get(who.address), transaction: { signatures: {}, body: toWire(draft) } });
    const body = fromWire(answer.transaction.body);
    // Only the sponsor's debit and signature added.
    assert.deepEqual(body.signers, [who.address, sponsor.address]);
    assert.deepEqual(body.actions, draft.actions);
    assert.ok(body.accountActions.every((a) => a.owner === sponsor.address && a.delta < 0n));
    return { body, signatures: answer.transaction.signatures };
  };
  for (let round = 0; ; round++) {
    if (clients.has(who.address)) {
      try {
        return await sign();
      } catch (error) {
        if (error.status === 400 && /client token/.test(error.message)) clients.delete(who.address);
        else if (error.status !== 402) throw error;
      }
    }
    if (round > 20) throw new Error("the sponsor took none of this work");
    let work;
    try {
      work = await ask("work", { ...(clients.has(who.address) && { client: clients.get(who.address) }), chain: draft.chainPath.join("/") });
    } catch (error) {
      // A token the sponsor no longer knows: start over with a new one, as Selfhold does.
      if (error.status === 400 && /client token/.test(error.message)) {
        clients.delete(who.address);
        continue;
      }
      if (error.status !== 503) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    clients.set(who.address, work.client);
    let found = 0;
    for (const nonce of shares(work)) {
      try {
        const { credit } = await ask("shares", { assignment: work.assignment, nonce: String(nonce) });
        sharesGround++;
        if (BigInt(credit) >= BigInt(work.fee) || ++found >= Number(work.sharesForFee)) break;
      } catch (error) {
        // Stale work: the chain moved on. Ask again.
        if (error.status === 400 || error.status === 410) break;
        throw error;
      }
    }
  }
}

/** `actions` on `chain` by `who`, its fee paid by the sponsor; the node's answer. */
async function send(chain, who, { actions }) {
  const n = await nonce(chain, who);
  const draft = transaction({ owner: who.address, actions, nonce: n, chainPath: chain });
  let result;
  try {
    const { body, signatures } = await sponsored(who, draft);
    const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
    result = await submit({ ...signatures, [publicKey]: signature }, body);
  } catch (error) {
    unuse(chain, who, n);
    throw error;
  }
  if (!result.ok) unuse(chain, who, n);
  return result;
}

/** `actions` by `who` with no fee and no sponsor, as an app that ignores fees would send them. */
async function sendFree(chain, who, { actions }) {
  const n = await nonce(chain, who);
  const body = transaction({ owner: who.address, actions, nonce: n, chainPath: chain });
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const result = await submit({ [publicKey]: signature }, body);
  if (!result.ok) unuse(chain, who, n);
  return result;
}

async function admitted(label, chain, who, write) {
  const result = await send(chain, who, write);
  assert.ok(result.ok, `${label}: ${result.status} ${result.text}`);
  console.log(`  admitted: ${label}`);
}

/** Refused by the node; with `sponsor`, refused even with its fee paid, so by the policy. */
async function refused(label, who, write, { chain = MURMUR } = {}) {
  let result;
  try {
    result = await send(chain, who, write);
  } catch (error) {
    // The sponsor's own checks may refuse it first; either way nothing lands.
    result = { ok: false, status: error.status, text: error.message };
  }
  assert.ok(!result.ok, `${label} was admitted`);
  console.log(`  refused: ${label} (${result.status} ${String(result.text).trim().slice(0, 120)})`);
}

/** A wallet holding `who`'s key, as Selfhold's window answers the library: it has the fee sponsored, signs and sends. */
const walletOf = (who) => ({
  address: async () => who.address,
  writeRecords: async (request) => {
    assert.equal(request.fee, undefined, "the app leaves the fee to the wallet");
    const result = await send(request.chainPath, who, request);
    if (!result.ok) throw new Error(`${result.status} ${result.text}`);
    return { transactionCID: "sent" };
  },
});

// No handles in this run: Moniker has its own suites.
const noNames = { pointers: async (hs) => hs.map(() => undefined), handlesOf: async (as) => as.map(() => undefined) };

const murmur = createMurmur({ sdk, chain: MURMUR, nodes: [node], freshFor: 0 });
const followsState = createMurmur({ sdk, chain: FOLLOWS, nodes: [node], freshFor: 0 }).state;

/** Starts mining; another suite on this machine may hold the miner a while. */
async function mine() {
  for (let attempt = 0; ; attempt++) {
    try {
      return lattice("mine", "start");
    } catch (error) {
      if (!/already running/i.test(`${error.stderr}${error.stdout}${error.message}`) || attempt >= 10) throw error;
      console.log("  mining is already running elsewhere: waiting a minute");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

/**
 * E2E_KEEP=<port>: a few more posts, then the page served from this
 * repository on <port>, reading this node, until interrupted.
 */
async function keep() {
  await murmur.setCard({ name: "Carol Ruiz", bio: "Birds, bikes and bread. Posting from a phone with no coins." }, { wallet: walletOf(carol) });
  const { id: first } = await murmur.compose({ text: "The first thing I'd want from a social network is that nobody can sell my audience. Here, my followers live on Follows and come with me to every app." }, { wallet: walletOf(carol) });
  await murmur.compose({ text: "Second: no fees. Every post here cost my laptop about a second of work, and I've never held a coin. https://example.com/how" }, { wallet: walletOf(carol) });
  await murmur.like({ author: carol.address, id: first }, { wallet: walletOf(bob) });
  await murmur.compose({ text: "Agreed. And a post can't be quietly edited after people reply to it.", reply: { author: carol.address, id: first } }, { wallet: walletOf(alice) });
  await murmur.repost({ author: carol.address, id: first }, { wallet: walletOf(alice) });
  const pictures = [png(800, 500), png(500, 500)];
  const kept = [];
  for (const [i, picture] of pictures.entries()) {
    const volume = murmur.mediaVolume("image/png", picture);
    await murmur.keep(volume, { sponsor: sponsorURL, hash });
    kept.push({ cid: volume.cid, type: "image/png", alt: ["A wide gradient, green to blue", "A square gradient"][i] });
  }
  await murmur.compose({ text: "Two pictures, kept for good for a few seconds of work each.", media: kept }, { wallet: walletOf(carol) });
  await admitted("Bob follows Carol", FOLLOWS, bob, await follows.follow(await followsState({ fresh: true }), noNames, bob.address, carol.address));
  await until("the extra posts land", async () => (await murmur.everyone()).length >= 8);
  const { createServer } = await import("node:http");
  const port = Number(process.env.E2E_KEEP);
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2", ".json": "application/json" };
  const repo = here("..");
  createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const file = join(repo, url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname);
    if (!file.startsWith(repo)) return response.writeHead(403).end();
    try {
      const body = readFileSync(file);
      response.writeHead(200, { "Content-Type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  }).listen(port, "127.0.0.1");
  const query = `node=${encodeURIComponent(node)}&chain=${MURMUR.join("/")}&follows=${FOLLOWS.join("/")}&sponsor=${encodeURIComponent(sponsorURL)}`;
  writeFileSync(`${root}/upload.png`, png(1200, 800));
  writeFileSync(`${root}/keep.json`, JSON.stringify({ upload: `${root}/upload.png`, app: `http://127.0.0.1:${port}/app/?${query}`, alice: alice.address, bob: bob.address, carol: carol.address, carolPost: first }));
  console.log(`KEEP ${root}/keep.json`);
  console.log(`page: http://127.0.0.1:${port}/app/?${query}`);
  await new Promise(() => {});
}

let sponsor, sponsorChild;
try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    // As the shared testnet hosts: a fee of at least 1, so no write is free.
    topology.minRelayFee = 1;
    topology.publicReadExpensiveRate = 10000;
    topology.publicReadRate = 10000;
    topology.publicReadMaxRate = 100000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", MURMUR.join("/"), "--spec", fast(here("../chain/spec.json"), "murmur"), "--policy-module", here("../chain/murmur_policy.wasm"));
  lattice("child", "create", FOLLOWS.join("/"), "--spec", fast(here("../vendor/follows/chain/spec.json"), "follows"), "--policy-module", here("../vendor/follows/chain/follows_policy.wasm"));

  // The sponsor is paid each chain's block rewards, and so holds coins there to pay fees with.
  const keyFile = `${root}/sponsor-key.json`;
  execFileSync(process.env.LATTICE, ["key", "generate", "--out", keyFile]);
  sponsor = JSON.parse(readFileSync(keyFile, "utf8"));
  const miner = account().address;
  configure((topology) => {
    topology.mine.recipients = { Nexus: miner, [MURMUR.join("/")]: sponsor.address, [FOLLOWS.join("/")]: sponsor.address };
  });
  lattice("up");
  await mine();
  await until("the sponsor's first coins on both chains", async () => (await balance(MURMUR, sponsor.address)) > 10n && (await balance(FOLLOWS, sponsor.address)) > 10n);
  const log = openSync(`${root}/sponsor.log`, "a");
  sponsorChild = spawn(process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor"), [
    "--node", `http://127.0.0.1:${rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", keyFile,
    "--share-work", "2^12", "--fee", "1", "--port", String(sponsorPort),
    "--sell-storage", "--storage-rate", `${MURMUR.join("/")}=1000000`, "--storage-file", `${root}/sponsor-storage.json`,
  ], { stdio: ["ignore", log, log] });
  await until("the sponsor prices both chains", async () => {
    for (const chain of [MURMUR, FOLLOWS]) await ask("work", { chain: chain.join("/") });
    return true;
  }, 120);
  console.log(`Murmur and Follows launched; the sponsor (${sponsor.address.slice(-6)}) pays fees for work`);

  // ------------------------------------------------------------ posting with no coins
  const free = await sendFree(MURMUR, alice, m.compose(alice.address, { text: "free?" }));
  assert.ok(!free.ok, "a zero-fee write was admitted: this run proves nothing about sponsors");
  console.log(`  refused: a zero-fee post, unsponsored (${free.status})`);

  await murmur.setCard({ name: "Alice", bio: "first on murmur" }, { wallet: walletOf(alice) });
  console.log("  admitted: Alice sets her card through the library");
  const { id: hello } = await murmur.compose({ text: "hello, murmur" }, { wallet: walletOf(alice) });
  console.log("  admitted: Alice posts through the library");
  await until("Alice's post is mined", async () => (await murmur.post({ author: alice.address, id: hello }))?.text === "hello, murmur");
  assert.deepEqual(await murmur.card(alice.address), { name: "Alice", bio: "first on murmur" });
  const post = { author: alice.address, id: hello };

  // ------------------------------------------------------------ a picture, kept for good with work
  const terms = await (await fetch(`${sponsorURL}/terms`)).json();
  assert.ok(Number(terms.storageRates?.[MURMUR.join("/")]) > 0, `the sponsor keeps no files for Murmur: ${JSON.stringify(terms)}`);
  const picture = png(480, 320);
  const volume = murmur.mediaVolume("image/png", picture);
  const stages = new Set();
  await murmur.keep(volume, { sponsor: sponsorURL, hash, progress: ({ stage }) => stages.add(stage) });
  assert.ok((await (await fetch(`${sponsorURL}/store/${volume.cid}`)).json()).stored, "the sponsor says it hasn't kept it");
  console.log(`  kept: a ${picture.length}-byte picture, paid with work (${[...stages].join(", ")})`);
  const { id: shown } = await murmur.compose({ text: "a picture, kept for work", media: [{ cid: volume.cid, type: "image/png", alt: "A green and blue gradient" }] }, { wallet: walletOf(alice) });
  await until("the picture post is mined", async () => (await murmur.post({ author: alice.address, id: shown }))?.media);
  // A reader with nothing cached reads it from the node, checked against its CID.
  const reader = createMurmur({ sdk, chain: MURMUR, nodes: [node], freshFor: 0 });
  const [entry] = (await reader.post({ author: alice.address, id: shown })).media;
  assert.deepEqual(entry, { cid: volume.cid, type: "image/png", alt: "A green and blue gradient" });
  const file = await reader.media(entry.cid);
  assert.equal(file.type, "image/png");
  assert.deepEqual(file.bytes, picture);
  console.log("a reader fetched the picture from the node, the same bytes");

  // ------------------------------------------------------------ a timeline from Follows
  await admitted("Bob follows Alice on Follows", FOLLOWS, bob, await follows.follow(await followsState({ fresh: true }), noNames, bob.address, alice.address));
  const followed = async () => (await follows.following(await followsState({ fresh: true }), noNames, bob.address)).map((p) => p.account);
  await until("the follow is mined", async () => (await followed()).includes(alice.address));
  assert.deepEqual((await murmur.feed(await followed())).map((p) => p.text), ["a picture, kept for work", "hello, murmur"]);
  console.log("Bob's timeline is the posts of whom he follows on Follows");

  // ------------------------------------------------------------ replies, likes, reposts, quotes
  const { id: answer } = await murmur.compose({ text: "hi Alice", reply: post }, { wallet: walletOf(bob) });
  await murmur.like(post, { wallet: walletOf(bob) });
  await murmur.like(post, { wallet: walletOf(carol) });
  await until("the reply and likes are mined", async () => (await murmur.stats(post)).likes === 2 && (await murmur.stats(post)).replies === 1);
  await murmur.repost(post, { wallet: walletOf(bob) });
  const { id: quoted } = await murmur.compose({ text: "worth reading", quote: post }, { wallet: walletOf(carol) });
  await until("the repost and quote are mined", async () => (await murmur.stats(post)).reposts === 1 && (await murmur.stats(post)).quotes === 1);
  console.log("  admitted: a reply, two likes, a repost and a quote");
  assert.deepEqual(await murmur.stats(post, bob.address), { replies: 1, reposts: 1, quotes: 1, likes: 2, liked: true, reposted: true });
  const thread = await murmur.thread({ author: bob.address, id: answer });
  assert.deepEqual(thread.above.map((p) => p.text), ["hello, murmur"]);
  assert.deepEqual((await murmur.thread(post)).replies.map((p) => p.text), ["hi Alice"]);
  const everyone = await murmur.everyone();
  assert.equal(everyone.length, 5);
  assert.deepEqual(everyone.find((p) => p.repost)?.repost, post);
  assert.deepEqual((await murmur.post({ author: carol.address, id: quoted })).quote, post);
  console.log("counts, the thread and every post read back");

  // ------------------------------------------------------------ what the policy refuses, fee paid or not
  const state = await murmur.state({ fresh: true });
  const aliceValue = await state.get(m.postKey(alice.address, hello));
  await refused("Bob writing a post as Alice", bob, { actions: [{ key: m.postKey(alice.address, "forged"), newValue: JSON.stringify({ text: "forged" }) }] });
  await refused("Alice editing her post", alice, { actions: [{ key: m.postKey(alice.address, hello), oldValue: aliceValue, newValue: JSON.stringify({ text: "edited" }) }] });
  await refused("Bob deleting Alice's post", bob, { actions: [{ key: m.postKey(alice.address, hello), oldValue: aliceValue }] });
  await refused("a like without its twin", carol, { actions: [{ key: m.likeKey(carol.address, { author: bob.address, id: answer }), newValue: "1" }] });
  await refused("a post over 4096 bytes", carol, { actions: [{ key: m.postKey(carol.address, "big"), newValue: "x".repeat(4097) }] });

  // ------------------------------------------------------------ taking things back
  await murmur.unlike(post, { wallet: walletOf(bob) });
  await murmur.unrepost(post, { wallet: walletOf(bob) });
  await murmur.remove(hello, { wallet: walletOf(alice) });
  await until("the takebacks are mined", async () => (await murmur.post(post)) === undefined && (await murmur.postsBy(bob.address)).length === 1);
  assert.deepEqual(await murmur.stats(post, bob.address), { replies: 1, reposts: 0, quotes: 1, likes: 1, liked: false, reposted: false });
  assert.deepEqual((await murmur.thread({ author: bob.address, id: answer })).above, [{ ...post, missing: true }]);
  console.log("  admitted: an unlike, an unrepost and a deletion; the reply shows its post is gone");

  // ------------------------------------------------------------ nobody paid but the sponsor
  for (const [name, who] of [["Alice", alice], ["Bob", bob], ["Carol", carol]]) {
    for (const chain of [MURMUR, FOLLOWS]) assert.equal(await balance(chain, who.address), 0n, `${name} holds coins on ${chain.join("/")}`);
  }
  console.log(`Alice, Bob and Carol hold no coins; the sponsor paid every fee, for ${sharesGround} shares of work`);
  console.log("e2e passed");
  if (process.env.E2E_KEEP) await keep();
} finally {
  sponsorChild?.kill();
  try {
    lattice("mine", "stop");
  } catch {}
  try {
    lattice("down");
  } catch {}
}
