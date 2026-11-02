// Names on Moniker, every write checked by the built Moniker policy (see harness.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as names from "../src/records/names.mjs";
import { ACCOUNT, change, combine, unchanged, write } from "../src/records/shared.mjs";
import { address, world } from "./harness.mjs";

const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];

test("a name is claimed, pointed at its owner or at anyone, and read with its pointer", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  const wallet = w.wallet(ALICE);
  await w.moniker.claim("@alice", { point: true }, { wallet });
  assert.deepEqual(await w.moniker.name("@alice"), { handle: "alice", value: ALICE, owner: ALICE, pointer: ALICE });
  assert.equal(await w.moniker.pointer("alice"), ALICE);
  assert.deepEqual((await w.moniker.names(ALICE)).map((n) => n.handle), ["alice"]);
  // Pointed at another account, then nowhere; nothing to write when nothing changes.
  await w.moniker.point("alice", BOB, { wallet });
  assert.equal(await w.moniker.pointer("alice"), BOB);
  assert.equal(await w.moniker.point("alice", BOB, { wallet }), undefined);
  await w.moniker.point("alice", null, { wallet });
  assert.equal(await w.moniker.pointer("alice"), undefined);
  await assert.rejects(w.moniker.point("alice", "nobody", { wallet }), /not an address/);
  // Only the owner points it: refused here, and by the policy when written by hand.
  await assert.rejects(w.moniker.point("alice", BOB, { wallet: w.wallet(BOB) }), /isn't yours/);
  const forged = [unchanged("name/alice", ALICE), change(names.pointsKey("alice"), undefined, BOB)];
  assert.ok(!w.names.submit(BOB, { actions: forged }));
  assert.ok(!w.names.submit(ALICE, { actions: forged.slice(1) }), "a pointer needs its name first");
  await assert.rejects(w.moniker.claim("alice", {}, { wallet: w.wallet(BOB) }), /taken/);
  await assert.rejects(w.moniker.claim("Alice", {}, { wallet }), /lowercase/);
});

test("a bought name's pointer is cleared, unless the buyer sets one in the same write", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  await w.moniker.claim("mira", { price: 500n, point: true }, { wallet: w.wallet(ALICE) });
  assert.deepEqual((await w.moniker.forSale()).map(({ handle, price }) => [handle, price]), [["mira", 500n]]);
  await w.moniker.buy("@mira", {}, { wallet: w.wallet(BOB) });
  assert.equal(w.names.coins.get(BOB), 1000n - 500n - 1n);
  assert.equal(w.names.coins.get(ALICE), 100n - 1n + 500n);
  assert.deepEqual(await w.moniker.name("mira"), { handle: "mira", value: BOB, owner: BOB });
  assert.deepEqual(await w.moniker.names(ALICE), []);
  // Sold back, pointed at the buyer in the same write.
  await w.moniker.point("mira", CAROL, { wallet: w.wallet(BOB) });
  await w.moniker.sell("mira", 1n, { wallet: w.wallet(BOB) });
  await w.moniker.buy("mira", { point: true }, { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.pointer("mira"), ALICE);
});

test("owners reads each name's owner from name/ alone, in order", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await w.moniker.claim("ann", { price: 5n }, { wallet: w.wallet(ALICE) });
  await w.moniker.claim("ben", {}, { wallet: w.wallet(BOB) });
  await w.moniker.offer("ben", ALICE, { wallet: w.wallet(BOB) });
  assert.deepEqual(await w.moniker.owners(["@ben", "ann", "free", "Not-A-Handle"]), [BOB, ALICE, undefined, undefined]);
  const read = [];
  const spy = { get: async (key) => (read.push(key), w.names.state.get(key)), list: () => assert.fail("no listing") };
  assert.deepEqual(await names.ownersOf(spy, ["ann", "ben"]), [ALICE, BOB]);
  assert.deepEqual(read, ["name/ann", "name/ben"]);
});

test("a stale price or a name not for sale is refused, and the buyer pays nothing", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  await w.moniker.claim("rare", { price: 300n }, { wallet: w.wallet(ALICE) });
  const seen = await names.buy(w.names.state, BOB, "rare");
  await w.moniker.sell("rare", 900n, { wallet: w.wallet(ALICE) });
  const before = w.names.coins.get(BOB);
  assert.ok(!w.names.submit(BOB, seen));
  assert.equal(w.names.coins.get(BOB), before);
  await w.moniker.unlist("rare", { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.buy("rare", {}, { wallet: w.wallet(BOB) }), /not for sale/);
});

