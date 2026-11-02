// The client createMoniker returns, over a link to Moniker:
// `{ chain, nodes, hosts(), state({ fresh }) }`, as `connect` makes it. Reads
// take the chain's state at a host's tip; writes go to the person's wallet,
// which shows them, sets the fee, signs and sends; nothing here holds a key.
import * as names from "./records/names.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest, writeRequestURI } from "./records/wallet.mjs";

/**
 * The hosts Nexus lists for `chain`, asked of each of `seeds` (Nexus nodes)
 * in turn: the first that lists any, as https origins. A host announces
 * itself, so a listing is not proof it serves the chain: reads still check
 * every Volume by CID, but trust the tip of whichever host answers.
 */
export async function discover(chain, seeds) {
  let failure;
  for (const seed of seeds) {
    try {
      const url = new URL("/api/chain/endpoints", seed);
      url.searchParams.set("chainPath", chain.join("/"));
      const response = await fetch(url);
      if (!response.ok) throw new Error(`endpoints: HTTP ${response.status}`);
      const { endpoints } = await response.json();
      const hosts = [...new Set((Array.isArray(endpoints) ? endpoints : []).flatMap(httpsOrigin))];
      if (hosts.length) return hosts;
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`Nexus lists no host for ${chain.join("/")}`, { cause: failure });
}
/** `url`'s origin, in a list, when it is https; else nothing. */
function httpsOrigin(url) {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "https:" ? [origin] : [];
  } catch {
    return [];
  }
}

/**
 * A link to `chain`, with the Lattice SDK module `sdk`: through `nodes` when
 * named, else through the hosts Nexus lists, found from `seeds`.
 */
export function connect({ sdk, chain, nodes, seeds, freshFor }) {
  let reach = null; // Promise<{ hosts, volumes, load }>
  /** The hosts to read from, found once and again after none of them answers. */
  function hosts() {
    reach ??= (async () => {
      const found = nodes ?? (await discover(chain, seeds));
      const volumes = new sdk.VolumeClient(anyHost(found.map((host) => new sdk.HTTPVolumeTransport(`${host}/volumes`, { chainPath: chain }))));
      return { hosts: found, volumes, load: volumeLoader(volumes, sdk.decodeDagCbor) };
    })();
    const finding = reach;
    finding.catch(() => reach === finding && (reach = null));
    return finding;
  }

  let current = null; // { at, state: Promise }
  /** The chain's state at the tip of the first host that answers, reused for `freshFor` ms. */
  function state({ fresh = false } = {}) {
    if (!fresh && current && Date.now() - current.at < freshFor) return current.state;
    const read = (async () => {
      const finding = hosts();
      const reached = await finding;
      let failure;
      for (const host of reached.hosts) {
        try {
          const { generalStateCID } = await tip(sdk, host, chain, reached.volumes);
          return view(reached.load, generalStateCID);
        } catch (error) {
          failure = error;
        }
      }
      // The listed hosts may have moved: ask Nexus again next time.
      if (!nodes && reach === finding) reach = null;
      throw new Error(`No host is serving ${chain.join("/")}`, { cause: failure });
    })();
    current = { at: Date.now(), state: read };
    read.catch(() => current?.state === read && (current = null));
    return read;
  }

  return { chain, nodes, hosts: async () => (await hosts()).hosts, state };
}

const needWallet = (wallet) => {
  if (!wallet?.writeRecords) throw new Error("This needs the Lattice Wallet extension (window.lattice).");
  return wallet;
};
/** The connected account. */
const me = async (wallet) => (await needWallet(wallet).address?.()) ?? (await wallet.connect());
/** Asks the wallet to send `write` on the link's chain; undefined when there is nothing to write. */
const send = (link, wallet, w) => (w.actions.length === 0 ? undefined : needWallet(wallet).writeRecords(writeRequest(link.chain, w)));
/** Builds a write with `build(state, account)` on a fresh state, as the connected account, and sends it. */
async function buildAndSend(link, wallet, build) {
  const account = await me(wallet);
  return send(link, wallet, await build(await link.state({ fresh: true }), account));
}
const bare = (handle) => String(handle).replace(/^@/, "");

