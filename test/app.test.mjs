// The page's pure parts (app/lib.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { ago, left, parseRoute, parseWho, renderText, shownCard } from "../app/lib.mjs";

const ALICE = sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(1)));

test("routes", () => {
  assert.deepEqual(parseRoute(""), { view: "home" });
  assert.deepEqual(parseRoute("#/"), { view: "home" });
  assert.deepEqual(parseRoute("#/everyone"), { view: "everyone" });
  assert.deepEqual(parseRoute("#/following"), { view: "following" });
  assert.deepEqual(parseRoute("#/notifications"), { view: "notifications" });
  assert.equal(parseRoute("#/@ada/likes").tab, "likes");
  assert.equal(parseRoute("#/@ada/media").who.handle, "ada");
  assert.deepEqual(parseRoute("#/@ada/nope"), { view: "missing" });
  assert.deepEqual(parseRoute(`#/search?${new URLSearchParams({ q: "café #bikes" })}`), { view: "search", q: "café #bikes" });
  assert.deepEqual(parseRoute("#/search"), { view: "person", who: { handle: "search" } });
  assert.deepEqual(parseRoute("#/@Ada"), { view: "person", who: { handle: "ada" } });
  assert.deepEqual(parseRoute(`#/${ALICE}`), { view: "person", who: { account: ALICE } });
  assert.deepEqual(parseRoute(`#/${ALICE}/lz3k9q2a0x7c1`), { view: "post", author: ALICE, id: "lz3k9q2a0x7c1" });
  for (const hash of ["#/@a-b", `#/${ALICE}/UPPER`, `#/alice/abc`, "#/%E0%A4%A", `#/${ALICE}/a/b`]) assert.equal(parseRoute(hash).view, "missing", hash);
  assert.deepEqual(parseWho(" @bob_2 "), { handle: "bob_2" });
  assert.equal(parseWho("not a handle"), null);
});

test("post text is text: escaped, with links and handles linked", () => {
  assert.equal(renderText(`<img src=x onerror="alert(1)">`), "&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
  assert.equal(renderText("see https://example.com/a?b=1."), 'see <a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">example.com/a?b=1</a>.');
  assert.equal(renderText("hi @Ada!"), 'hi <a href="#/@ada">@Ada</a>!');
  // An email address is not a mention, and a javascript: link is not a link.
  assert.equal(renderText("me@ada.dev"), "me@ada.dev");
  assert.equal(renderText("javascript:alert(1)"), "javascript:alert(1)");
  assert.ok(!renderText('https://x.y/"onmouseover="alert(1)').includes('"onmouseover'));
});

test("times and characters left", () => {
  const now = Date.UTC(2026, 10, 2, 12);
  assert.equal(ago(now - 5_000, now), "now");
  assert.equal(ago(now - 5 * 60_000, now), "5m");
  assert.equal(ago(now - 3 * 3600_000, now), "3h");
  assert.equal(ago(Date.UTC(2026, 9, 2, 12), now), "Oct 2");
  assert.equal(ago(Date.UTC(2025, 9, 2, 12), now), "Oct 2, 2025");
  assert.equal(left("😀".repeat(10)), 270);
});

test("a person's card: Murmur's first, then Moniker's", () => {
  const moniker = { name: "Dana Okafor", description: "Moniker bio", avatar: ALICE, url: "https://dana.example/", links: [{ label: "Blog", url: "https://blog.example/" }] };
  assert.deepEqual(shownCard({ name: "Dana", bio: "Murmur bio" }, moniker), { name: "Dana", bio: "Murmur bio", url: "https://dana.example/", links: moniker.links });
  assert.deepEqual(shownCard({}, moniker), { name: "Dana Okafor", bio: "Moniker bio", url: "https://dana.example/", links: moniker.links });
  // A Murmur name of only @s, spaces or invisible controls leaves Moniker's, and poses as no handle.
  assert.equal(shownCard({ name: " @＠ ", bio: "  " }, moniker).name, "Dana Okafor");
  assert.equal(shownCard({ name: "\u200b\u202e" }, moniker).name, "Dana Okafor");
  assert.equal(shownCard({ name: "@dana" }).name, "dana");
  assert.deepEqual(shownCard({}, undefined), {});
  assert.deepEqual(shownCard(undefined, undefined), {});
});
