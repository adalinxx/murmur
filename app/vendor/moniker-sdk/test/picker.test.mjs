import assert from "node:assert/strict";
import { test } from "node:test";
import { chosenHandle, problem, stepFor } from "../src/picker.mjs";

const me = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";
const other = "bafyreifsqalulni36xlcodjbzxvfi533uzh7n3kkn6yjwb2v4zslt5ada4";

test("the picker takes what was typed, else the name checked", () => {
  assert.deepEqual(chosenHandle(" @Ada ", "bob"), { handle: "ada" });
  assert.deepEqual(chosenHandle("", "bob"), { handle: "bob" });
  assert.match(chosenHandle("", undefined).error, /Pick one/);
  assert.match(chosenHandle("a-b", "bob").error, /lowercase letters/);
});

test("a free name is claimed; one owned or pointed at the account is shown; one shown already sends nothing", () => {
  assert.equal(stepFor(undefined, me, "ada"), "claim");
  assert.equal(stepFor({ handle: "ada", owner: me }, me, "ada"), "show");
  assert.equal(stepFor({ handle: "ada", owner: other, pointer: me }, me, "ada"), "show");
  assert.equal(stepFor({ handle: "ada", owner: me, pointer: me }, me, "ada", "ada"), "shown");
  // Shown, as named, only while it points at the account.
  assert.equal(stepFor({ handle: "ada", owner: me, pointer: other }, me, "ada", "ada"), "show");
});

test("someone else's name is refused, saying whether it is for sale or offered", () => {
  assert.match(stepFor({ handle: "ada", owner: other }, me, "ada").refused, /^@ada is someone else's\.$/);
  assert.match(stepFor({ handle: "ada", owner: other, price: 25n }, me, "ada").refused, /for sale on Moniker for 25/);
  assert.match(stepFor({ handle: "ada", owner: other, offer: me }, me, "ada").refused, /offered to you/);
});

test("wallet answers read as what happened", () => {
  assert.match(problem(new Error("User declined")), /declined it in Selfhold/);
  assert.match(problem(new Error("Wallet is locked")), /Unlock Selfhold/);
  assert.equal(problem(new Error("No node")), "No node");
});
