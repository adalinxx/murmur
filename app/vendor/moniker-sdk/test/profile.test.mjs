// Profile cards and photos on Moniker, every write checked by the built Moniker policy (see harness.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { monikerClient } from "../src/client.mjs";
import { byline } from "../src/element.mjs";
import { shortAccount } from "../src/records/account.mjs";
import { MAX_PHOTO_BYTES, photoVolume, readPhoto } from "../src/photo.mjs";
import * as profiles from "../src/records/profile.mjs";
import { address, sdk, world } from "./harness.mjs";

const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];
const PHOTO = address(9); // any CID of a DAG-CBOR block's shape
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3);
const card = (value) => profiles.readCard(JSON.stringify(value));

test("a card is read as untrusted: what doesn't parse is left out, never fatal", () => {
  for (const bad of [undefined, "", "not json", "[]", "null", "7", '"text"', JSON.stringify({ name: 7, avatar: "x", url: "ftp://a", links: "no" })]) {
    assert.equal(profiles.readCard(bad), undefined, String(bad));
  }
  assert.deepEqual(
    card({ name: "  Dana  Okafor ", description: " Birds. ", avatar: PHOTO, url: "https://dana.example/", links: [{ label: "Blog", url: "http://blog.example" }], extra: 1 }),
    { name: "Dana Okafor", description: "Birds.", avatar: PHOTO, url: "https://dana.example/", links: [{ label: "Blog", url: "http://blog.example" }] },
  );
});

test("a card's name never poses as a handle: every @ and invisible control is dropped", () => {
  assert.deepEqual(card({ name: "@alice" }), { name: "alice" });
  assert.deepEqual(card({ name: "Al‮ice​ ＠x" }), { name: "Alice x" });
  assert.equal(card({ name: "@​@" }), undefined);
});

test("only web links show, with a label; an old card's handle is ignored", () => {
  const links = [
    { label: "Site", url: "https://a.example" },
    { label: "Script", url: "javascript:alert(1)" },
    { label: "", url: "https://b.example" },
    { url: "https://c.example" },
    { label: "Data", url: "data:text/html,hi" },
    "https://d.example",
    null,
    { label: "Mail", url: "mailto:a@b.example" },
  ];
  assert.deepEqual(card({ links, handle: "alice" }), { links: [{ label: "Site", url: "https://a.example" }] });
  assert.equal(card({ url: "javascript:alert(1)" }), undefined);
  assert.equal(card({ handle: "alice" }), undefined);
  // At most MAX_LINKS, each label clipped.
  const many = Array.from({ length: 12 }, (_, i) => ({ label: "x".repeat(60), url: `https://${i}.example` }));
  const read = card({ links: many }).links;
  assert.equal(read.length, profiles.MAX_LINKS);
  assert.equal(read[0].label.length, profiles.MAX_LABEL);
});

test("an avatar is a file's root CID: anything else is left out", () => {
  for (const avatar of ["", "bafy", PHOTO.toUpperCase(), `${PHOTO}x`, "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", 7]) {
    assert.equal(card({ avatar }), undefined, String(avatar));
  }
  assert.deepEqual(card({ avatar: PHOTO }), { avatar: PHOTO });
});

test("a long bio is clipped when read, by character", () => {
  const read = card({ description: "é".repeat(400) + "😀" });
  assert.equal([...read.description].length, profiles.MAX_DESCRIPTION);
});

