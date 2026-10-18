// Shared test utilities. No test touches the network: every request goes
// through mockTransport, which records it and fails on unknown URLs.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Transport } from "../agent/lib/fetcher.ts";

export const FIXTURE_ORIGIN = "https://toy-course.example";
export const START_URL = `${FIXTURE_ORIGIN}/toy101/`;
const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "toy-course");

/** Points the store at a fresh temporary directory for this test file. */
export function useTempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "study-coach-test-"));
  process.env.STUDY_COACH_DATA_DIR = dir;
  return dir;
}

export function fixture(relative: string): string {
  return readFileSync(path.join(FIXTURE_DIR, relative), "utf8");
}

/**
 * Builds a minimal valid PDF. Each entry in `pages` is a list of text lines;
 * an empty list makes a page with a drawing but no text layer.
 */
export function makePdf(pages: string[][]): Uint8Array<ArrayBuffer> {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const pageCount = pages.length;
  // Object numbers: 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const pageObj = (i: number) => 4 + i * 2;
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const stream =
      lines.length === 0
        ? "0 0 m 200 200 l S"
        : `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${escape(l)}) Tj T*`).join(" ")} ET`;
    objects[pageObj(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`;
    objects[pageObj(i) + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(out);
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

export type Route = () => Response;

export interface MockTransport {
  transport: Transport;
  /** Every URL the transport was asked to request, in order. */
  requests: string[];
}

/** A transport that serves only `routes`; any other request fails the test loudly. */
export function mockTransport(routes: Record<string, Route>): MockTransport {
  const requests: string[] = [];
  const transport: Transport = async (url, { signal }) => {
    requests.push(url.href);
    if (signal.aborted) throw signal.reason;
    const route = routes[url.href];
    if (!route) throw new Error(`Unexpected request in test: ${url.href}`);
    return route();
  };
  return { transport, requests };
}

export const html = (body: string): Route => () =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

export const pdf = (bytes: Uint8Array<ArrayBuffer>): Route => () =>
  new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });

export const redirect = (location: string, status = 302): Route => () =>
  new Response(null, { status, headers: { location } });

export const LECTURE1_PAGES = [
  ["Lecture 1: Why caches work", "Programs reuse recently accessed data (temporal locality)."],
  ["Hit rate", "Hit rate = hits / (hits + misses).", "A higher hit rate means fewer slow trips to the backing store."],
  ["Write policies", "Write-through updates the backing store on every write.", "Write-back defers the update until eviction."],
  [],
];

/** Routes for the whole toy course fixture. */
export function toyCourseRoutes(): Record<string, Route> {
  return {
    [START_URL]: html(fixture("index.html")),
    [`${START_URL}notes/cache-basics.html`]: html(fixture("notes/cache-basics.html")),
    [`${START_URL}slides/lecture1.pdf`]: pdf(makePdf(LECTURE1_PAGES)),
    [`${START_URL}slides/scanned.pdf`]: pdf(makePdf([[], []])),
    [`${START_URL}handouts/broken.pdf`]: () =>
      new Response("<html>not a pdf</html>", { status: 200, headers: { "content-type": "application/pdf" } }),
    [`${START_URL}notes/moved.html`]: redirect("https://ads.tracker-example.test/landing"),
    [`${START_URL}notes/loop.html`]: redirect(`${START_URL}notes/loop.html`),
    [`${START_URL}slides/huge.pdf`]: () =>
      new Response("x", { status: 200, headers: { "content-type": "application/pdf", "content-length": String(500 * 1024 * 1024) } }),
  };
}
