// URL policy for the course boundary. Everything here is pure (no network,
// no DNS) so it can run before any request and be tested deterministically.
import { isIP } from "node:net";
import { isSafeIpAddress } from "guarded-fetch";

/** One approved location: an https origin plus a path prefix ending in "/". */
export interface ScopeEntry {
  origin: string;
  pathPrefix: string;
}

/** The set of locations the importer and reader may request. */
export interface CourseScope {
  entries: ScopeEntry[];
}

export type RejectReason =
  | "invalid_url"
  | "not_https"
  | "credentials_in_url"
  | "nonstandard_port"
  | "private_or_local_host"
  | "outside_scope";

export type UrlDecision =
  | { allowed: true; url: URL }
  | { allowed: false; reason: RejectReason; detail: string };

const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * Checks the properties every fetchable URL must have, independent of scope:
 * https, no embedded credentials, default port, and a public, dotted hostname
 * that is not a private or loopback IP literal.
 */
export function checkPublicHttpsUrl(raw: string): UrlDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "invalid_url", detail: `Not a valid absolute URL: ${raw}` };
  }
  if (url.protocol !== "https:") {
    return { allowed: false, reason: "not_https", detail: `Only https URLs are allowed (got ${url.protocol}).` };
  }
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, reason: "credentials_in_url", detail: "URLs with embedded credentials are not allowed." };
  }
  if (url.port !== "") {
    return { allowed: false, reason: "nonstandard_port", detail: `Only the default https port is allowed (got ${url.port}).` };
  }
  const host = url.hostname.toLowerCase();
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bareHost) !== 0) {
    if (!isSafeIpAddress(bareHost)) {
      return { allowed: false, reason: "private_or_local_host", detail: `Private, loopback, or link-local address: ${bareHost}` };
    }
  } else if (
    host === "localhost" ||
    LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    !host.includes(".")
  ) {
    return { allowed: false, reason: "private_or_local_host", detail: `Local or single-label hostname: ${host}` };
  }
  url.hash = "";
  return { allowed: true, url };
}

/** The directory part of a URL path: "/a/b/page.html" -> "/a/b/", "/a/b/" -> "/a/b/". */
export function directoryPrefix(url: URL): string {
  const path = url.pathname;
  return path.slice(0, path.lastIndexOf("/") + 1) || "/";
}

export function isInScope(url: URL, scope: CourseScope): boolean {
  return scope.entries.some(
    (entry) => url.origin === entry.origin && url.pathname.startsWith(entry.pathPrefix),
  );
}

/** Full check used immediately before every request, including each redirect hop. */
export function checkFetchAllowed(raw: string, scope: CourseScope): UrlDecision {
  const decision = checkPublicHttpsUrl(raw);
  if (!decision.allowed) return decision;
  if (!isInScope(decision.url, scope)) {
    return {
      allowed: false,
      reason: "outside_scope",
      detail: `${decision.url.href} is outside the approved course scope (${describeScope(scope)}).`,
    };
  }
  return decision;
}

/**
 * Builds a scope from the start page plus any additional prefixes the learner
 * approved. The start page contributes its whole site (origin): only links
 * found on that page are ever indexed, so this widens which of those links
 * can be read, not what can be discovered. Additional prefixes, for other
 * sites, must be valid public https URLs and must not be a site root.
 */
export function buildScope(
  startUrl: URL,
  additionalPrefixes: readonly string[],
): { scope: CourseScope } | { error: string } {
  const entries: ScopeEntry[] = [{ origin: startUrl.origin, pathPrefix: "/" }];
  for (const raw of additionalPrefixes) {
    const decision = checkPublicHttpsUrl(raw);
    if (!decision.allowed) return { error: `Additional scope ${raw} rejected: ${decision.detail}` };
    const prefix = directoryPrefix(decision.url);
    if (prefix === "/") {
      return { error: `Additional scope ${raw} is a site root. Approve a specific directory instead.` };
    }
    const entry = { origin: decision.url.origin, pathPrefix: prefix };
    if (!entries.some((e) => e.origin === entry.origin && e.pathPrefix === entry.pathPrefix)) {
      entries.push(entry);
    }
  }
  return { scope: { entries } };
}

export function describeScope(scope: CourseScope): string {
  return scope.entries.map((e) => `${e.origin}${e.pathPrefix}`).join(", ");
}
