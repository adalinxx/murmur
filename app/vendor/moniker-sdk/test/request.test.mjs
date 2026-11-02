import assert from "node:assert/strict";
import { test } from "node:test";
import { acquire } from "../src/records/names.mjs";
import { ACCOUNT, tokenValue } from "../src/records/shared.mjs";
import { writeRequest, writeRequestURI } from "../src/records/wallet.mjs";

const owner = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";
const intent = (uri) => {
  const url = new URL(uri);
  assert.equal(`${url.protocol}//${url.hostname}`, "lattice://write");
  assert.equal(url.searchParams.get("v"), "1");
  return JSON.parse(Buffer.from(url.searchParams.get("intent"), "base64url").toString("utf8"));
};

test("a free name is claimed for whichever account signs, with its names/ key, pointed at it", () => {
  assert.deepEqual(acquire("rae"), {
    actions: [
      { key: "name/rae", newValue: ACCOUNT },
      { key: `names/${ACCOUNT}/rae`, newValue: "1" },
      { key: "points/rae", newValue: ACCOUNT },
    ],
    payments: [],
  });
});

test("a listed name is bought at the price read, paid to its owner", () => {
  const entry = { handle: "rae", value: tokenValue(owner, { price: 500n }), owner, price: 500n };
  const { actions, payments } = acquire("rae", entry);
  assert.deepEqual(actions, [
    { key: "name/rae", oldValue: `${owner}@500`, newValue: ACCOUNT },
    { key: `names/${owner}/rae`, oldValue: "1" },
    { key: `names/${ACCOUNT}/rae`, newValue: "1" },
    { key: "points/rae", newValue: ACCOUNT },
  ]);
  assert.deepEqual(payments, [{ to: owner, amount: 500n }]);
  assert.throws(() => acquire("rae", { ...entry, price: undefined }), /not for sale/);
  assert.throws(() => acquire("Rae"), /lowercase/);
});

test("a write becomes a lattice://write request: no address, no nonce, an expiry and a label", () => {
  const expiresAt = new Date("2030-01-01T00:00:00.000Z");
  const entry = { handle: "rae", value: tokenValue(owner, { price: 500n }), owner, price: 500n };
  const uri = writeRequestURI(["Nexus", "moniker"], acquire("rae", entry), { fee: 0n, label: "Buy @rae", expiresAt });
  assert.match(uri, /^lattice:\/\/write\?v=1&intent=[A-Za-z0-9_-]+$/, "base64url, unpadded");
  assert.deepEqual(intent(uri), {
    version: 1,
    chainPath: ["Nexus", "moniker"],
    actions: acquire("rae", entry).actions,
    payments: [{ to: owner, amount: "500" }],
    fee: "0",
    expiresAt: "2030-01-01T00:00:00.000Z",
    label: "Buy @rae",
  });
  const later = intent(writeRequestURI(["Nexus", "moniker"], { actions: [{ key: "note", newValue: "é ✓" }] }));
  assert.equal(later.actions[0].newValue, "é ✓", "UTF-8 text survives");
  assert.equal(later.fee, undefined, "no fee: the wallet chooses");
  assert.ok(Date.parse(later.expiresAt) - Date.now() > 14 * 60_000, "15 minutes by default");
});

test("a write asks for no fee: the wallet sets it, unless one is proposed", () => {
  const write = { actions: [{ key: "user/a/name", newValue: "ada" }] };
  assert.equal("fee" in writeRequest(["Nexus", "moniker"], write), false);
  assert.equal(writeRequest(["Nexus", "moniker"], write, 3n).fee, "3");
});
