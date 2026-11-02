// A picture's Volume: made, read back, and refused when it isn't a picture.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { MAX_MEDIA_BYTES, mediaVolume, readMedia } from "../src/media.mjs";

const block = (volume) => Uint8Array.from(atob(volume.entries[volume.cid]), (c) => c.charCodeAt(0));

test("a picture is one block, named by its CID, read back as it was", () => {
  const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
  const volume = mediaVolume(sdk, "image/png", bytes);
  assert.ok(sdk.verifyCID(volume.cid, block(volume)));
  assert.deepEqual(readMedia(sdk, block(volume)), { type: "image/png", bytes });
  // The same file is the same CID, from anyone.
  assert.equal(mediaVolume(sdk, "image/png", bytes.slice()).cid, volume.cid);
});

test("only pictures, and none over the limit", () => {
  assert.throws(() => mediaVolume(sdk, "image/svg+xml", new Uint8Array(4)));
  assert.throws(() => mediaVolume(sdk, "image/png", new Uint8Array(MAX_MEDIA_BYTES + 1)));
  assert.doesNotThrow(() => mediaVolume(sdk, "image/jpeg", new Uint8Array(MAX_MEDIA_BYTES)));
  assert.equal(readMedia(sdk, sdk.encodeDagCbor({ type: "image/svg+xml", bytes: new Uint8Array(4) })), undefined);
  assert.equal(readMedia(sdk, sdk.encodeDagCbor({ type: "image/png", bytes: "text" })), undefined);
  assert.equal(readMedia(sdk, Uint8Array.of(1, 2, 3)), undefined);
});