test("a name offered to an account is taken by it for nothing, and by no one else", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100, [CAROL]: 100 });
  await w.moniker.claim("gift", {}, { wallet: w.wallet(ALICE) });
  await w.moniker.offer("gift", BOB, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.buy("gift", {}, { wallet: w.wallet(CAROL) }), /not for sale/);
  await w.moniker.buy("gift", { point: true }, { wallet: w.wallet(BOB) });
  assert.deepEqual([(await w.moniker.name("gift")).owner, await w.moniker.pointer("gift")], [BOB, BOB]);
  await assert.rejects(w.moniker.offer("gift", BOB, { wallet: w.wallet(BOB) }), /someone else/);
  await assert.rejects(w.moniker.offer("gift", "nobody", { wallet: w.wallet(BOB) }), /not an address/);
});

test("a released name goes with its pointer, and is free again", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await w.moniker.claim("gone", { point: true }, { wallet: w.wallet(ALICE) });
  await w.moniker.showName("gone", { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.release("gone", { wallet: w.wallet(BOB) }), /isn't yours/);
  await w.moniker.release("gone", { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.name("gone"), undefined);
  assert.equal(w.names.map.get(names.pointsKey("gone")), undefined);
  assert.equal(await w.moniker.handleOf(ALICE), undefined, "a released name shows nowhere");
  // After a release, only its pointer may follow, and only as a deletion.
  await w.moniker.claim("gone", {}, { wallet: w.wallet(BOB) });
  const releaseAndPoint = [change("name/gone", BOB, undefined), change(names.namesKey(BOB, "gone"), "1", undefined), change(names.pointsKey("gone"), undefined, BOB)];
  assert.ok(!w.names.submit(BOB, { actions: releaseAndPoint }));
});

test("a claim replaces a pointer a hand-built release left behind, or clears it", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await w.moniker.claim("left", { show: true }, { wallet: w.wallet(ALICE) });
  // Released by hand, keeping the pointer: the policy allows it, but a free name shows for nobody.
  assert.ok(w.names.submit(ALICE, { actions: [change("name/left", ALICE, undefined), change(names.namesKey(ALICE, "left"), "1", undefined)] }));
  assert.equal(await w.moniker.pointer("left"), ALICE);
  assert.equal(await w.moniker.handleOf(ALICE), undefined);
  // The claimer's own pointer replaces it; a claim leaving it there is refused.
  await w.moniker.claim("left", {}, { wallet: w.wallet(BOB) });
  assert.equal(await w.moniker.pointer("left"), BOB);
  assert.equal(await w.moniker.handleOf(ALICE), undefined);
  assert.ok(w.names.submit(BOB, { actions: [change("name/left", BOB, undefined), change(names.namesKey(BOB, "left"), "1", undefined)] }));
  assert.ok(!w.names.submit(ALICE, { actions: [change("name/left", undefined, ALICE), change(names.namesKey(ALICE, "left"), undefined, "1")] }));
  // Or cleared.
  await w.moniker.claim("left", { point: null }, { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.pointer("left"), undefined);
  assert.ok(w.names.submit(ALICE, { actions: [change("name/left", ALICE, undefined), change(names.namesKey(ALICE, "left"), "1", undefined)] }));
  // Left behind again, and replaced by the claimer's own pointer.
  await w.moniker.claim("left", { point: ALICE }, { wallet: w.wallet(BOB) });
  assert.ok(w.names.submit(BOB, { actions: [change("name/left", BOB, undefined), change(names.namesKey(BOB, "left"), "1", undefined)] }));
  await w.moniker.claim("left", { point: true }, { wallet: w.wallet(BOB) });
  assert.equal(await w.moniker.pointer("left"), BOB);
});

test("an account shows a handle only while it names it and the handle points at it", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  // Alice's name, pointed elsewhere: showName points it at her and names it, in one transaction.
  await w.moniker.claim("alice", { point: BOB }, { wallet: w.wallet(ALICE) });
  const shown = await names.showName(w.names.state, ALICE, "alice");
  assert.deepEqual(shown.actions.map((a) => a.key), ["name/alice", "points/alice", names.shownKey(ALICE)]);
  await w.moniker.showName("@alice", { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.handleOf(ALICE), "alice");
  assert.equal(await w.moniker.handleOf(BOB), undefined);
  // Pointed away again, she no longer shows it, though she still names it.
  await w.moniker.point("alice", BOB, { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.field(ALICE, "name"), "alice");
  assert.equal(await w.moniker.handleOf(ALICE), undefined);
  // Pointed at Bob, it shows for Bob only once he names it.
  assert.equal(await w.moniker.handleOf(BOB), undefined, "a name pointed at you doesn't show until you name it");
  await w.moniker.showName("alice", { wallet: w.wallet(BOB) }); // not his, but it points at him
  assert.equal(await w.moniker.handleOf(BOB), "alice");
  assert.deepEqual(await w.moniker.handlesOf([ALICE, BOB, address(9)]), [undefined, "alice", undefined]);
  // A name that is neither yours nor pointed at you can't be shown; nor can a free one.
  await w.moniker.claim("carol", {}, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.showName("carol", { wallet: w.wallet(BOB) }), /doesn't point at you/);
  await assert.rejects(w.moniker.showName("nobody", { wallet: w.wallet(BOB) }), /No one owns/);
  // Only the account writes what it names.
  assert.ok(!w.names.submit(ALICE, await names.setField(w.names.state, BOB, "name", "carol")));
  await w.moniker.stopShowing({ wallet: w.wallet(BOB) });
  assert.equal(await w.moniker.handleOf(BOB), undefined);
  assert.equal(await w.moniker.stopShowing({ wallet: w.wallet(BOB) }), undefined, "nothing to write");
});

test("claim and buy with show point the name at the signer and show it, in one transaction", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  const claimed = await names.claim(w.names.state, ALICE, "ann", { price: 5n, show: true });
  assert.deepEqual(claimed.actions.map((a) => a.key), ["name/ann", names.namesKey(ALICE, "ann"), "points/ann", names.shownKey(ALICE)]);
  await w.moniker.claim("@ann", { price: 5n, show: true }, { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.handleOf(ALICE), "ann");
  await assert.rejects(w.moniker.claim("other", { point: BOB, show: true }, { wallet: w.wallet(ALICE) }), /points at you/);
  await w.moniker.claim("own", { point: ALICE, show: true }, { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.handleOf(ALICE), "own");
  // Bob buys @ann and shows it at once; Alice stops showing it with the sale.
  await w.moniker.sell("ann", 5n, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.buy("ann", { point: ALICE, show: true }, { wallet: w.wallet(BOB) }), /points at you/);
  await w.moniker.buy("ann", { show: true }, { wallet: w.wallet(BOB) });
  assert.deepEqual(await w.moniker.handlesOf([ALICE, BOB]), ["own", "ann"]);
  await w.moniker.release("own", { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.handleOf(ALICE), undefined);
});

test("labels: a card name never passes for a handle; the verified handle sits beside it", async () => {
  const w = world({ [ALICE]: 100 });
  await w.moniker.claim("dana", { point: true }, { wallet: w.wallet(ALICE) });
  await w.moniker.showName("dana", { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.label(ALICE, { name: "Dana Okafor" }), "Dana Okafor @dana");
  assert.equal(await w.moniker.label(ALICE), "@dana");
  assert.equal(await w.moniker.label(BOB, { name: "@dana" }), "dana");
  assert.equal(await w.moniker.label(BOB, { name: "@@" }), `${BOB.slice(7, 11)}…${BOB.slice(-6)}`);
  assert.equal(names.label(BOB), `${BOB.slice(7, 11)}…${BOB.slice(-6)}`);
  assert.equal(names.displayName("@@x"), "x");
  assert.equal(await w.moniker.label(BOB, { name: "Dana Okafor @dana" }), "Dana Okafor dana");
  assert.equal(names.displayName("Dana\u202E @dana\u200B \uFF20x \uFE6By\u2066z\u2069\u061C\uFEFF\t end"), "Dana dana x yz end");
  assert.equal(names.displayName("\u200F@\u200E "), undefined);
  assert.equal(names.label(BOB, { name: "@\u202Edana", handle: "dana" }), "dana @dana");
});

test("prices fit a credit; a price of 0 owes nothing", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await assert.rejects(w.moniker.claim("big", { price: 2n ** 63n }, { wallet: w.wallet(ALICE) }), /bad price/);
  await w.moniker.claim("big", { price: 2n ** 63n - 1n }, { wallet: w.wallet(ALICE) });
  await w.moniker.sell("big", 0n, { wallet: w.wallet(ALICE) });
  assert.deepEqual((await names.buy(w.names.state, BOB, "big")).payments, []);
  await w.moniker.buy("big", {}, { wallet: w.wallet(BOB) });
  assert.equal((await w.moniker.name("big")).owner, BOB);
});

test("a name bought by request points at the signer and passes the policy once the wallet fills in the account", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  const fill = (write, who) => ({ actions: JSON.parse(JSON.stringify(write.actions).replaceAll(ACCOUNT, who)), payments: write.payments });
  const request = (uri) => JSON.parse(Buffer.from(new URL(uri).searchParams.get("intent"), "base64url").toString("utf8"));
  const fresh = request(await w.moniker.buyRequest("@fresh"));
  assert.deepEqual(fresh.actions, names.acquire("fresh").actions);
  assert.ok(w.names.submit(BOB, fill(fresh, BOB)));
  assert.equal(await w.moniker.pointer("fresh"), BOB);
  await w.moniker.claim("listed", { price: 7n, point: true }, { wallet: w.wallet(ALICE) });
  const listed = request(await w.moniker.buyRequest("listed"));
  assert.deepEqual(listed.payments, [{ to: ALICE, amount: "7" }]);
  assert.ok(w.names.submit(BOB, fill({ actions: listed.actions, payments: [{ to: ALICE, amount: 7n }] }, BOB)));
  assert.deepEqual((await w.moniker.names(BOB)).map((n) => n.handle), ["fresh", "listed"]);
  assert.equal(w.names.coins.get(ALICE), 100n - 1n + 7n);
  assert.equal(await w.moniker.pointer("listed"), BOB, "no longer pointing at the seller");
  // Only a free name or one for sale can be requested.
  await w.moniker.claim("kept", {}, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.buyRequest("kept"), /not for sale/);
  await w.moniker.offer("kept", BOB, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.buyRequest("kept"), /not for sale/);
  // A signer who already owns the name is refused by the chain.
  await w.moniker.sell("kept", 3n, { wallet: w.wallet(ALICE) });
  assert.ok(!w.names.submit(ALICE, fill(names.acquire("kept", await names.resolve(w.names.state, "kept")), ALICE)));
});

test("an account's own fields are set and removed, by it alone", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await w.moniker.setField("app.demo.color", "teal", { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.field(ALICE, "app.demo.color"), "teal");
  assert.ok(!w.names.submit(BOB, await names.setField(w.names.state, ALICE, "app.demo.color", "red")));
  await w.moniker.setField("app.demo.color", undefined, { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.field(ALICE, "app.demo.color"), undefined);
});

test("combine keeps each key where it first comes, moves a token's index keys and pointer with it, and pays in purchase order", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000, [CAROL]: 100 });
  await w.moniker.claim("one", {}, { wallet: w.wallet(ALICE) });
  const both = combine(await names.pointName(w.names.state, ALICE, "one", BOB), await names.list(w.names.state, ALICE, "one", 9n));
  assert.deepEqual(both.actions.map((a) => a.key), ["name/one", "points/one"]);
  assert.equal(both.actions[0].newValue, `${ALICE}@9`);
  assert.ok(w.names.submit(ALICE, both));
  const twice = [await names.list(w.names.state, ALICE, "one", 1n), await names.list(w.names.state, ALICE, "one", 2n)];
  assert.throws(() => combine(...twice), /changed twice/);
  const pays = (to) => ({ actions: [], payments: [{ to, amount: 5n }] });
  assert.doesNotThrow(() => combine(pays(ALICE), pays(ALICE), pays(CAROL)));
  assert.throws(() => combine(pays(ALICE), pays(CAROL), pays(ALICE)), /come together/);
  // A rewrite of "two" comes first; buying "one" then "two" moves two's purchase up, with its index keys, and pays Carol first.
  await w.moniker.claim("two", { price: 4n }, { wallet: w.wallet(CAROL) });
  const s = w.names.state;
  const shows = write([unchanged("name/two", `${CAROL}@4`)]);
  const bought = combine(shows, await names.buy(s, BOB, "one", { point: true }), await names.buy(s, BOB, "two", { point: true }));
  assert.deepEqual(bought.actions.map((a) => a.key).slice(0, 4), ["name/two", names.namesKey(CAROL, "two"), names.namesKey(BOB, "two"), "points/two"]);
  assert.deepEqual(bought.payments.map((p) => p.to), [CAROL, ALICE]);
  assert.ok(w.names.submit(BOB, bought));
  assert.deepEqual([await w.moniker.pointer("one"), await w.moniker.pointer("two")], [BOB, BOB]);
});

test("a write the policy would refuse as too long, or with two claims, is refused here with why", async () => {
  const w = world({ [ALICE]: 100 });
  const wallet = w.wallet(ALICE);
  // A record value up to 16 KiB is written; one byte more is refused before sending.
  await w.moniker.setField("bio", "b".repeat(16 * 1024), { wallet });
  await assert.rejects(w.moniker.setField("bio", "b".repeat(16 * 1024 + 1), { wallet }), /too long, at most 16384/);
  // Bytes, as the policy counts them.
  await assert.rejects(w.moniker.setField("bio", "é".repeat(8 * 1024 + 1), { wallet }), /too long/);
  // A handle is as long as its names/<account>/ key allows.
  await w.moniker.claim("a".repeat(446), {}, { wallet });
  await assert.rejects(w.moniker.claim("b".repeat(447), {}, { wallet }), /at most 512 bytes/);
  // Two claims in one write: refused here, and by the policy when written by hand.
  const claimOf = (handle) => [change(`name/${handle}`, undefined, ALICE), change(names.namesKey(ALICE, handle), undefined, "1"), change(names.pointsKey(handle), undefined, ALICE)];
  const [two, second] = [claimOf("c1"), claimOf("c2")];
  assert.throws(() => combine(write(two), write(second)), /at most one name/);
  assert.ok(!w.names.submit(ALICE, { actions: [...two, ...second] }));
  assert.ok(w.names.submit(ALICE, { actions: two }));
});
