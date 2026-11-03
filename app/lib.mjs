// The page's pure parts: routes, how text and times are shown, and who a
// search names. Nothing here reads a chain.
import { isAddress, isId } from "../src/records/murmur.mjs";

const isHandle = (text) => typeof text === "string" && /^[a-z0-9_]+$/.test(text);

/**
 * Where a hash points:
 *   #/                     home: { view: "home" }
 *   #/everyone             every post: { view: "everyone" }
 *   #/@<h> or #/<account>  a person: { view: "person", who }
 *   #/<account>/<id>       a post and its thread: { view: "post", author, id }
 */
export function parseRoute(hash) {
  let path;
  try {
    path = decodeURIComponent(String(hash ?? "").replace(/^#\/?/, ""));
  } catch {
    return { view: "missing" };
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { view: "home" };
  if (parts.length === 1 && ["everyone", "following", "notifications"].includes(parts[0])) return { view: parts[0] };
  if (parts.length === 1) {
    const who = parseWho(parts[0]);
    return who ? { view: "person", who } : { view: "missing" };
  }
  // A tab's name is shorter than any post id, so the two never meet.
  if (parts.length === 2 && PROFILE_TABS.includes(parts[1])) {
    const who = parseWho(parts[0]);
    return who ? { view: "person", who, tab: parts[1] } : { view: "missing" };
  }
  if (parts.length === 2 && isAddress(parts[0]) && isId(parts[1])) return { view: "post", author: parts[0], id: parts[1] };
  return { view: "missing" };
}

/** Whom a search or link names: `{ account }`, `{ handle }`, or null. */
export function parseWho(text) {
  const typed = String(text ?? "").trim();
  if (isAddress(typed)) return { account: typed };
  const handle = typed.replace(/^@/, "").toLowerCase();
  return isHandle(handle) ? { handle } : null;
}

export const postPath = ({ author, id }) => `#/${author}/${id}`;
/** A profile's tabs past its first, Posts: `#/<who>/<tab>`. */
export const PROFILE_TABS = ["replies", "media", "likes"];
export const personPath = (account, handle) => `#/${handle ? `@${handle}` : account}`;

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export { esc };

/**
 * A post's text as HTML: escaped, with line breaks kept, http(s) links and
 * @handles linked. Nothing a post says becomes markup of its own.
 */
export function renderText(text) {
  const pattern = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(^|[^a-z0-9_@])@([a-z0-9_]{1,30})(?![a-z0-9_])/gi;
  let html = "";
  let at = 0;
  for (const match of String(text).matchAll(pattern)) {
    html += esc(text.slice(at, match.index));
    if (match[1]) {
      html += `<a href="${esc(match[1])}" target="_blank" rel="noopener noreferrer nofollow">${esc(match[1].replace(/^https?:\/\//, ""))}</a>`;
    } else {
      const handle = match[3].toLowerCase();
      html += `${esc(match[2])}<a href="#/@${handle}">@${esc(match[3])}</a>`;
    }
    at = match.index + match[0].length;
  }
  return html + esc(text.slice(at));
}

/** A post's time as a timeline shows it: "now", "5m", "3h", "Oct 2", or "Oct 2, 2025" in another year. */
export function ago(time, now = Date.now()) {
  if (time === undefined) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(!sameYear && { year: "numeric" }) });
}

/** The full time, for a post's own page and a tooltip. */
export const when = (time) => (time === undefined ? "" : new Date(time).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }));

/** "1 reply", "2 replies"; nothing for 0. */
export const count = (n) => (n > 0 ? n.toLocaleString("en-US") : "");

/** Characters left in a draft of `max`, counted as a person sees them. */
export const left = (text, max = 280) => max - [...String(text)].length;
