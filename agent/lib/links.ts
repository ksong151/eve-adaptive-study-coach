// Discovers direct links on one course page and classifies each one.
// Only <a href> attributes are considered; URLs that appear in page text are
// never added. Nothing here fetches anything.
import { parse, type HTMLElement } from "node-html-parser";
import { checkPublicHttpsUrl, isInScope, type CourseScope } from "./scope.ts";

export type ResourceKind = "html" | "pdf" | "other";

export type ResourceStatus =
  /** In scope with a supported format; read_resource may fetch it. */
  | "readable"
  /** In scope, but a format this version does not extract (zip, notebook, image, ...). */
  | "unsupported_format"
  /** Same site, outside the approved path prefixes. Listed only. */
  | "outside_scope"
  /** Different site. Listed only; never fetched. */
  | "external"
  /** Not https, or a local/private address. Listed only. */
  | "blocked";

export interface DiscoveredLink {
  url: string;
  title: string;
  section: string;
  kind: ResourceKind;
  status: ResourceStatus;
  note: string;
}

const GENERIC_ANCHOR = /^(\[?\s*((lecture\s+)?(slides?|notes?)|pdf|link|here|zip|colab|video|html|download|handout|code|recording|view|open)\s*\]?|.{0,2})$/i;
const MAX_TITLE = 160;

/** Labels for common platforms whose content this version cannot read. */
const PLATFORM_NOTES: Array<[RegExp, string]> = [
  [/(^|\.)docs\.google\.com$|(^|\.)drive\.google\.com$|(^|\.)forms\.gle$/, "Google Docs/Drive/Forms: content unavailable (not fetched)."],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)panopto\.com$|(^|\.)vimeo\.com$|(^|\.)zoom\.us$/, "Video: content unavailable (not fetched)."],
  [/(^|\.)instructure\.com$|^canvas\.|(^|\.)gradescope\.com$|(^|\.)edstem\.org$|(^|\.)piazza\.com$/, "Course platform that usually requires login: content unavailable (not fetched)."],
];

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function kindFromPath(pathname: string): ResourceKind {
  const last = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  if (last === "" || !last.includes(".")) return "html";
  const ext = last.slice(last.lastIndexOf(".") + 1);
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  return "other";
}

function externalNote(host: string): string {
  for (const [pattern, note] of PLATFORM_NOTES) {
    if (pattern.test(host)) return note;
  }
  return "External site: listed only, content not fetched.";
}

/**
 * The link text, unless it is generic ("PDF", "Slides"). Then the file name
 * is added so links in a list of identical labels can still be told apart.
 */
function titleFor(anchor: HTMLElement, url: URL): string {
  const anchorText = collapse(anchor.text) || collapse(anchor.getAttribute("title") ?? "");
  if (anchorText && !GENERIC_ANCHOR.test(anchorText)) return truncate(anchorText, MAX_TITLE);
  const fileName = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (!fileName) return anchorText || "(untitled link)";
  return truncate(anchorText ? `${anchorText} (${fileName})` : fileName, MAX_TITLE);
}

function classify(url: URL, scope: CourseScope): Pick<DiscoveredLink, "kind" | "status" | "note"> {
  const kind = kindFromPath(url.pathname);
  const check = checkPublicHttpsUrl(url.href);
  if (!check.allowed) {
    return { kind, status: "blocked", note: `Not fetchable: ${check.detail}` };
  }
  if (isInScope(url, scope)) {
    return kind === "other"
      ? { kind, status: "unsupported_format", note: "Format not supported in this version: content unavailable." }
      : { kind, status: "readable", note: "" };
  }
  if (scope.entries.some((entry) => entry.origin === url.origin)) {
    return { kind, status: "outside_scope", note: "Same site but outside the approved course path: not fetched." };
  }
  return { kind, status: "external", note: externalNote(url.hostname.toLowerCase()) };
}

/**
 * Returns the direct links on `html`, de-duplicated, in document order, with
 * at most `maxLinks` entries. `truncated` counts links dropped by the cap.
 */
export function discoverLinks(
  html: string,
  pageUrl: string,
  scope: CourseScope,
  maxLinks: number,
): { pageTitle: string; links: DiscoveredLink[]; truncated: number } {
  const root = parse(html);
  root.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
  const pageTitle = collapse(root.querySelector("title")?.text ?? "") || collapse(root.querySelector("h1")?.text ?? "");

  const page = new URL(pageUrl);
  page.hash = "";
  const seen = new Set<string>([page.href]);
  const headings: string[] = [];
  const links: DiscoveredLink[] = [];
  let truncated = 0;

  for (const element of root.querySelectorAll("h1, h2, h3, h4, h5, h6, a[href]")) {
    const tag = element.tagName;
    if (tag !== "A") {
      const level = Number(tag.slice(1));
      headings.length = level - 1;
      headings[level - 1] = truncate(collapse(element.text), 80);
      continue;
    }
    const href = (element.getAttribute("href") ?? "").trim();
    if (href === "" || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, page);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    url.hash = "";
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    if (links.length >= maxLinks) {
      truncated++;
      continue;
    }
    links.push({
      url: url.href,
      title: titleFor(element, url),
      section: headings.filter(Boolean).slice(-2).join(" › "),
      ...classify(url, scope),
    });
  }
  return { pageTitle, links, truncated };
}
