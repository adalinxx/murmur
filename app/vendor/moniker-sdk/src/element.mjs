// <moniker-name address="…"> for any page: an account's verified @handle,
// beside the name your app knows it by, the handle linked to its Moniker
// page. Register it once with a Moniker from createMoniker:
//
//   defineMonikerName(moniker);
//   <moniker-name address="bafyrei…"></moniker-name>
//   <moniker-name address="bafyrei…" name="Dana Okafor" size="24" plain></moniker-name>   (no link)
//
// `name` is your app's own (a card on your chain); every @ and invisible
// control is dropped from it, so only a verified handle shows with an @. Style it from outside with CSS
// custom properties: --moniker-ink, --moniker-muted and --moniker-accent.
// The picture is the account's own pattern (accountIcon), the same in every
// app. Names in a feed share one read of the chain.

import { accountIcon, shortAccount } from "./records/account.mjs";
import { displayName } from "./records/names.mjs";

const style = `
  :host { display: inline-flex; align-items: center; gap: 0.5em; font: inherit; color: var(--moniker-ink, inherit); min-width: 0; }
  a { display: inline-flex; align-items: center; gap: 0.5em; color: inherit; text-decoration: none; min-width: 0; }
  a:hover .name { text-decoration: underline; }
  .photo { flex: none; display: inline-flex; border-radius: 22%; overflow: hidden; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .handle { color: var(--moniker-accent, #1f3fbf); font-family: ui-monospace, monospace; font-size: 0.9em; white-space: nowrap; }
`;

export function defineMonikerName(moniker, tag = "moniker-name") {
  if (customElements.get(tag)) return;

  // One read for every element drawn together: addresses gathered in a tick.
  let waiting = new Map(); // address → [resolve]
  let scheduled = false;
  function handleOf(address) {
    return new Promise((resolve) => {
      waiting.set(address, [...(waiting.get(address) ?? []), resolve]);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(async () => {
        const batch = waiting;
        waiting = new Map();
        scheduled = false;
        const addresses = [...batch.keys()];
        const found = await moniker.handlesOf(addresses).catch(() => addresses.map(() => undefined));
        addresses.forEach((address, i) => batch.get(address).forEach((done) => done(found[i])));
      });
    });
  }

  customElements.define(
    tag,
    class extends HTMLElement {
      static observedAttributes = ["address", "name", "size", "plain"];
      #drawn = 0;
      constructor() {
        super();
        this.attachShadow({ mode: "open" });
      }
      connectedCallback() {
        this.#draw();
      }
      attributeChangedCallback() {
        if (this.isConnected) this.#draw();
      }
      async #draw() {
        const ticket = ++this.#drawn;
        const address = this.getAttribute("address") ?? "";
        const size = Number(this.getAttribute("size")) || 28;
        const root = this.shadowRoot;
        root.replaceChildren(Object.assign(document.createElement("style"), { textContent: style }));
        if (!address) return;
        const handle = await handleOf(address);
        if (ticket !== this.#drawn) return;

        const cardName = displayName(this.getAttribute("name"));
        // Only a handle has a page.
        const outer =
          this.hasAttribute("plain") || !handle
            ? document.createElement("span")
            : Object.assign(document.createElement("a"), { href: moniker.pageURL(`@${handle}`), target: "_blank", rel: "noopener" });
        const photo = document.createElement("span");
        photo.className = "photo";
        photo.innerHTML = accountIcon(address, size);
        photo.setAttribute("aria-hidden", "true");
        const text = cardName ?? (handle ? `@${handle}` : shortAccount(address));
        outer.append(photo, Object.assign(document.createElement("span"), { className: "name", textContent: text }));
        if (handle && cardName) outer.append(Object.assign(document.createElement("span"), { className: "handle", textContent: `@${handle}` }));
        root.append(outer);
      }
    },
  );
}
