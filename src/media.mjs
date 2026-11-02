// Pictures live off the chain. A post names each by CID. The bytes are one
// Volume of one block, DAG-CBOR `{ type, bytes }`, as Stoa and Moniker keep
// files. A storage sponsor keeps it for good, paid with the poster's work
// (./storage.mjs), and serves it from its node. Any reader fetches it from a
// node's `/volumes/<cid>` and checks it against the CID; the node that served
// it is trusted for nothing.
import { MEDIA_TYPES } from "./records/murmur.mjs";

/** The most bytes one picture may hold: one Volume, as a storage sponsor takes it, with room for its framing. */
export const MAX_MEDIA_BYTES = (1 << 20) - 256;

const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** The Volume for a picture, as `POST /store` and `POST /pins` take it: `{ cid, entries }`. */
export function mediaVolume(sdk, type, bytes) {
  if (!MEDIA_TYPES.includes(type)) throw new Error("A PNG, JPEG, GIF, WebP or AVIF picture, please.");
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error("That picture is over 1 MB.");
  const block = sdk.encodeDagCbor({ bytes, type });
  const cid = sdk.cidV1DagCbor(block);
  return { cid, entries: { [cid]: toBase64(block) } };
}

/**
 * The picture in a block read for `cid`: `{ type, bytes }`, or undefined when
 * it is not a picture this client shows. The block has been checked against
 * `cid` by the Volume client that read it.
 */
export function readMedia(sdk, block) {
  let file;
  try {
    file = sdk.decodeDagCbor(block);
  } catch {
    return undefined;
  }
  if (typeof file?.type !== "string" || !MEDIA_TYPES.includes(file.type) || !(file.bytes instanceof Uint8Array)) return undefined;
  if (file.bytes.length > MAX_MEDIA_BYTES) return undefined;
  return { type: file.type, bytes: file.bytes };
}
