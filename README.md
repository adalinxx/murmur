# Murmur

Short posts no one can take down or sell, on Lattice. Post, reply, repost,
quote, like and share pictures, with no server and no coins.

**Try it:** https://adalinxx.github.io/murmur/app/ (testnet).

- **Your posts are yours.** Murmur is its own Lattice chain. Every record
  belongs to the account named in its key, and only that account can write
  or delete it. A post is created once and never edited, so a reply or a
  like always points at what its author saw.
- **Your audience comes with you.** Whom you follow is
  [Follows](https://github.com/adalinxx/follows), the follow graph every
  Lattice app shares. Your `@handle` is
  [Moniker](https://github.com/adalinxx/moniker)'s. Murmur keeps neither.
- **Nobody needs coins.** Writes carry no fee of their own. Selfhold's window
  pays each one with a moment of this device's work, through a fee sponsor
  (`lattice-sponsor`), as Stoa and Moniker do. Pictures are kept for good
  by a storage sponsor (the same `lattice-sponsor`, `--sell-storage`), paid
  with work too.
- **Every client decides.** Timelines, threads and counts are read from any
  node and checked by CID. Ranking and filtering are up to the client.

## Records

| Key | Value | Written by |
| --- | --- | --- |
| `post/<a>/<id>` | `{ text, media?, reply?, repost?, quote? }`, at most 4096 bytes | `<a>`: created or deleted, never edited |
| `reply/<p>/<pid>/<a>/<id>` | `1`: `<a>`'s post `<id>` replies to `<p>`'s post `<pid>` | `<a>` |
| `repost/<p>/<pid>/<a>/<id>` | `1`: the same, for a repost | `<a>` |
| `quote/<p>/<pid>/<a>/<id>` | `1`: the same, for a quote | `<a>` |
| `like/<a>/<p>/<pid>` and `liked/<p>/<pid>/<a>` | `1`, both in one transaction, the twin directly after | `<a>` |
| `profile/<a>` | `{ name?, bio? }`, at most 4096 bytes | `<a>` |

`<a>` and `<p>` are account addresses. A post `<id>` is its time in
milliseconds in base 36 (9 characters) and 4 random ones, so one author's
posts list in time order. The policy allows 1 to 16 lowercase letters and
digits.

A reply, repost or quote is a post that names the post it points at, with an
entry listed under that post, so a post's replies are one prefix read. The
entry is its author's claim. A reader keeps it only while the post exists
and points there the same way, so nobody can list a post under someone
else's that doesn't answer it. A repost is a post with empty text and a
`repost`, so it has a time and sorts into a timeline like any post.

Clients cap a post at 280 characters (code points), a name at 50 and a bio
at 300. The policy caps bytes, since every host keeps every byte.

## Pictures

A post's `media` is up to 4 pictures, `{ cid, type, alt? }`, with `alt` up
to 420 characters. The types are PNG, JPEG, GIF, WebP and AVIF: never SVG,
which is a document that can run script. A post with pictures may have no
text.

The bytes stay off the chain. One picture is one Volume of one block,
DAG-CBOR `{ type, bytes }`, at most 1 MiB, as Stoa keeps files
(`src/media.mjs`). The poster's device has a storage sponsor keep it for
good (`src/storage.mjs`, from Stoa):

1. It uploads the Volume with `POST /store`.
2. It grinds the shares of work the sponsor asks for, on its GPU where the
   page can use one, else in workers on its cores (`app/vendor/work/`, from
   Selfhold).
3. Once the work covers the bytes, the sponsor pins the Volume on its node.

Only then is the post sent. A reader fetches the picture from any node's
`/volumes/<cid>` and checks it against the CID. The sponsor is trusted for
keeping it, never for its contents.

The work is paid on Murmur's chain where the sponsor sets a storage rate for
it, else on any chain it does (`GET /terms`). A kept file is just a CID on
that node, whichever chain's work paid for it.

The page re-encodes each picture before keeping it, to WebP (or JPEG), at
most 2048 pixels across and under 1 MB. This also drops its metadata, such
as where it was taken. GIFs are kept as they are, so they still move.

## For you

The home timeline is ranked in your browser, from public records and your own
feedback, with nothing sent anywhere (`src/foryou.mjs`). It reads every post,
every like and the Follows graph, then:

1. **Trust.** Trust flows three steps out from you along follows, halving
   each step and split among whom each account follows. Whom you follow count
   1. Accounts, likes and follows cost nothing but a moment of work, so a like
   counts only as much as you trust whoever made it. A farm of accounts nobody
   you trust follows adds nothing, however many it makes (`test/foryou.test.mjs`
   checks this against a 1,000-account farm).
2. **Candidates.** Posts by whom you follow, and posts that people you trust
   liked, reposted, replied to or quoted. A post from outside your network
   needs that proof: someone you follow, two people you trust, or three today.
   A reply shows when you follow both sides, it answers you, or someone you
   follow engaged with it.
3. **Score.** `1 + 2·affinity + 1.5·log2(1 + trusted engagement) + 0.5·trend
   + 0.5·mutual`. Affinity is how often you liked, reposted (×2), replied to
   (×3) or quoted (×3) the author, fading over 30 days. Engagement weighs each
   account's like 1, repost 2, reply or quote 3, by trust, damped for accounts
   that like everything. Scores halve every 18 hours, or 36 or 72 when the
   network is quiet. Posts from outside your network count ×0.75, replies
   ×0.75, posts you've seen ×0.3.
4. **Mix.** As X does: an author's nth post on the page counts
   (1−0.25)·0.5ⁿ + 0.25, so one person can't fill it; one post per
   conversation; at most 40% from outside your network (60% while you follow
   fewer than 10); someone you follow at least every fifth post; posts seen
   before go last.

Each post says why it's there: "Liked by Alice and 2 others you follow". Before
you follow anyone, For you is what's popular on Murmur, labeled so, with whom
to follow.

**Not interested** hides a post and shows you less from its author, at 0.2 and
back to full over 140 days. **Mute** hides someone everywhere until you unmute
them from their page. Both, and which posts you've seen, stay in this
browser's storage. Following and Everyone stay newest first.

The weights are starting points taken from the systems they come from (X's
open-sourced ranking, SybilRank, Mastodon's trends), not tuned yet.

## Notifications

Nothing tells you what happened; the page reads it from the chain
(`src/notify.mjs`): replies to and quotes of your posts, posts naming your
@handle, reposts and likes grouped by post, and new followers grouped by day.
Likes and follows carry no time, so this browser keeps when it first saw each
one, and when you last looked, to light the bell. Muted accounts are left out.

## The page

`app/` is a static page:

- **Home:** For you, ranked for you (above); Following, your posts and those
  of everyone you follow on Follows, newest first; and Everyone, every post on
  the chain.
- **A person's page** (`#/@handle` or `#/<account>`): their card, Follows
  counts, a Follow button, and their posts.
- **A post's page** (`#/<account>/<id>`): the thread above it, and its
  replies.
- **The composer** takes up to 4 pictures, chosen, pasted or dropped, each
  with a description. It shows each one being kept, and posts once all are.

People show by their card's name and their verified Moniker `@handle`, else
by a short account ID. Their picture is the pattern drawn from their account,
the same in every Lattice app. Post text is text: links and `@handles` are
linked, and nothing else becomes markup.

Writes go to Selfhold's window, which shows each one, has its fee sponsored
and signs. A post takes about a block to land and shows as saving until
then.

```sh
python3 -m http.server 8790   # from the repository root, then open http://127.0.0.1:8790/app/
```

`?node=` (comma-separated), `?chain=`, `?follows=`, `?moniker=`, `?sponsor=`
and `?wallet=` point the page at other nodes, chains, fee sponsor or
Selfhold.

## Use Murmur in your app

```js
import * as sdk from "./vendor/lattice-sdk.js";
import { createMurmur } from "./src/index.mjs";

const murmur = createMurmur({ sdk });                 // or { chain, nodes }
await murmur.feed([me, ...following]);                // newest first
await murmur.postsBy(address);
await murmur.everyone();
await murmur.thread({ author, id });                  // { above, post, replies }
await murmur.stats({ author, id }, me);               // { replies, reposts, quotes, likes, liked, reposted }
await murmur.card(address);                           // { name?, bio? }
await murmur.media(cid);                              // { type, bytes }, checked against the CID

const how = { wallet, account: me };                  // wallet: Selfhold's client
const volume = murmur.mediaVolume("image/webp", bytes);
await murmur.keep(volume, { hash });                  // kept for good, paid with work; hash: app/vendor/work/hash.mjs's hasher
await murmur.compose({ text, media: [{ cid: volume.cid, type: "image/webp", alt }], reply?, quote? }, how);  // { id, sent }
await murmur.like(post, how);    await murmur.unlike(post, how);
await murmur.repost(post, how);  await murmur.unrepost(post, how);
await murmur.remove(id, how);
await murmur.setCard({ name, bio }, how);
```

The record builders and readers are exported as `records` too, over any
state view `{ get(key), list(prefix) }`.

## Layout

- `policy/`: the chain's validity policy (Rust, built to wasm), on
  `lattice-policy-rules` from Moniker. `policy/host-check/` replays the test
  contexts through Lattice's own evaluator.
- `chain/spec.json`: the chain spec, which names the policy module by CID.
  `chain/murmur_policy.wasm` is that module, built.
- `src/`: the library. `src/records/murmur.mjs` holds the records,
  `state.mjs` reads state by walking down the trie (from Follows), and
  `wallet.mjs` builds the wallet request, with no fee.
- `app/`: the page. `app/vendor/` holds Selfhold's client (`selfhold.mjs`,
  from Stoa) and moniker-sdk.
- `vendor/`: the Lattice SDK bundled for browsers, and Follows
  (`vendor/follows/`, at the commit in `COMMIT`).

## Test

```sh
npm run build:policy                           # the policy, with this machine's paths left out of it
npm test                                       # the policy, the records through it, the page's helpers

CONTEXT_DIR=.contexts node --test test/policy.test.mjs
(cd policy/host-check && swift run -c release host-check \
  ../target/wasm32-unknown-unknown/release/murmur_policy.wasm ../../.contexts)
```

The end-to-end test runs on a private node that takes no fee under 1, as
the shared testnet hosts do, with a real fee sponsor beside it:

```sh
LATTICE=<lattice-node>/.build/debug/lattice node e2e/murmur.mjs
```

`lattice-sponsor` must sit beside `lattice`, or be named by
`LATTICE_SPONSOR`. It must sell storage (0xLattice/lattice-sponsor), and
`LATTICE` must be a node it runs beside (lattice-node at or after the
sponsor's pinned commit). Alice, Bob and Carol never hold a coin, and a zero-fee
write is refused. Every write is paid by the sponsor for shares of work the
test grinds, as Selfhold's window does in a page. Alice sets her card and
posts. Bob follows her on Follows, and his timeline is her posts. Bob
replies, likes and reposts, and Carol quotes. Alice also pays for a picture
with work, the sponsor pins it, she posts it, and a reader with nothing
cached fetches the same bytes from the node. Counts, threads and timelines
read back. Forging a post, editing one, deleting someone else's, a like
without its twin and an oversized post are refused even with the fee paid.
Then come an unlike, an unrepost and a deletion, after which the reply shows
its post is gone. At the end nobody but the sponsor has paid.

`E2E_KEEP=<port>` adds a few posts, some with pictures, and then serves the
page against that node until interrupted. `e2e/ui/shots.mjs` screenshots
it. It also adds a picture to a draft in a real browser, where the page
grinds the work in its own workers and the sponsor keeps the picture.

## Trial

The trial chain is `Nexus/testnet/murmur-51cf47`, from `chain/spec.json`
(policy module `bafyreiemqm7cqxsrjqg3kbttpgs2isatrnkuxnsjejjzwtypahuvprvywq`).
It was created on the operator's Mac node, which merge-mines it. Its premine
goes to a test key kept in `~/lattice-mac-node/murmur-keys/`, which is not in
this repository. The shared testnet app hosts `lattice-testnet-apps-iad` and
`-ams` host it, added live. The fee sponsor there pays Murmur's fees from a
float of 100,000 sent from the premine.

The sponsor's storage rate for Murmur (`SPONSOR_STORAGE_RATES` in
lops-sponsor's `testnet-apps/fly.iad.toml`) takes effect on the app host's
next deploy. Until then, pictures are paid for with work on Stoa's chains,
which that sponsor already keeps files for.