test("setProfile writes the card, naming the old value it read; the policy takes it", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  const key = profiles.profileKey(ALICE);
  const first = await profiles.setProfile(w.names.state, ALICE, { name: "Alice", description: "Hi", links: [{ label: "Site", url: "https://alice.example" }] });
  assert.deepEqual(first, { actions: [{ key, newValue: JSON.stringify({ name: "Alice", description: "Hi", links: [{ label: "Site", url: "https://alice.example" }] }) }], payments: [] });
  assert.ok(w.names.submit(ALICE, first));
  const read = w.names.map.get(key);
  // Each field named is set or removed; the rest are kept.
  const second = await profiles.setProfile(w.names.state, ALICE, { description: "", avatar: PHOTO });
  assert.deepEqual(second.actions, [{ key, oldValue: read, newValue: JSON.stringify({ name: "Alice", links: [{ label: "Site", url: "https://alice.example" }], avatar: PHOTO }) }]);
  // Built on a card since changed: consensus refuses it.
  const stale = await profiles.setProfile(w.names.state, ALICE, { name: "Al" });
  assert.ok(w.names.submit(ALICE, second));
  assert.ok(!w.names.submit(ALICE, stale));
  assert.deepEqual(await w.moniker.profile(ALICE), { name: "Alice", avatar: PHOTO, links: [{ label: "Site", url: "https://alice.example" }] });
  // Nothing to write when nothing changes; an empty card is deleted.
  assert.deepEqual((await profiles.setProfile(w.names.state, ALICE, { name: "Alice" })).actions, []);
  const cleared = await profiles.clearProfile(w.names.state, ALICE);
  assert.deepEqual(cleared.actions, [{ key, oldValue: w.names.map.get(key) }]);
  assert.ok(w.names.submit(ALICE, cleared));
  assert.equal(await w.moniker.profile(ALICE), undefined);
  assert.deepEqual((await profiles.clearProfile(w.names.state, ALICE)).actions, []);
});

test("nobody writes another account's card", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  assert.ok(!w.names.submit(BOB, await profiles.setProfile(w.names.state, ALICE, { name: "Not Alice" })));
  await w.moniker.setProfile({ name: "Alice" }, { wallet: w.wallet(ALICE) });
  assert.ok(!w.names.submit(BOB, await profiles.clearProfile(w.names.state, ALICE)));
  assert.deepEqual(await w.moniker.profile(ALICE), { name: "Alice" });
});

test("an old card's other fields are kept, its handle dropped", async () => {
  const w = world({ [ALICE]: 100 });
  w.names.map.set(profiles.profileKey(ALICE), JSON.stringify({ name: "Old", handle: "alice", header: PHOTO }));
  await w.moniker.setProfile({ name: "New" }, { wallet: w.wallet(ALICE) });
  assert.deepEqual(JSON.parse(w.names.map.get(profiles.profileKey(ALICE))), { name: "New", header: PHOTO });
});

