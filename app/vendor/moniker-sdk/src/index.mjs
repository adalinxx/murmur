// Moniker, the names chain, for Lattice dApps.
//
// An account owns @names: it sells or gives them, and points each at an
// account, any account. An account shows `@h` in every app only while it
// names h (`user/<a>/name` on Moniker) and h points at it, so one read of
// Moniker decides. Apps keep their own records, cards included, on their own
// chains, keyed by account.
//
//   const moniker = createMoniker({ sdk });                 // sdk: the Lattice SDK module
//   const n = await moniker.name("@alice");                 // { handle, owner, price?, offer?, pointer? }
//   const h = await moniker.handleOf(address);              // "alice", or undefined
//   const hs = await moniker.handlesOf(addresses);          // for a feed, in order, from one read
//   await moniker.label(address, card);                     // "Alice @alice"
//   await moniker.showName("@alice", { wallet: window.lattice });
//
// Reads go to the first host that answers, found through Nexus (or the
// `nodes` you name), and every Volume is checked by its CID; the tip is the
// host's word. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import { connect, monikerClient } from "./client.mjs";

export { discover } from "./client.mjs";

/** Where Moniker lives: Nexus/moniker, whose hosts Nexus's seeds list. */
export const DEFAULTS = {
  chain: ["Nexus", "moniker"],
  // Nexus nodes, asked for Moniker's hosts. Name `nodes` to read from those instead.
  seeds: ["https://seed1.lattice.build", "https://seed2.lattice.build", "https://seed3.lattice.build", "https://seed4.lattice.build"],
  app: "https://app.moniker.bio/",
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
};

/** The names client for Moniker. */
export function createMoniker(options) {
  const { sdk, chain, nodes, seeds, app, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createMoniker needs { sdk }: the Lattice SDK module");
  return monikerClient(connect({ sdk, chain, nodes: nodes?.length ? nodes : undefined, seeds, freshFor }), { app });
}

// The builders under the client, over any state view `{ get(key), list(prefix) }`
// (the client's `state()`), for apps that compose their own writes with `combine`.
export {
  acquire,
  buy,
  claim,
  displayName,
  handleOf,
  handlesOf,
  label,
  MONIKER_POLICY,
  ownersOf,
  pointer,
  pointName,
  release,
  resolve,
  showName,
  stopShowing,
} from "./records/names.mjs";
export { ACCOUNT, combine, isAddress, isHandle } from "./records/shared.mjs";
export { accountIcon, shortAccount } from "./records/account.mjs";
