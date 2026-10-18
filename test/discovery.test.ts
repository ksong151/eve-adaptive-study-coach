import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { discoverLinks, kindFromPath } from "../agent/lib/links.ts";
import { extractHtml, extractPdf } from "../agent/lib/extract.ts";
import { buildScope } from "../agent/lib/scope.ts";
import { fixture, makePdf, START_URL, FIXTURE_ORIGIN, LECTURE1_PAGES } from "./helpers.ts";

const built = buildScope(new URL(START_URL), []);
if ("error" in built) throw new Error(built.error);
const { scope } = built;

describe("link discovery", () => {
  const { pageTitle, links, truncated } = discoverLinks(fixture("index.html"), START_URL, scope, 100);
  const byUrl = new Map(links.map((l) => [l.url, l]));

  test("reads the page title", () => {
    assert.equal(pageTitle, "TOY 101: Caching Basics");
    assert.equal(truncated, 0);
  });

  test("adds the file name and heading trail for generic anchor text", () => {
    const slides = byUrl.get(`${START_URL}slides/lecture1.pdf`);
    assert.equal(slides?.title, "PDF (lecture1.pdf)");
    assert.equal(slides?.section, "TOY 101: Caching Basics › Week 1: Caches");
    assert.equal(slides?.kind, "pdf");
    assert.equal(slides?.status, "readable");
  });

  test("classifies every link without fetching", () => {
    assert.equal(byUrl.get(`${START_URL}notes/cache-basics.html`)?.status, "readable");
    assert.equal(byUrl.get(`${START_URL}files/starter.zip`)?.status, "unsupported_format");
    assert.equal(byUrl.get("https://ads.tracker-example.test/click?campaign=exam-prep")?.status, "external");
    assert.equal(byUrl.get(`${FIXTURE_ORIGIN}/other-course/notes.html`)?.status, "readable", "same site, other directory");
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

  test("generic link text gets the file name so identical labels stay distinct", () => {
    const page = `<a href="week-1.pdf">Slides</a> <a href="week-2.pdf">Slides</a> <a href="notes/">Notes</a> <a href="intro.pdf">Course intro</a>`;
    assert.deepEqual(discoverLinks(page, START_URL, scope, 10).links.map((l) => l.title), [
      "Slides (week-1.pdf)",
      "Slides (week-2.pdf)",
      "Notes",
      "Course intro",
    ]);
  });

  test("links inside HTML comments are not indexed", () => {
    const page = `<a href="published.pdf">Published</a><!-- <a href="unreleased.pdf">Not yet released</a> -->`;
    assert.deepEqual(discoverLinks(page, START_URL, scope, 10).links.map((l) => l.title), ["Published"]);
  });

  test("heading trail follows skipped and rising heading levels", () => {
    const page = `<h1>A</h1><h3>C</h3><a href="1.pdf">one</a><h2>B</h2><a href="2.pdf">two</a><h4>D</h4><a href="3.pdf">three</a>`;
    assert.deepEqual(discoverLinks(page, START_URL, scope, 10).links.map((l) => l.section), ["A › C", "A › B", "B › D"]);
  });

  test("falls back to the title attribute, then to an untitled label", () => {
    const page = `<a href="x/" title="Syllabus page"></a> <a href="y/"><img src="i.png"></a>`;
    assert.deepEqual(discoverLinks(page, START_URL, scope, 10).links.map((l) => l.title), ["Syllabus page", "(untitled link)"]);
  });

  test("labels video and login-only platforms as content unavailable", () => {
    const page = `<a href="https://www.youtube.com/watch?v=1">Recording</a> <a href="https://canvas.example.edu/courses/1">Canvas page</a>`;
    const [video, canvas] = discoverLinks(page, START_URL, scope, 10).links;
    assert.match(video?.note ?? "", /^Video: content unavailable/);
    assert.match(canvas?.note ?? "", /requires login: content unavailable/);
  });

  test("the link cap counts unique links only", () => {
    const page = `<a href="a.pdf">Alpha</a> <a href="a.pdf#p2">Alpha again</a> <a href="b.pdf">Beta</a> <a href="c.pdf">Gamma</a>`;
    const result = discoverLinks(page, START_URL, scope, 2);
    assert.deepEqual(result.links.map((l) => l.title), ["Alpha", "Beta"]);
    assert.equal(result.truncated, 1);
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
    assert.equal(kindFromPath("/a/readme.txt"), "other");
    assert.equal(kindFromPath("/a/notebook.ipynb"), "other");
    assert.equal(kindFromPath("/class/archive/cs/cs107/cs107.1272"), "html", "a dot in a directory name is not an extension");
    assert.equal(kindFromPath("/a/lecture.v2"), "html", "unknown extensions are left to the content-type check");
    assert.equal(kindFromPath("/a/slides.PPTX"), "other");
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

  test("pages that parse without a <body> leave out the doctype and <head>", () => {
    const page = `<!DOCTYPE html>\n<html><head><title>Toy page</title><meta charset="utf-8"></head>\n<div>Unclosed <p>content`;
    const result = extractHtml(page);
    assert.ok(result.ok && result.kind === "html");
    assert.equal(result.title, "Toy page");
    assert.doesNotMatch(result.text, /DOCTYPE|Toy page/);
    assert.match(result.text, /Unclosed\s+content/);
  });

  test("empty HTML is a failure, not empty content", () => {
    const result = extractHtml("<html><body><script>x()</script></body></html>");
    assert.equal(result.ok, false);
  });

  test("text PDF keeps page numbers", async () => {
    const result = await extractPdf(makePdf(LECTURE1_PAGES));
    assert.ok(result.ok && result.kind === "pdf");
    assert.equal(result.totalPages, 4);
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

  test("PDF at exactly the page limit is accepted", async () => {
    const result = await extractPdf(makePdf([["only text page"], ...Array.from({ length: 199 }, () => [])]));
    assert.ok(result.ok && result.kind === "pdf");
    assert.equal(result.totalPages, 200);
  });

  test("PDF over the page limit is rejected", async () => {
    const result = await extractPdf(makePdf(Array.from({ length: 201 }, () => [])));
    assert.equal(!result.ok && result.reason, "too_many_pages");
  });

  test("bytes without a PDF header are a parse failure", async () => {
    const result = await extractPdf(new TextEncoder().encode("<html>not a pdf</html>"));
    assert.equal(!result.ok && result.reason, "parse_failed");
  });

  test("corrupt PDF body is a parse failure", async () => {
    const result = await extractPdf(new TextEncoder().encode("%PDF-1.4\ngarbage that is not a pdf"));
    assert.equal(!result.ok && result.reason, "parse_failed");
  });
});

describe("test PDF generator", () => {
  // pdf.js repairs a broken cross-reference table, so extraction tests alone
  // would not notice a malformed fixture. Check the structure directly.
  test("xref offsets point at their objects and startxref points at the table", () => {
    const text = new TextDecoder().decode(makePdf(LECTURE1_PAGES));
    const xrefAt = Number(text.match(/startxref\n(\d+)\n%%EOF/)?.[1]);
    assert.ok(text.startsWith("xref", xrefAt), "startxref points at the xref keyword");
    const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.ok(entries.length > 3);
    entries.forEach((offset, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1}`));
  });
});
