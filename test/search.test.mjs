// Searching posts by their words (src/search.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { matches, searchPosts, terms } from "../src/search.mjs";

test("terms: words folded, punctuation trimmed, tags and handles kept", () => {
  assert.deepEqual(terms("  Café, #Bikes! @Ada  ...  "), ["cafe", "#bikes", "@ada"]);
  assert.deepEqual(terms("# @"), []);
});

test("matches: every word, any case or accent; tags and handles only whole", () => {
  assert.equal(matches("Best CAFÉ in town", terms("cafe town")), true);
  assert.equal(matches("Best cafe", terms("cafe town")), false);
  assert.equal(matches("love #bikes today", terms("#bikes")), true);
  assert.equal(matches("love #bikestand", terms("#bikes")), false);
  assert.equal(matches("hi @ada_2", terms("@ada")), false);
  assert.equal(matches("hi @ada.", terms("@ada")), true);
});

test("searchPosts: newest first, no reposts, muted left out", () => {
  const posts = [
    { author: "a", id: "0001", text: "bread" },
    { author: "b", id: "0003", text: "Bread again" },
    { author: "c", id: "0002", text: "", repost: { author: "a", id: "0001" } },
    { author: "m", id: "0004", text: "bread" },
  ];
  assert.deepEqual(searchPosts(posts, "bread", { muted: new Set(["m"]) }).map((p) => p.id), ["0003", "0001"]);
  assert.deepEqual(searchPosts(posts, "  "), []);
});
