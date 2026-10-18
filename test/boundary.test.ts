// Website-boundary tests. Every case uses a mocked transport and asserts
// which requests were attempted, so prohibited URLs are proven to be
// rejected before any request is sent.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boundedFetch, FetchRejected } from "../agent/lib/fetcher.ts";
import { buildScope, checkFetchAllowed, checkPublicHttpsUrl, type CourseScope } from "../agent/lib/scope.ts";
import { html, mockTransport, redirect, START_URL, FIXTURE_ORIGIN } from "./helpers.ts";

const scope: CourseScope = { entries: [{ origin: FIXTURE_ORIGIN, pathPrefix: "/toy101/" }] };
const htmlLimits = { maxBytes: 1024 * 1024, timeoutMs: 2_000, maxRedirects: 3 };

async function rejects(url: string, routes: Parameters<typeof mockTransport>[0] = {}, limits = htmlLimits) {
  const mock = mockTransport(routes);
  const error = await boundedFetch(url, scope, { transport: mock.transport, limits, allowedTypes: ["text/html"] }).then(
    () => assert.fail(`expected ${url} to be rejected`),
    (e: unknown) => e,
  );
  assert.ok(error instanceof FetchRejected, `expected FetchRejected, got ${String(error)}`);
  return { error, requests: mock.requests };
}

describe("URL policy", () => {
  test("accepts an in-scope https URL", () => {
    assert.equal(checkFetchAllowed(`${START_URL}notes/a.html`, scope).allowed, true);
  });

  for (const [url, reason] of [
    ["http://toy-course.example/toy101/a.html", "not_https"],
    ["ftp://toy-course.example/toy101/a.txt", "not_https"],
    ["file:///etc/passwd", "not_https"],
    ["https://user:pw@toy-course.example/toy101/", "credentials_in_url"],
    ["https://toy-course.example:8443/toy101/", "nonstandard_port"],
    ["https://127.0.0.1/toy101/", "private_or_local_host"],
    ["https://2130706433/toy101/", "private_or_local_host"],
    ["https://169.254.169.254/latest/meta-data/", "private_or_local_host"],
    ["https://10.1.2.3/", "private_or_local_host"],
    ["https://192.168.0.1/", "private_or_local_host"],
    ["https://[::1]/", "private_or_local_host"],
    ["https://[::ffff:127.0.0.1]/", "private_or_local_host"],
    ["https://[::ffff:7f00:1]/", "private_or_local_host"],
    ["https://0x7f.1/", "private_or_local_host"],
    ["https://100.64.0.1/", "private_or_local_host"],
    ["https://[fe80::1]/", "private_or_local_host"],
    ["https://localhost/toy101/", "private_or_local_host"],
    ["https://printer.local/", "private_or_local_host"],
    ["https://intranet/", "private_or_local_host"],
    ["https://localhost./x", "private_or_local_host"],
    ["https://foo.localhost./", "private_or_local_host"],
    ["https://printer.local./", "private_or_local_host"],
    ["https://intranet./", "private_or_local_host"],
    ["https://toy-course.example/other-course/notes.html", "outside_scope"],
    ["https://toy-course.example/toy101/../other-course/x.html", "outside_scope"],
    ["https://toy-course.example/toy101-evil/x.html", "outside_scope"],
    ["https://toy-course.example.evil.test/toy101/", "outside_scope"],
    ["not a url", "invalid_url"],
  ] as const) {
    test(`rejects ${url} as ${reason}`, () => {
      const decision = checkFetchAllowed(url, scope);
      assert.equal(decision.allowed, false);
      assert.equal(!decision.allowed && decision.reason, reason);
    });
  }

  test("additional scopes cannot be a site root", () => {
    const result = buildScope(new URL(START_URL), ["https://files.example-cdn.test/"]);
    assert.ok("error" in result);
    assert.match(result.error, /site root/);
  });

  test("additional scopes must themselves be public https URLs", () => {
    assert.ok("error" in buildScope(new URL(START_URL), ["https://127.0.0.1/files/"]));
    assert.ok("error" in buildScope(new URL(START_URL), ["http://toy-course.example/files/"]));
  });

  test("the default scope is the start page's whole site, and nothing else", () => {
    const result = buildScope(new URL(START_URL), []);
    assert.ok("scope" in result);
    assert.equal(checkFetchAllowed("https://toy-course.example/archive/toy101/a.pdf", result.scope).allowed, true);
    assert.equal(checkFetchAllowed("https://sub.toy-course.example/toy101/a.pdf", result.scope).allowed, false, "other subdomain");
    assert.equal(checkFetchAllowed("https://ads.tracker-example.test/x", result.scope).allowed, false);
  });

  test("an approved other-site directory is added as its own narrow entry", () => {
    const result = buildScope(new URL(START_URL), ["https://files.example-cdn.test/toy101/"]);
    assert.ok("scope" in result);
    assert.equal(checkFetchAllowed("https://files.example-cdn.test/toy101/a.pdf", result.scope).allowed, true);
    assert.equal(checkFetchAllowed("https://files.example-cdn.test/other/a.pdf", result.scope).allowed, false);
  });

  test("checkPublicHttpsUrl drops fragments", () => {
    const decision = checkPublicHttpsUrl(`${START_URL}a.html#section`);
    assert.ok(decision.allowed);
    assert.equal(decision.url.href, `${START_URL}a.html`);
  });
});

