// Per-course budgets, HTML paging, and scope hints. Each case builds its own
// small course from mocked routes.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { importCourse, readResource, summarizeIndex, LIMITS, type CourseIndex } from "../agent/lib/course.ts";
import { html, makePdf, mockTransport, pdf, useTempDataDir, START_URL, FIXTURE_ORIGIN, type Route } from "./helpers.ts";

// Cached text is shared by URL, so each test gets an empty data directory.
beforeEach(() => {
  useTempDataDir();
});

const original = { fetches: LIMITS.maxFetchesPerCourse, bytes: LIMITS.maxBytesPerCourse };
afterEach(() => {
  LIMITS.maxFetchesPerCourse = original.fetches;
  LIMITS.maxBytesPerCourse = original.bytes;
});

async function course(startHtml: string, routes: Record<string, Route> = {}) {
  const mock = mockTransport({ [START_URL]: html(startHtml), ...routes });
  const index = await importCourse({ startUrl: START_URL, additionalScopes: [] }, { transport: mock.transport });
  const id = (file: string) => index.resources.find((r) => r.url.endsWith(file))!.id;
  return { index, mock, id };
}

const read = (index: CourseIndex, resourceId: string, transport: ReturnType<typeof mockTransport>["transport"], offset?: number) =>
  readResource({ courseId: index.courseId, resourceId, offset }, { transport });

describe("per-course budgets", () => {
  const twoPdfs = `<a href="a.pdf">A</a> <a href="b.pdf">B</a>`;
  const routes = { [`${START_URL}a.pdf`]: pdf(makePdf([["page a"]])), [`${START_URL}b.pdf`]: pdf(makePdf([["page b"]])) };

  test("stops fetching once the read budget is used, without sending a request", async () => {
    LIMITS.maxFetchesPerCourse = 2; // the import itself used one
    const { index, mock, id } = await course(twoPdfs, routes);
    assert.equal((await read(index, id("a.pdf"), mock.transport)).read, true);
    const second = await read(index, id("b.pdf"), mock.transport);
    assert.equal(!second.read && second.reason, "fetch_budget_exhausted");
    assert.ok(!mock.requests.includes(`${START_URL}b.pdf`));
  });

  test("stops fetching once the byte budget is used, without sending a request", async () => {
    LIMITS.maxBytesPerCourse = 10; // smaller than the start page already downloaded
    const { index, mock, id } = await course(twoPdfs, routes);
    const result = await read(index, id("a.pdf"), mock.transport);
    assert.equal(!result.read && result.reason, "byte_budget_exhausted");
    assert.deepEqual(mock.requests, [START_URL]);
  });

  test("caps a single response at the bytes left in the budget", async () => {
    const { index, mock, id } = await course(twoPdfs, routes);
    LIMITS.maxBytesPerCourse = index.usage.bytes + 50; // less than one PDF
    const result = await read(index, id("a.pdf"), mock.transport);
    assert.equal(!result.read && result.reason, "response_too_large");
  });
});

describe("HTML paging", () => {
  test("long pages are returned in slices with a continuation offset", async () => {
    const body = `<p>${"word ".repeat(3_000)}</p><p>THE END</p>`; // about 15,000 chars: two slices
    const { index, mock, id } = await course(`<a href="long.html">Long notes</a>`, { [`${START_URL}long.html`]: html(body) });
    const first = await read(index, id("long.html"), mock.transport);
    assert.ok(first.read);
    assert.equal(first.text?.length, LIMITS.maxCharsPerRead);
    assert.equal(first.nextOffset, LIMITS.maxCharsPerRead);
    const rest = await read(index, id("long.html"), mock.transport, first.nextOffset);
    assert.ok(rest.read);
    assert.match(rest.text ?? "", /THE END$/);
    assert.equal(rest.nextOffset, undefined);
    assert.equal((first.text?.length ?? 0) + (rest.text?.length ?? 0), first.totalChars);
  });
});

describe("scope hints", () => {
  test("groups same-site links outside scope by their top two directories", async () => {
    const page = [
      `<a href="${FIXTURE_ORIGIN}/winter/assets/files/l1.pdf">1</a>`,
      `<a href="${FIXTURE_ORIGIN}/winter/assets/img/x.png">2</a>`,
      `<a href="${FIXTURE_ORIGIN}/bank/q.pdf">3</a>`,
      `<a href="https://elsewhere.example/a.pdf">external, not a hint</a>`,
    ].join(" ");
    const { index } = await course(page);
    assert.deepEqual(summarizeIndex(index).outsideScopePrefixes, [
      { prefix: `${FIXTURE_ORIGIN}/winter/assets/`, links: 2 },
      { prefix: `${FIXTURE_ORIGIN}/bank/`, links: 1 },
    ]);
  });
});
