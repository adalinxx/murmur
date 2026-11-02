import assert from "node:assert/strict";
import { test } from "node:test";
import { accountIcon, shortAccount } from "../src/index.mjs";

const A = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";
// The same both ends as A, a different middle: what an address-poisoning lookalike looks like.
const LOOKALIKE = A.slice(0, 27) + "zzzzz" + A.slice(32);

test("the short form drops the prefix every ID shares and keeps both ends", () => {
  assert.equal(shortAccount(A), "bc6g…mbbt6a");
  assert.equal(shortAccount(LOOKALIKE), shortAccount(A));
  assert.equal(shortAccount("short"), "short");
});

test("the pattern is the same for one account, and differs where the short form can't", () => {
  assert.equal(accountIcon(A), accountIcon(A));
  assert.notEqual(accountIcon(LOOKALIKE), accountIcon(A));
  assert.match(accountIcon(A, 40), /^<svg [^>]*width="40" height="40"/);
});

test("the pattern is mirrored, and only numbers reach the markup", () => {
  for (const id of [A, LOOKALIKE, "bafyrei", "<script>", 'x" onload="alert(1)']) {
    const svg = accountIcon(id, '"><b>');
    assert.doesNotMatch(svg.replace(/<\/?(svg|rect|g)\b[^>]*>/g, ""), /\S/, "nothing but svg, rect and g elements");
    assert.doesNotMatch(svg, /onload|script|<b>/);
    const cells = [...svg.matchAll(/<rect x="(\d)" y="(\d)"/g)].map(([, x, y]) => `${x},${y}`);
    for (const cell of cells) {
      const [x, y] = cell.split(",");
      assert.ok(cells.includes(`${4 - x},${y}`), `mirrored: ${cell}`);
    }
  }
});
