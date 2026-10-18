import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { discoverLinks, kindFromPath } from "../agent/lib/links.ts";
import { extractHtml, extractPdf } from "../agent/lib/extract.ts";
import { fixture, makePdf, START_URL, FIXTURE_ORIGIN, LECTURE1_PAGES } from "./helpers.ts";

const scope = { entries: [{ origin: FIXTURE_ORIGIN, pathPrefix: "/toy101/" }] };

describe("link discovery", () => {
  const { pageTitle, links, truncated } = discoverLinks(fixture("index.html"), START_URL, scope, 100);
  const byUrl = new Map(links.map((l) => [l.url, l]));

  test("reads the page title", () => {
    assert.equal(pageTitle, "TOY 101: Caching Basics");
    assert.equal(truncated, 0);
  });

  test("uses list-item context and heading for generic anchor text", () => {
    const slides = byUrl.get(`${START_URL}slides/lecture1.pdf`);
    assert.equal(slides?.title, "Lecture 1 slides (PDF)");
    assert.equal(slides?.section, "TOY 101: Caching Basics › Week 1: Caches");
    assert.equal(slides?.kind, "pdf");
    assert.equal(slides?.status, "readable");
  });

  test("classifies every link without fetching", () => {
    assert.equal(byUrl.get(`${START_URL}notes/cache-basics.html`)?.status, "readable");
    assert.equal(byUrl.get(`${START_URL}files/starter.zip`)?.status, "unsupported_format");
    assert.equal(byUrl.get("https://ads.tracker-example.test/click?campaign=exam-prep")?.status, "external");
    assert.equal(byUrl.get(`${FIXTURE_ORIGIN}/other-course/notes.html`)?.status, "outside_scope");
    assert.equal(byUrl.get("http://toy-course.example/toy101/insecure.html")?.status, "blocked");
    assert.equal(byUrl.get("https://127.0.0.1/admin")?.status, "blocked");
    const doc = byUrl.get("https://docs.google.com/document/d/toy-doc/edit");
    assert.equal(doc?.status, "external");
    assert.match(doc?.note ?? "", /content unavailable/);
  });

  test("ignores fragments, mailto, scripts, stylesheets, and URLs in plain text", () => {
    const urls = links.map((l) => l.url);
    assert.ok(!urls.some((u) => u.startsWith("mailto:")));
    assert.ok(!urls.some((u) => u.includes("evil.example")), "URL in page text must not be indexed");
    assert.ok(!urls.some((u) => u.endsWith("pixel.js") || u.endsWith("style.css")));
    assert.equal(urls.filter((u) => u === `${START_URL}notes/cache-basics.html`).length, 1, "fragment duplicate is merged");
  });

  test("div-based layouts take the label from the cell, not sibling links", () => {
    const page = `<div class="row"><div class="col">Reliability from unreliability <a href="r.pdf"><img src="i.png"> Slides</a> <a href="https://docs.google.com/x">Lecture notes</a></div></div>`;
    const [slides, notes] = discoverLinks(page, START_URL, scope, 10).links;
    assert.equal(slides?.title, "Reliability from unreliability (Slides)");
    assert.equal(notes?.title, "Reliability from unreliability (Lecture notes)");
  });

  test("links inside HTML comments are not indexed", () => {
    const page = `<a href="published.pdf">Published</a><!-- <a href="unreleased.pdf">Not yet released</a> -->`;
    assert.deepEqual(discoverLinks(page, START_URL, scope, 10).links.map((l) => l.title), ["Published"]);
  });

  test("caps the number of links and reports how many were dropped", () => {
    const capped = discoverLinks(fixture("index.html"), START_URL, scope, 3);
    assert.equal(capped.links.length, 3);
    assert.ok(capped.truncated > 0);
  });

  test("infers kind from the path", () => {
    assert.equal(kindFromPath("/a/"), "html");
    assert.equal(kindFromPath("/a/lab_faq.html"), "html");
    assert.equal(kindFromPath("/a/syllabus"), "html");
    assert.equal(kindFromPath("/a/check0.PDF"), "pdf");
    assert.equal(kindFromPath("/a/readme.txt"), "text");
    assert.equal(kindFromPath("/a/notebook.ipynb"), "other");
  });
});

describe("extraction", () => {
  test("HTML keeps text and drops navigation", () => {
    const result = extractHtml(fixture("notes/cache-basics.html"));
    assert.ok(result.ok && result.kind === "html");
    assert.equal(result.title, "Cache basics notes");
    assert.match(result.text, /evicts the entry that has gone unused the longest/);
    assert.doesNotMatch(result.text, /Back to TOY 101/);
  });

  test("empty HTML is a failure, not empty content", () => {
    const result = extractHtml("<html><body><script>x()</script></body></html>");
    assert.equal(result.ok, false);
  });

  test("text PDF keeps page numbers", async () => {
    const result = await extractPdf(makePdf(LECTURE1_PAGES, "TOY 101 Lecture 1"));
    assert.ok(result.ok && result.kind === "pdf");
    assert.equal(result.totalPages, 4);
    assert.equal(result.title, "TOY 101 Lecture 1");
    assert.deepEqual(result.pages.map((p) => p.page), [1, 2, 3, 4]);
    assert.equal(result.pages[3]!.text, "", "image-only page has no text");
    assert.match(result.pages[1]!.text, /Hit rate = hits \/ \(hits \+ misses\)/);
    assert.match(result.pages[2]!.text, /Write-back defers/);
  });

  test("PDF without a text layer is reported as no_text", async () => {
    const result = await extractPdf(makePdf([[], []]));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "no_text");
  });

  test("bytes without a PDF header are a parse failure", async () => {
    const result = await extractPdf(new TextEncoder().encode("<html>not a pdf</html>"));
    assert.equal(!result.ok && result.reason, "parse_failed");
  });

  test("corrupt PDF body is a parse failure", async () => {
    const result = await extractPdf(new TextEncoder().encode("%PDF-1.4\ngarbage that is not a pdf"));
    assert.equal(result.ok, false);
  });
});
