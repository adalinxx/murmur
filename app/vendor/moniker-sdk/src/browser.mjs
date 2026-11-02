// Moniker in a browser page, with the Lattice SDK included:
//
//   import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.3.0/src/browser.mjs";
//   const moniker = createMoniker();          // or createMoniker({ nodes, chain })
//   defineMonikerName(moniker);               // then <moniker-name address="…">
//   defineHandlePicker(moniker);              // then <moniker-handle-picker>, and picker.open() from a click
import * as sdk from "../vendor/lattice-sdk.js";
import { createMoniker as monikerOver } from "./index.mjs";

export * from "./index.mjs";
export { defineMonikerName } from "./element.mjs";
export { defineHandlePicker } from "./picker.mjs";
export const createMoniker = (options = {}) => monikerOver({ sdk, ...options });