test("a card that doesn't fit is refused before anything is sent", async () => {
  const w = world({ [ALICE]: 100 });
  const refused = (fields, reason) => assert.rejects(profiles.setProfile(w.names.state, ALICE, fields), reason);
  await refused({ name: "x".repeat(profiles.MAX_NAME + 1) }, /name: at most/);
  await refused({ description: "x".repeat(profiles.MAX_DESCRIPTION + 1) }, /description: at most/);
  await refused({ url: "javascript:alert(1)" }, /not an http/);
  await refused({ links: [{ label: "x", url: "file:///etc/passwd" }] }, /not an http/);
  await refused({ links: [{ label: " ", url: "https://a.example" }] }, /needs a label/);
  await refused({ links: Array.from({ length: profiles.MAX_LINKS + 1 }, () => ({ label: "x", url: "https://a.example" })) }, /at most/);
  await refused({ avatar: "bafy" }, /not a photo's CID/);
  await refused({ handle: "alice" }, /not a card field/);
  // The policy's 16 KiB: refused here first.
  await refused({ links: Array.from({ length: 8 }, (_, i) => ({ label: "x", url: `https://a.example/${i}${"a".repeat(2100)}` })) }, /too long/);
  // A name is stored as it shows.
  assert.equal(JSON.parse((await profiles.setProfile(w.names.state, ALICE, { name: "@ana" })).actions[0].newValue).name, "ana");
});

test("profilesOf reads each account's card, in order, from one state", async () => {
  const w = world({ [ALICE]: 100, [CAROL]: 100 });
  await w.moniker.setProfile({ name: "Alice" }, { wallet: w.wallet(ALICE) });
  await w.moniker.setProfile({ name: "Carol", url: "https://carol.example" }, { wallet: w.wallet(CAROL) });
  assert.deepEqual(await w.moniker.profiles([CAROL, BOB, ALICE]), [{ name: "Carol", url: "https://carol.example" }, undefined, { name: "Alice" }]);
  const read = [];
  const spy = { get: async (key) => (read.push(key), w.names.state.get(key)), list: () => assert.fail("no listing") };
  await profiles.profilesOf(spy, [ALICE, CAROL]);
  assert.deepEqual(read, [profiles.profileKey(ALICE), profiles.profileKey(CAROL)]);
});

// ---------------------------------------------------------------- photos

const block = (value) => sdk.encodeDagCbor(value);

test("a photo is one block, { type, size, bytes }, and reads back by its CID", () => {
  const volume = photoVolume(sdk, "image/png", PNG);
  const bytes = Uint8Array.from(atob(volume.entries[volume.cid]), (c) => c.charCodeAt(0));
  assert.equal(sdk.cidV1DagCbor(bytes), volume.cid);
  assert.ok(profiles.isPhotoCID(volume.cid));
  assert.deepEqual(readPhoto(sdk, bytes), { type: "image/png", bytes: PNG });
  // Murmur's pictures, { type, bytes }, read too.
  assert.deepEqual(readPhoto(sdk, block({ type: "image/png", bytes: PNG })), { type: "image/png", bytes: PNG });
});

test("only a small raster photo, the type it says, is read; never SVG", () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
  big.set(PNG);
  const webp = Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0))));
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0);
  for (const [why, value] of [
    ["svg", { type: "image/svg+xml", size: BigInt(svg.length), bytes: svg }],
    ["svg bytes called png", { type: "image/png", size: BigInt(svg.length), bytes: svg }],
    ["gif", { type: "image/gif", size: 6n, bytes: new TextEncoder().encode("GIF89a") }],
    ["oversize", { type: "image/png", size: BigInt(big.length), bytes: big }],
    ["wrong size", { type: "image/png", size: 3n, bytes: PNG }],
    ["extra field", { type: "image/png", size: BigInt(PNG.length), bytes: PNG, more: 1 }],
    ["chunked", { type: "image/png", size: 5n, chunks: [PHOTO] }],
    ["no bytes", { type: "image/png" }],
  ]) {
    assert.equal(readPhoto(sdk, block(value)), undefined, why);
  }
  assert.equal(readPhoto(sdk, Uint8Array.of(0xff)), undefined, "not CBOR");
  assert.deepEqual(readPhoto(sdk, block({ type: "image/webp", bytes: webp })), { type: "image/webp", bytes: webp });
  assert.deepEqual(readPhoto(sdk, block({ type: "image/jpeg", size: 5n, bytes: jpeg })), { type: "image/jpeg", bytes: jpeg });
  assert.throws(() => photoVolume(sdk, "image/svg+xml", svg), /WebP, PNG or JPEG/);
  assert.throws(() => photoVolume(sdk, "image/png", svg), /isn't a PNG/);
  assert.throws(() => photoVolume(sdk, "image/png", big), /at most/);
});

/** A client over a link whose hosts serve `served` (cid → block), counting reads. */
function photoClient(served, options = {}) {
  const reads = [];
  const link = {
    chain: ["Nexus", "moniker"],
    state: async () => ({ get: async () => undefined }),
    volume: async (cid) => {
      reads.push(cid);
      if (!served.has(cid)) throw new Error("not served");
      return { bytes: (c) => (c === cid ? served.get(cid) : undefined) };
    },
  };
  return { reads, moniker: monikerClient(link, { app: "https://moniker.test/", sdk, ...options }) };
}

