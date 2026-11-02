# moniker-sdk

@names for any Lattice dApp, from [Moniker](https://github.com/adalinxx/moniker),
the names chain every app shares.

- An **account** is a key. It is never shown, only checked.
- A **name** (`@alice`) is an asset an account owns, like a domain: it sells
  it, gives it, and points it at an account, any account.
- An account **shows** `@alice`, in every app, only while it names `alice`
  (`user/<account>/name` on Moniker) **and** `alice` is held and points at
  it. All of it lives on Moniker, so one state decides; your app needs nothing on its own chain
  for handles.

Your app keeps its own records, cards included, on its own chain, keyed by
account. Reads come from the hosts Nexus lists for Moniker and are checked by
CID; writes go to the person's Lattice Wallet, which shows and signs them. No
key handling here.

## Install

Import a release, never a branch: code your users run should change only when
you choose to upgrade. A tag through jsDelivr's GitHub mirror is fixed
(`@v0.4.0`; a commit hash pins harder still):

```js
import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.4.0/src/browser.mjs";
```

Or with npm, from the tag: `npm install github:adalinxx/moniker-sdk#v0.4.0`,
then `import { createMoniker } from "moniker-sdk/browser"`. Vendoring a copy
of `src/` and `vendor/` works too; review upgrades like any dependency.

In Node or with your own copy of the Lattice SDK, import `moniker-sdk` (that
is, `src/index.mjs`) and pass it: `createMoniker({ sdk })`.

## Showing handles

```js
const moniker = createMoniker();                  // Nexus/moniker by default; or { nodes, chain }
await moniker.hosts();                            // where reads go: the hosts Nexus lists, or your nodes

await moniker.handleOf(address);                  // "alice", or undefined
await moniker.handlesOf(addresses);               // a feed's handles, in order, from one read
await moniker.label(address, card);               // "Alice Ng @alice": your card's name (no @ or invisible controls) + verified handle
```

`label` falls back to `@alice`, then to the account's short ID. A card name
never shows an `@` (or a look-alike), bidi or zero-width characters, so only
a verified handle looks like one.

```js
const wallet = window.lattice;                    // the Lattice Wallet extension
await moniker.showName("@alice", { wallet });     // one transaction: names it, and points it at you if it's yours and points elsewhere
await moniker.stopShowing({ wallet });
```

`showName` works for a name someone else owns while it points at you;
someone pointing a name at you shows nothing until you name it.

## Names

```js
await moniker.name("@alice");                     // { handle, owner, price?, offer?, pointer? }, or undefined
await moniker.pointer("@alice");                  // the account it points at
await moniker.names(address);                     // an account's names
await moniker.owners(["alice", "@bob"]);          // each name's owner, in order, from one read (undefined when free)
await moniker.forSale();                          // cheapest first

await moniker.claim("@alice", { point: true }, { wallet });   // point: an address, or true for you (the default)
await moniker.claim("@alice", { show: true }, { wallet });    // claimed, pointed at you and shown, in one transaction (buy takes show too)
await moniker.point("@alice", otherAccount, { wallet });      // or null: nowhere
await moniker.sell("@alice", 500n, { wallet });               // unlist, offer(handle, account)
await moniker.buy("@alice", { point: true }, { wallet });     // the seller's pointer is cleared unless you set one
await moniker.release("@alice", { wallet });                  // and deletes its pointer
```

A sale clears the name's pointer, so the seller stops showing it at once.
Releasing deletes the pointer when done through this SDK; the policy only
allows deleting it, not requires it, so `claim` and `buy` clear any pointer a
release left behind unless you set one.
`field` and `setField` keep an account's own values, such as `key.x25519` or
`app.<your app>.<field>`.

A name can be bought with no address, by any wallet, as a `lattice://write`
request: the wallet fills in the account the person chooses, and the name
points at it. Only a free name or one for sale can be requested; a signer who
already owns it is refused by the chain.

```js
const uri = await moniker.buyRequest("rae");      // lattice://write?v=1&intent=…, valid 15 minutes
await window.lattice.openRequest(uri);            // from a click; or show `uri` as a QR code or text
```

The builders under the client are exported too, over any state view (the
client's `state()`): `claim`, `pointName`, `buy`, `release`, `acquire`,
`showName`, `stopShowing`, `resolve`, `ownersOf`, `pointer`, `handleOf`, `handlesOf`,
`label`, `displayName`. Each write returns `{ actions, payments }`;
`combine(...writes)` joins them into one transaction the way the policy reads
it: each key changes once, where it first comes, an unchanged rewrite giving
way to a real change of the same key (its index keys and pointer moving up
with it), and purchases from one seller together.

The policy is fixed at genesis, and these builders refuse what it would
refuse, with the reason, before anything is sent: a key over 512 bytes (a
handle over 446 characters), a value over 16 KiB, or two claims in one
write. A name that comes to a new owner is always pointed by it in the same
transaction, so no earlier owner's pointer survives.

## The byline element

```js
defineMonikerName(moniker);   // <moniker-name address="bafyrei…" name="Alice Ng" size="24"></moniker-name>
```

`<moniker-name>` shows the `name` your app knows the account by and its
verified `@handle`, the handle linked to its Moniker page (`plain` drops the
link), beside the account's own pattern; restyle it with `--moniker-ink`,
`--moniker-muted` and `--moniker-accent`. See [`demo.html`](demo.html).

## Showing an account

```js
shortAccount(address);      // "bc6g…mbbt6a": both ends of the ID, past the "bafyrei" every ID shares
accountIcon(address, 24);   // SVG markup: a pattern drawn from the middle of the ID, the same in every app
```

Every account ID starts with `bafyrei`, as every block and transaction ID
does, so the short form drops it. Show the pattern beside an account wherever
it appears, so people learn to recognize it; the pattern is drawn from the
part of the ID the short form hides, so an ID made to share both ends with
another still looks different. Short forms are for recognizing: where people
check who owns what, show the whole ID.

## The handle picker

```js
defineHandlePicker(moniker);   // <moniker-handle-picker></moniker-handle-picker>
const handle = await document.querySelector("moniker-handle-picker").open();   // from a click
```

`<moniker-handle-picker>` lets someone choose the `@handle` they show in
every app without leaving yours. Its dialog lists the names the account
connected in Selfhold owns on Moniker, and offers to claim a free one: a free
name is claimed, pointed at the account and shown in one transaction; a name
the account owns, or one pointed at it, is shown. Someone else's name is
refused before the wallet is asked, saying whether it is for sale. Writes go
only from the account the names were listed for.

`open()` resolves to the handle once Moniker shows it, about a block after the
wallet sends it, or to `undefined` if the dialog is closed first. The element
fires `moniker:sent` (`{ account, handle }`) when the wallet has sent it, so
your page can show it as saving, and `moniker:shown` when Moniker shows it.
Pass `defineHandlePicker(moniker, { tag, wallet, app })` to rename the tag,
use another wallet than `window.lattice`, or link another Moniker app.
Restyle it with `--moniker-ink`, `--moniker-muted`, `--moniker-accent`,
`--moniker-accent-ink`, `--moniker-line`, `--moniker-surface` and
`--moniker-bad`.

The fee is the wallet's: a write asks for none, and the person's wallet
pays the fee they set there for the chain (in Selfhold, under Fee). A fee is
relay policy, never consensus: each node reports the least it relays as
`minRelayFee` in `/api/chain/info`, and Selfhold warns when a fee is below it.

Nothing names Moniker's hosts. The client asks Nexus's seeds
(`DEFAULTS.seeds`, `seed1` to `seed4.lattice.build`) for them with
`/api/chain/endpoints?chainPath=Nexus/moniker`, takes the first listing's
https hosts, and reads from the first that answers. It asks again when none
does, or pass `nodes` to read from hosts you name (your own node, say).
A listed host only announced itself: every Volume it serves is checked by CID,
but the tip it reports is taken as it is, so a host could show an older state,
or a state of its own making, as Moniker's.

## Layout

- `src/index.mjs`: `createMoniker`, the builders and the checks.
- `src/browser.mjs`: the same, bound to the vendored Lattice SDK.
- `src/client.mjs`: the client, over a link to Moniker.
- `src/element.mjs`: `<moniker-name>`.
- `src/picker.mjs`: `<moniker-handle-picker>`.
- `src/records/`: `names.mjs` (Moniker's records, as pure builders over a
  state view), `shared.mjs` (tokens, `combine`, checks), `state.mjs` (reads
  state by descending the trie, checked by CID), `wallet.mjs` (the request
  the Lattice Wallet signs).
- `vendor/lattice-sdk.js`: the Lattice SDK, bundled for browsers.

## Test

```
npm test
```

The tests run every write against the real built Moniker policy
(`$MONIKER_WASM`, default `~/src/moniker-follows/policy/target/…/moniker_policy.wasm`;
build it with `cargo build --release --target wasm32-unknown-unknown` in that
`policy/`), and point `LATTICE_SDK` at the Lattice SDK's
`packages/sdk/dist/index.js` if it is not in `~/src/lattice-sdk`.
