// Murmur for any app: short posts on a Lattice chain, read from any host and
// checked by CID, written through the person's wallet.
//
//   const murmur = createMurmur({ sdk });                     // sdk: the Lattice SDK module
//   await murmur.feed(await graph.followingAccounts(me));     // a timeline, from Follows
//   await murmur.thread({ author, id });
//   await murmur.compose({ text: "hello" }, { wallet, account });
//
// Writes carry no fee: the wallet sets it, and Selfhold's window pays it in
// this device's work through a fee sponsor, so nobody needs coins to post.
import { mediaVolume, readMedia } from "./media.mjs";
import * as records from "./records/murmur.mjs";
import { StorageRefused, storageChain, store } from "./storage.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest } from "./records/wallet.mjs";

/** Where Murmur lives now: its testnet trial chain on the shared app hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "murmur-51cf47"],
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
  // The sponsor that keeps pictures for work, as Stoa uses it.
  storage: "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor",
};

export function createMurmur(options) {
  const { sdk, chain, nodes, freshFor, storage } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createMurmur needs { sdk }: the Lattice SDK module");
  const volumes = new sdk.VolumeClient(anyHost(nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }))));
  const load = volumeLoader(volumes, sdk.decodeDagCbor);

  let current = null; // { at, state: Promise }
  /** The chain's state at the tip of the first node that answers, reused for `freshFor` ms. */
  function state({ fresh = false } = {}) {
    if (!fresh && current && Date.now() - current.at < freshFor) return current.state;
    const read = (async () => {
      // Every node is asked for its tip at once; the first to answer is read.
      try {
        const { generalStateCID } = await Promise.any(nodes.map((node) => tip(sdk, node, chain, volumes)));
        return view(load, generalStateCID);
      } catch (error) {
        throw new Error(`No node is serving ${chain.join("/")}`, { cause: error.errors?.[0] ?? error });
      }
    })();
    current = { at: Date.now(), state: read };
    read.catch(() => current?.state === read && (current = null));
    return read;
  }

  /**
   * Sends `write` through `wallet` as `account`, unless there is nothing to
   * write: the wallet's answer, or null. `progress` hears the wallet's steps.
   */
  async function send(write, { wallet, account, progress }) {
    if (!wallet?.writeRecords) throw new Error("This needs a Lattice wallet such as Selfhold.");
    if (write.actions.length === 0) return null;
    const sent = await wallet.writeRecords(writeRequest(chain, write), { account, progress });
    current = null;
    return sent;
  }
  const signer = async ({ wallet, account }) => account ?? (await wallet.address?.()) ?? (await wallet.connect());

  return {
    chain,
    nodes,
    state,

    post: async ({ author, id }) => records.getPost(await state(), author, id),
    postsBy: async (author, options) => records.postsBy(await state(), author, options),
    likedBy: async (account, options) => records.likedBy(await state(), account, options),
    feed: async (authors, options) => records.feed(await state(), authors, options),
    everyone: async (options) => records.everyone(await state(), options),
    thread: async (to, options) => records.thread(await state(), to, options),
    stats: async (to, reader) => records.stats(await state(), to, reader),
    card: async (account) => records.card(await state(), account),
    /** Every post and like, `{ posts, likes }`, for ranking with `rank.index` and `rank.forYou`. */
    snapshot: async () => records.snapshot(await state()),

    /** The picture kept as `cid`, `{ type, bytes }`, checked against it; undefined if it isn't one. Throws when no node serves it. */
    media: async (cid) => {
      if (!records.isMediaCID(cid)) return undefined;
      const volume = await volumes.get(cid);
      return readMedia(sdk, volume.bytes(cid));
    },
    /** The Volume for a picture: `{ cid, entries }`, ready for `keep`. */
    mediaVolume: (type, bytes) => mediaVolume(sdk, type, bytes),
    /**
     * Has the storage sponsor keep `volume` for good, paid with shares of
     * work ground by `hash(work, found, hashed)`; resolves once it is pinned.
     * `progress({ stage, done })`. Throws StorageRefused, saying why.
     */
    keep: async (volume, { hash, progress, signal, sponsor = storage } = {}) => {
      // Work on Murmur's chain where the sponsor prices storage there, else on
      // any chain it does: a kept file is a CID on its node, whichever chain's work paid.
      const paidOn = await storageChain(sponsor, [chain.join("/")]);
      if (!paidOn) throw new StorageRefused("The storage sponsor isn't keeping files right now.");
      return store(sponsor, volume, { chain: paidOn, hash, progress, signal });
    },

    /** Posts `{ text, media?, reply?, quote? }` as the wallet's account: `{ id, sent }`. Keep its media first. */
    compose: async (draft, how) => {
      const write = records.compose(await signer(how), draft);
      return { id: write.id, sent: await send(write, how) };
    },
    remove: async (id, how) => send(await records.remove(await state({ fresh: true }), await signer(how), id), how),
    like: async (to, how) => send(await records.like(await state({ fresh: true }), await signer(how), to), how),
    unlike: async (to, how) => send(await records.unlike(await state({ fresh: true }), await signer(how), to), how),
    repost: async (to, how) => send(await records.repost(await state({ fresh: true }), await signer(how), to), how),
    unrepost: async (to, how) => send(await records.unrepost(await state({ fresh: true }), await signer(how), to), how),
    setCard: async (card, how) => send(await records.setCard(await state({ fresh: true }), await signer(how), card), how),
  };
}

export * as records from "./records/murmur.mjs";
export * as rank from "./foryou.mjs";
export { notifications } from "./notify.mjs";
export { searchPosts } from "./search.mjs";
export { MAX_MEDIA_BYTES } from "./media.mjs";
export { StorageRefused, StorageStopped } from "./storage.mjs";
