import assert from "node:assert/strict";
import { test } from "node:test";
import { createMoniker, DEFAULTS, isAddress, isHandle } from "../src/index.mjs";

// Enough of the Lattice SDK for the clients to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";

test("needs the SDK", () => {
  assert.throws(() => createMoniker({}), /needs \{ sdk \}/);
});

test("Moniker defaults to Nexus/moniker, its hosts found through Nexus, and proposes no fee", () => {
  const moniker = createMoniker({ sdk });
  assert.deepEqual(moniker.chain, ["Nexus", "moniker"]);
  assert.equal(moniker.nodes, undefined, "no hosts named");
  assert.equal("fee" in DEFAULTS, false);
});

test("links to the Moniker app", () => {
  const moniker = createMoniker({ sdk, app: "https://example.test/" });
  assert.equal(moniker.pageURL("@ada"), "https://example.test/#/%40ada");
});

test("writes need a wallet", async () => {
  await assert.rejects(createMoniker({ sdk }).claim("ada", {}, { wallet: undefined }), /Lattice Wallet/);
  await assert.rejects(createMoniker({ sdk }).showName("ada", { wallet: undefined }), /Lattice Wallet/);
});

test("checks addresses and handles as the policy does", () => {
  assert.ok(isAddress(address));
  assert.ok(!isAddress("bafyrei"));
  for (const bad of [address.toUpperCase(), address.slice(0, 58), `${address.slice(0, 58)}b`]) assert.ok(!isAddress(bad), bad);
  assert.ok(isHandle("ada_1"));
  for (const bad of ["", "Ada", "a-b", "a.b", "é"]) assert.ok(!isHandle(bad), bad);
});