/** The names client over a link to Moniker; `app` is the Moniker app's URL. */
export function monikerClient(link, { app }) {
  const { state } = link;
  const fresh = () => state({ fresh: true });
  const act = (wallet, build) => buildAndSend(link, wallet, build);
  return {
    chain: link.chain,
    nodes: link.nodes,
    /** The hosts reads go to: `nodes` when named, else those Nexus lists. */
    hosts: link.hosts,
    state,

    // ---- reading

    /** A name as held: `{ handle, owner, price?, offer?, pointer? }`, or undefined when free. */
    name: async (handle) => names.resolve(await state(), bare(handle)),
    /** The names an account owns, as `name` returns them. */
    names: async (address) => names.namesOf(await state(), address),
    /** The owner of each of `handles` (with or without the @), in order, from one state; undefined when free. */
    owners: async (handles) => names.ownersOf(await state(), handles.map(bare)),
    /** The account `@handle` points at, or undefined. */
    pointer: async (handle) => names.pointer(await state(), bare(handle)),
    /** The handle an account shows: the one it names, while that handle points at it; else undefined. */
    handleOf: async (address) => names.handleOf(await state(), address),
    /** `handleOf` for many accounts, in order, from one state: for a feed. */
    handlesOf: async (addresses) => names.handlesOf(await state(), addresses),
    /**
     * What to show for an account: `card.name` (your app's, with no `@` or
     * invisible controls) with its verified @handle beside it, else the handle, else the
     * account's short ID.
     */
    label: async (address, card) => names.label(address, { name: card?.name, handle: await names.handleOf(await state(), address) }),
    /** Names for sale, cheapest first. */
    forSale: async () => names.forSale(await state()),
    /** A field an account keeps, such as `key.x25519` or `app.<name>.<field>`. */
    field: async (address, name) => names.getField(await state(), address, name),
    /** A link to a name's Moniker page. */
    pageURL: (who) => `${app}#/${encodeURIComponent(who)}`,

    // ---- writing, through the person's wallet, as the connected account

    /** Claims a free `@handle`, for sale at `price` if given, pointed at account `point` if given (`true`: you); `show`: pointed at you and shown as yours, in one transaction. */
    claim: (handle, { price, point, show } = {}, { wallet }) =>
      act(wallet, (s, a) => names.claim(s, a, bare(handle), { price: price === undefined ? undefined : BigInt(price), point, show })),
    /** Points a name of yours at an account (`true`: you), or nowhere (null). */
    point: (handle, address, { wallet }) => act(wallet, (s, a) => names.pointName(s, a, bare(handle), address)),
    /** Puts a name up for sale: anyone may then buy it at `price` at once. */
    sell: (handle, price, { wallet }) => act(wallet, (s, a) => names.list(s, a, bare(handle), BigInt(price))),
    /** Takes a name off sale, or back from an offer. */
    unlist: (handle, { wallet }) => act(wallet, (s, a) => names.unlist(s, a, bare(handle))),
    /** Offers a name to another account, which may take it for nothing. */
    offer: (handle, address, { wallet }) => act(wallet, (s, a) => names.offerName(s, a, bare(handle), address)),
    /** Buys a name at the price the chain holds, or takes it as offered. Its pointer is cleared unless `point` sets one (`true`: you); `show`: pointed at you and shown as yours, in one transaction. */
    buy: (handle, { point, show } = {}, { wallet }) => act(wallet, (s, a) => names.buy(s, a, bare(handle), { point, show })),
    /** Gives a name up, with its pointer; anyone may claim it next. */
    release: (handle, { wallet }) => act(wallet, (s, a) => names.release(s, a, bare(handle))),
    /** Shows `@handle` for you in every app, in one transaction: names it, and points it at you if it is yours and points elsewhere. */
    showName: (handle, { wallet }) => act(wallet, (s, a) => names.showName(s, a, bare(handle))),
    /** Shows no handle for you. */
    stopShowing: ({ wallet }) => act(wallet, (s, a) => names.stopShowing(s, a)),
    /** Sets a field for the connected account, or removes it with undefined. */
    setField: (name, value, { wallet }) => act(wallet, (s, a) => names.setField(s, a, name, value)),
    /**
     * A lattice://write request that claims `@handle`, or buys it at the
     * price the chain holds now, for whichever account signs it, and points
     * it at that account: no wallet or address needed here. Hand it to
     * `window.lattice.openRequest` from a click, or show it as a QR code or
     * text. Refused here when the name is held and not for sale, and by the
     * chain when the signer already owns it.
     */
    buyRequest: async (handle) => {
      const name = bare(handle);
      const now = await fresh();
      const entry = await names.resolve(now, name);
      // Wallets show at most 64 characters of a label: a longer one goes unlabeled.
      const label = `Buy @${name}`.length <= 64 ? `Buy @${name}` : undefined;
      return writeRequestURI(link.chain, names.acquire(name, entry, await now.get(names.pointsKey(name))), { label });
    },
  };
}
