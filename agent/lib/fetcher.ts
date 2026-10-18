// Read-only, bounded HTTP GET restricted to an approved course scope.
//
// Two layers guard every request:
// 1. checkFetchAllowed (this repo): https only, approved origin + path prefix,
//    no private/loopback IP literals or local hostnames. It runs before the
//    first request and before each redirect hop is requested.
// 2. guardedFetch (Vercel's guarded-fetch, production transport only): DNS
//    resolution check and connect-time IP pinning against private networks.
import { guardedFetch } from "guarded-fetch";
import { checkFetchAllowed, type CourseScope } from "./scope.ts";

export type SupportedContentType = "text/html" | "application/pdf";

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

/** Sends one GET request without following redirects. Injected in tests. */
export type Transport = (url: URL, init: { signal: AbortSignal }) => Promise<Response>;

export type FetchFailure =
  | "invalid_url"
  | "not_https"
  | "credentials_in_url"
  | "nonstandard_port"
  | "private_or_local_host"
  | "outside_scope"
  | "redirect_rejected"
  | "redirect_invalid"
  | "too_many_redirects"
  | "http_error"
  | "unsupported_content_type"
  | "response_too_large"
  | "timeout"
  | "network_error";

export class FetchRejected extends Error {
  readonly reason: FetchFailure;
  readonly url: string;
  constructor(reason: FetchFailure, url: string, message: string) {
    super(message);
    this.name = "FetchRejected";
    this.reason = reason;
    this.url = url;
  }
}

export interface FetchedDocument {
  finalUrl: string;
  contentType: SupportedContentType;
  bytes: Uint8Array;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const CONTENT_TYPE_ALIASES: Record<string, SupportedContentType> = {
  "text/html": "text/html",
  "application/xhtml+xml": "text/html",
  "application/pdf": "application/pdf",
};

const USER_AGENT =
  "eve-adaptive-study-coach/0.1 (read-only study aid; https://github.com/ksong151/eve-adaptive-study-coach)";

/** Production transport: one GET through guarded-fetch, redirects returned unfollowed. */
export const guardedTransport: Transport = (url, { signal }) =>
  guardedFetch(url, {
    method: "GET",
    headers: { accept: "text/html, application/pdf", "user-agent": USER_AGENT },
    followRedirects: false,
    httpsOnly: true,
    allowedHosts: [url.hostname],
    signal,
  });

export async function boundedFetch(
  rawUrl: string,
  scope: CourseScope,
  options: {
    transport: Transport;
    limits: FetchLimits;
    allowedTypes: readonly SupportedContentType[];
    signal?: AbortSignal;
  },
): Promise<FetchedDocument> {
  const { transport, limits, allowedTypes } = options;
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;

  let current = rawUrl;
  for (let redirects = 0; ; redirects++) {
    const decision = checkFetchAllowed(current, scope);
    if (!decision.allowed) {
      const reason: FetchFailure = redirects === 0 ? decision.reason : "redirect_rejected";
      const prefix = redirects === 0 ? "" : `Redirect from ${rawUrl} was not followed. `;
      throw new FetchRejected(reason, current, prefix + decision.detail);
    }
    const url = decision.url;

    let response: Response;
    try {
      response = await transport(url, { signal });
    } catch (error) {
      if (signal.aborted) throw new FetchRejected("timeout", url.href, `Request to ${url.href} timed out.`);
      const message = error instanceof Error ? error.message : String(error);
      throw new FetchRejected("network_error", url.href, `Request to ${url.href} failed: ${message}`);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (redirects >= limits.maxRedirects) {
        throw new FetchRejected("too_many_redirects", url.href, `More than ${limits.maxRedirects} redirects starting at ${rawUrl}.`);
      }
      const location = response.headers.get("location");
      let next: URL;
      try {
        if (!location) throw new Error("missing Location header");
        next = new URL(location, url);
      } catch {
        throw new FetchRejected("redirect_invalid", url.href, `Redirect from ${url.href} had no valid Location header.`);
      }
      current = next.href;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new FetchRejected("http_error", url.href, `${url.href} returned HTTP ${response.status}.`);
    }

    const declared = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const contentType = CONTENT_TYPE_ALIASES[declared];
    if (!contentType || !allowedTypes.includes(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new FetchRejected(
        "unsupported_content_type",
        url.href,
        `${url.href} has content type "${declared || "none"}"; expected ${allowedTypes.join(" or ")}.`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > limits.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new FetchRejected("response_too_large", url.href, `${url.href} is ${declaredLength} bytes; limit is ${limits.maxBytes}.`);
    }

    const bytes = await readBounded(response, limits.maxBytes, signal, url.href);
    return { finalUrl: url.href, contentType, bytes };
  }
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal, url: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // An aborted request can error the body stream before the abort listener runs.
        if (signal.aborted) throw new FetchRejected("timeout", url, `Reading ${url} timed out.`);
        const message = error instanceof Error ? error.message : String(error);
        throw new FetchRejected("network_error", url, `Reading ${url} failed: ${message}`);
      }
      const { done, value } = chunk;
      if (signal.aborted) throw new FetchRejected("timeout", url, `Reading ${url} timed out.`);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FetchRejected("response_too_large", url, `${url} exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
