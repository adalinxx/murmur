// Notifications (src/notify.mjs): what happened to you, from public records.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mentioned, notifications } from "../src/notify.mjs";

let n = 0;
const post = (author, at, extra = {}) => ({ author, id: `p${(n++).toString(36)}`, at, text: "hi", ...extra });
const to = (p) => ({ author: p.author, id: p.id });

test("mentions: @handles as the page links them, not emails or @@", () => {
  assert.deepEqual([...mentioned("hi @Ada and @bob_2, mail a@b.c, @@zed")], ["ada", "bob_2"]);
});

test("replies, quotes and mentions one by one; likes and reposts grouped by your post; your own and muted left out", () => {
  const mine = post("me", 100);
  const other = post("ann", 50);
  const posts = [
    mine,
    other,
    post("ann", 200, { reply: to(mine) }),
    post("bob", 300, { text: "", repost: to(mine) }),
    post("cat", 310, { text: "", repost: to(mine) }),
    post("dan", 400, { quote: to(mine) }),
    post("eve", 500, { text: "hey @Me" }),
    post("me", 600, { reply: to(mine) }),
    post("zed", 700, { reply: to(mine) }),
    post("ann", 800, { reply: to(other) }),
  ];
  const likes = [
    { account: "ann", author: "me", id: mine.id },
    { account: "bob", author: "me", id: mine.id },
    { account: "me", author: "me", id: mine.id },
    { account: "ann", author: "ann", id: other.id },
  ];
  const firstSeen = new Map([[`like:bob/me/${mine.id}`, 900]]);
  const { items, keys } = notifications({ posts, likes }, "me", { handle: "me", firstSeen, muted: new Set(["zed"]) });
  assert.deepEqual(
    items.map((i) => [i.type, i.at, i.actors ?? i.post.author]),
    [
      ["like", 900, ["bob", "ann"]],
      ["mention", 500, "eve"],
      ["quote", 400, "dan"],
      ["repost", 310, ["cat", "bob"]],
      ["reply", 200, "ann"],
    ],
  );
  assert.deepEqual(keys.sort(), [`like:ann/me/${mine.id}`, `like:bob/me/${mine.id}`]);
});

test("follows, grouped by the day this device first saw them; those never seen before count from 0", () => {
  const DAY = 86_400_000;
  const firstSeen = new Map([["follow:ann", 5 * DAY + 10], ["follow:bob", 5 * DAY + 20], ["follow:cat", 9 * DAY]]);
  const { items, keys } = notifications({ posts: [], likes: [] }, "me", { followers: ["ann", "bob", "cat", "dan", "me"], firstSeen });
  assert.deepEqual(items.map((i) => [i.at, i.actors]), [[9 * DAY, ["cat"]], [5 * DAY + 20, ["bob", "ann"]], [0, ["dan"]]]);
  assert.equal(keys.length, 4);
});