describe("bounded fetcher (mocked HTTP)", () => {
  test("external ad link is rejected before any request", async () => {
    const { error, requests } = await rejects("https://ads.tracker-example.test/click?campaign=exam-prep");
    assert.equal(error.reason, "outside_scope");
    assert.deepEqual(requests, []);
  });

  test("local/private URLs are rejected before any request", async () => {
    for (const url of ["https://127.0.0.1/admin", "https://169.254.169.254/latest/meta-data/", "https://localhost/toy101/"]) {
      const { error, requests } = await rejects(url);
      assert.equal(error.reason, "private_or_local_host", url);
      assert.deepEqual(requests, [], url);
    }
  });

  test("off-site redirect is rejected and its destination is never requested", async () => {
    const start = `${START_URL}notes/moved.html`;
    const { error, requests } = await rejects(start, {
      [start]: redirect("https://ads.tracker-example.test/landing"),
    });
    assert.equal(error.reason, "redirect_rejected");
    assert.deepEqual(requests, [start]);
  });

  test("redirect to a private address is rejected before it is requested", async () => {
    const start = `${START_URL}notes/moved.html`;
    const { error, requests } = await rejects(start, { [start]: redirect("https://127.0.0.1/toy101/") });
    assert.equal(error.reason, "redirect_rejected");
    assert.deepEqual(requests, [start]);
  });

  test("redirect downgrade to http is rejected", async () => {
    const start = `${START_URL}a.html`;
    const { error, requests } = await rejects(start, { [start]: redirect("http://toy-course.example/toy101/a.html", 301) });
    assert.equal(error.reason, "redirect_rejected");
    assert.deepEqual(requests, [start]);
  });

  test("in-scope redirects are followed, relative Location included", async () => {
    const start = `${START_URL}old.html`;
    const mock = mockTransport({
      [start]: redirect("new.html", 301),
      [`${START_URL}new.html`]: html("<p>moved here</p>"),
    });
    const doc = await boundedFetch(start, scope, { transport: mock.transport, limits: htmlLimits, allowedTypes: ["text/html"] });
    assert.equal(doc.finalUrl, `${START_URL}new.html`);
    assert.deepEqual(mock.requests, [start, `${START_URL}new.html`]);
  });

  test("excessive redirects are rejected after the limit", async () => {
    const start = `${START_URL}loop.html`;
    const { error, requests } = await rejects(start, { [start]: redirect(start) });
    assert.equal(error.reason, "too_many_redirects");
    assert.equal(requests.length, htmlLimits.maxRedirects + 1);
  });

  test("redirect without Location is rejected", async () => {
    const start = `${START_URL}a.html`;
    const { error } = await rejects(start, { [start]: () => new Response(null, { status: 302 }) });
    assert.equal(error.reason, "redirect_invalid");
  });

  test("unsupported content type is rejected", async () => {
    const start = `${START_URL}a.html`;
    const { error } = await rejects(start, {
      [start]: () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(error.reason, "unsupported_content_type");
  });

  test("declared oversized response is rejected without reading it", async () => {
    const start = `${START_URL}a.html`;
    const { error } = await rejects(start, {
      [start]: () => new Response("x", { status: 200, headers: { "content-type": "text/html", "content-length": "999999999" } }),
    });
    assert.equal(error.reason, "response_too_large");
  });

  test("streamed body over the byte limit is rejected", async () => {
    const start = `${START_URL}a.html`;
    const { error } = await rejects(
      start,
      { [start]: () => new Response("y".repeat(5000), { status: 200, headers: { "content-type": "text/html" } }) },
      { ...htmlLimits, maxBytes: 1000 },
    );
    assert.equal(error.reason, "response_too_large");
  });

  test("HTTP errors are reported, not treated as content", async () => {
    const start = `${START_URL}missing.html`;
    const { error } = await rejects(start, { [start]: () => new Response("nope", { status: 404 }) });
    assert.equal(error.reason, "http_error");
  });

  test("slow responses time out", async () => {
    const start = `${START_URL}slow.html`;
    const mock = mockTransport({});
    const slow: typeof mock.transport = (_url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const error = await boundedFetch(start, scope, {
      transport: slow,
      limits: { ...htmlLimits, timeoutMs: 50 },
      allowedTypes: ["text/html"],
    }).catch((e: unknown) => e);
    assert.ok(error instanceof FetchRejected);
    assert.equal(error.reason, "timeout");
  });

  test("protocol-relative redirect to another host is rejected before it is requested", async () => {
    const start = `${START_URL}a.html`;
    const { error, requests } = await rejects(start, { [start]: redirect("//evil.example/steal") });
    assert.equal(error.reason, "redirect_rejected");
    assert.deepEqual(requests, [start]);
  });

  test("a redirect into an approved other-site directory is followed", async () => {
    const built = buildScope(new URL(START_URL), ["https://files.example-cdn.test/toy101/"]);
    assert.ok("scope" in built);
    const start = `${START_URL}a.pdf`;
    const target = "https://files.example-cdn.test/toy101/a.pdf";
    const mock = mockTransport({
      [start]: redirect(target),
      [target]: () => new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    const doc = await boundedFetch(start, built.scope, { transport: mock.transport, limits: htmlLimits, allowedTypes: ["application/pdf"] });
    assert.equal(doc.finalUrl, target);
    assert.deepEqual(mock.requests, [start, target]);
  });

  test("XHTML is accepted as HTML", async () => {
    const start = `${START_URL}a.xhtml`;
    const mock = mockTransport({
      [start]: () => new Response("<p>x</p>", { status: 200, headers: { "content-type": "application/xhtml+xml; charset=utf-8" } }),
    });
    const doc = await boundedFetch(start, scope, { transport: mock.transport, limits: htmlLimits, allowedTypes: ["text/html"] });
    assert.equal(doc.contentType, "text/html");
  });
});