test("a photo is read once by CID, checked, as an object URL; anything else is none", async () => {
  const volume = photoVolume(sdk, "image/png", PNG);
  const svgCID = sdk.cidV1DagCbor(block({ type: "image/svg+xml", bytes: PNG }));
  const served = new Map([
    [volume.cid, Uint8Array.from(atob(volume.entries[volume.cid]), (c) => c.charCodeAt(0))],
    [svgCID, block({ type: "image/svg+xml", bytes: PNG })],
  ]);
  const { reads, moniker } = photoClient(served);
  assert.deepEqual(await moniker.photo(volume.cid), { type: "image/png", bytes: PNG });
  const url = await moniker.photoURL(volume.cid);
  assert.match(url, /^blob:/);
  assert.equal(await moniker.photoURL(volume.cid), url);
  assert.equal(await moniker.photoURL(svgCID), undefined);
  assert.equal(await moniker.photoURL(address(8)), undefined, "not served");
  assert.equal(await moniker.photo("javascript:alert(1)"), undefined);
  assert.deepEqual(reads, [volume.cid, volume.cid, svgCID, address(8)]);
});

test("setPhoto keeps the photo through the storage sponsor, then puts it on the card", async (t) => {
  const w = world({ [ALICE]: 100 });
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const { pathname } = new URL(url);
    asked.push(`${init.method ?? "GET"} ${pathname}`);
    const json = (body) => new Response(JSON.stringify(body));
    if (pathname === "/sponsor/terms") return json({ storageRates: { "Nexus/elsewhere": "5", "Nexus/testnet/moniker": "10" } });
    if (pathname === "/sponsor/store") {
      const { root, volumes } = JSON.parse(init.body);
      assert.equal(volumes[0].cid, root);
      return json({ root, bytes: "100", needed: "0", credit: "100", stored: false });
    }
    if (pathname.startsWith("/sponsor/store/")) return json({ root: pathname.slice(15), bytes: "100", needed: "0", credit: "100", stored: true });
    throw new Error(`unexpected ${pathname}`);
  });
  const moniker = monikerClient({ ...w.names.link, volume: async () => assert.fail("kept photos aren't read back") }, {
    app: "https://moniker.test/", sdk, sponsor: "https://sponsor.test/sponsor", hash: () => assert.fail("already paid"),
  });
  await assert.rejects(moniker.setPhoto({ type: "image/png", bytes: PNG }, {}), /Lattice Wallet/);
  const stages = [];
  await moniker.setPhoto({ type: "image/png", bytes: PNG }, { wallet: w.wallet(ALICE), progress: ({ stage }) => stages.push(stage) });
  const { cid } = photoVolume(sdk, "image/png", PNG);
  assert.deepEqual(await moniker.profile(ALICE), { avatar: cid });
  assert.deepEqual(stages, ["prepare", "upload", "pin", "card"]);
  assert.deepEqual(asked, ["GET /sponsor/terms", "POST /sponsor/store", `GET /sponsor/store/${cid}`]);
  assert.match(await moniker.photoURL(cid), /^blob:/);
  await moniker.clearPhoto({ wallet: w.wallet(ALICE) });
  assert.equal(await moniker.profile(ALICE), undefined);
  // No hasher, no sponsor: said before anything is asked.
  await assert.rejects(monikerClient(w.names.link, { sdk, sponsor: "https://sponsor.test/" }).keepPhoto({ type: "image/png", bytes: PNG }), /needs \{ hash \}/);
});

// ---------------------------------------------------------------- the byline

test("a byline shows the app's name first, else the card's, never as a handle", () => {
  const profile = { name: "@Card Name", avatar: PHOTO };
  assert.deepEqual(byline({ address: ALICE, name: "App Name", handle: "alice", profile }), { text: "App Name", handle: "@alice", avatar: PHOTO });
  assert.deepEqual(byline({ address: ALICE, handle: "alice", profile }), { text: "Card Name", handle: "@alice", avatar: PHOTO });
  assert.deepEqual(byline({ address: ALICE, name: "@​", handle: "alice", profile: { name: "@" } }), { text: "@alice" });
  // A card's name with no verified handle carries the account's short ID: anyone may copy a name and photo.
  assert.deepEqual(byline({ address: ALICE, profile: { name: "Card", avatar: PHOTO } }), { text: "Card", handle: shortAccount(ALICE), avatar: PHOTO });
  assert.deepEqual(byline({ address: ALICE, name: "App Name", profile: { name: "Card" } }), { text: "App Name" });
  assert.deepEqual(byline({ address: ALICE }), { text: shortAccount(ALICE) });
});
