// Screenshots of the page for review, against a node kept up by
// `E2E_KEEP=<port> node e2e/murmur.mjs`, which writes keep.json:
//
//   PLAYWRIGHT=<dir with playwright installed> node e2e/ui/shots.mjs <keep.json> <out dir>
//
// Reads need no wallet. "Connected" views remember an account the way
// Selfhold's window does, so the page shows it as yours; nothing is signed.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [keepFile, out = "shots"] = process.argv.slice(2);
const keep = JSON.parse(readFileSync(keepFile, "utf8"));
const { chromium } = createRequire(`${process.env.PLAYWRIGHT ?? process.cwd()}/`)("playwright");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const errors = [];
async function shot(name, hash, { as, dark = false, width = 900, height = 1100 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? "dark" : "light", deviceScaleFactor: 2 });
  if (as) await context.addInitScript((address) => localStorage.setItem("selfhold.web.address https://wallet.selfhold.app", address), as);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && errors.push(`${name}: ${message.text()}`));
  await page.goto(`${keep.app}${hash}`);
  await page.waitForFunction(() => !document.querySelector("main").hasAttribute("aria-busy") && !document.querySelector("main .status")?.textContent.includes("Reading"), null, { timeout: 60_000 });
  await page.waitForTimeout(2500); // counts arrive after the posts
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await context.close();
}

await shot("everyone", "#/everyone");
await shot("home-bob", "#/", { as: keep.bob });
await shot("person-carol", `#/${keep.carol}`, { as: keep.bob });
await shot("thread", `#/${keep.carol}/${keep.carolPost}`, { as: keep.bob });
await shot("home-bob-dark", "#/", { as: keep.bob, dark: true });
await shot("phone", "#/", { as: keep.bob, width: 390, height: 844 });
await shot("everyone-pictures", "#/everyone", { as: keep.alice });
// A picture added to a draft is kept by the storage sponsor, paid with work
// this page grinds in its own workers, then shown in the draft as kept.
{
  const context = await browser.newContext({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2 });
  await context.addInitScript((address) => localStorage.setItem("selfhold.web.address https://wallet.selfhold.app", address), keep.alice);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`attach: ${error.message}`));
  await page.goto(`${keep.app}#/`);
  const form = page.locator('form[data-compose="home"]');
  await form.locator("textarea").fill("Testing pictures from the page");
  await form.locator("input[data-pick]").setInputFiles(keep.upload);
  await form.locator('li[data-mid] input[data-alt]').fill("A gradient, uploaded from the page");
  await page.waitForFunction(() => document.querySelector('form[data-compose="home"] .note')?.textContent.includes("Kept for good"), null, { timeout: 180_000 });
  const posting = await form.locator('button[type="submit"]').isEnabled();
  await page.screenshot({ path: `${out}/attach-kept.png` });
  console.log(`attach: kept for good by the storage sponsor; Post ${posting ? "enabled" : "DISABLED"}`);
  await context.close();
}
await browser.close();
console.log(errors.length ? `page errors:\n${errors.join("\n")}` : "no page errors");
