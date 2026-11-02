import assert from "node:assert/strict";
import { test } from "node:test";
import { createMoniker, DEFAULTS, discover } from "../src/index.mjs";

// Enough of the Lattice SDK for the clients to start; reads stop at the tip.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const chain = ["Nexus", "moniker"];

/** Answers fetches from `routes` ({ "origin/path": () => Response }) and records each URL asked. */
function serve(routes) {
  const asked = [];
  globalThis.fetch = async (url) => {
    const { origin, pathname } = new URL(url);
    asked.push(String(url));
    const route = routes[`${origin}${pathname}`];
    if (!route) throw new TypeError("fetch failed");
    return route();
  };
  return asked;
}
const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });

test("Moniker's hosts are found through Nexus's seeds, not named", () => {
  assert.equal("nodes" in DEFAULTS, false);
  assert.ok(DEFAULTS.seeds.length > 0 && DEFAULTS.seeds.every((seed) => seed.startsWith("https://")));
});

test("the first seed that lists hosts names them, as https origins, once each", async () => {
  const asked = serve({
    "https://down.test/api/chain/endpoints": json({ error: "unavailable" }, 503),
    "https://empty.test/api/chain/endpoints": json({ chainPath: chain, endpoints: [] }),
    "https://nexus.test/api/chain/endpoints": json({
      chainPath: chain,
      endpoints: ["https://a.test/", "http://plain.test", "not a url", "https://b.test", "https://a.test"],
    }),
    "https://later.test/api/chain/endpoints": json({ endpoints: ["https://c.test"] }),
  });
  const seeds = ["https://down.test", "https://gone.test", "https://empty.test", "https://nexus.test", "https://later.test"];
  assert.deepEqual(await discover(chain, seeds), ["https://a.test", "https://b.test"]);
  assert.equal(asked.length, 4, "no seed after the one that answered");
  assert.equal(new URL(asked[0]).searchParams.get("chainPath"), "Nexus/moniker");
});

test("no seed listing a host is an error that says so", async () => {
  serve({ "https://nexus.test/api/chain/endpoints": json({ endpoints: ["http://plain.test"] }) });
  await assert.rejects(discover(chain, ["https://nexus.test", "https://gone.test"]), /Nexus lists no host for Nexus\/moniker/);
});

test("named nodes are read without asking Nexus", async () => {
  const asked = serve({});
  const moniker = createMoniker({ sdk, nodes: ["https://mine.test"], seeds: ["https://nexus.test"] });
  assert.deepEqual(await moniker.hosts(), ["https://mine.test"]);
  await assert.rejects(moniker.state(), /No host is serving/);
  assert.ok(asked.every((url) => url.startsWith("https://mine.test/")));
});

test("hosts are found once, and asked of Nexus again after none of them answers", async () => {
  let listed = ["https://a.test"];
  const asked = serve({
    "https://nexus.test/api/chain/endpoints": () => json({ endpoints: listed })(),
    "https://b.test/api/block/latest": json({ error: "unavailable" }, 503),
  });
  const moniker = createMoniker({ sdk, seeds: ["https://nexus.test"], freshFor: 0 });
  const discoveries = () => asked.filter((url) => url.includes("/api/chain/endpoints")).length;
  assert.deepEqual(await moniker.hosts(), ["https://a.test"]);
  assert.deepEqual(await moniker.hosts(), ["https://a.test"]);
  assert.equal(discoveries(), 1);
  listed = ["https://b.test"];
  await assert.rejects(moniker.state(), /No host is serving Nexus\/moniker/);
  assert.deepEqual(await moniker.hosts(), ["https://b.test"], "the listing as it is now");
  assert.equal(discoveries(), 2);
});

test("a failed discovery is tried again on the next read", async () => {
  serve({});
  const moniker = createMoniker({ sdk, seeds: ["https://nexus.test"] });
  await assert.rejects(moniker.hosts(), /Nexus lists no host/);
  serve({ "https://nexus.test/api/chain/endpoints": json({ endpoints: ["https://a.test"] }) });
  assert.deepEqual(await moniker.hosts(), ["https://a.test"]);
});
