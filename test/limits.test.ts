// Per-course budgets, HTML paging, and the same-site boundary. Each case builds its own
// small course from mocked routes.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { courseIdFor, importCourse, readResource, listCourses, loadCourse, LIMITS, type CourseIndex } from "../agent/lib/course.ts";
import { recordAttempt } from "../agent/lib/progress.ts";
import { html, makePdf, mockTransport, pdf, redirect, useTempDataDir, START_URL, FIXTURE_ORIGIN, type Route } from "./helpers.ts";
import { EXTRACT_LIMITS } from "../agent/lib/extract.ts";

// Cached text is shared by URL, so each test gets an empty data directory.
beforeEach(() => {
  useTempDataDir();
});

const original = { fetches: LIMITS.maxFetchesPerCourse, bytes: LIMITS.maxBytesPerCourse, chars: LIMITS.maxCharsPerRead };
const originalTextChars = EXTRACT_LIMITS.maxTextChars;
afterEach(() => {
  LIMITS.maxFetchesPerCourse = original.fetches;
  LIMITS.maxBytesPerCourse = original.bytes;
  LIMITS.maxCharsPerRead = original.chars;
  EXTRACT_LIMITS.maxTextChars = originalTextChars;
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

describe("same-site boundary", () => {
  test("a redirect elsewhere on the course site is followed", async () => {
    const { index, mock, id } = await course(`<a href="moved.html">Moved notes</a>`, {
      [`${START_URL}moved.html`]: redirect(`${FIXTURE_ORIGIN}/archive/toy101/notes.html`),
      [`${FIXTURE_ORIGIN}/archive/toy101/notes.html`]: html("<p>archived notes</p>"),
    });
    const result = await read(index, id("moved.html"), mock.transport);
    assert.ok(result.read);
    assert.match(result.text ?? "", /archived notes/);
  });

  test("a redirect to another site, even a subdomain, is rejected before it is requested", async () => {
    const target = "https://sub.toy-course.example/toy101/notes.html";
    const { index, mock, id } = await course(`<a href="moved.html">Moved notes</a>`, {
      [`${START_URL}moved.html`]: redirect(target),
    });
    const result = await read(index, id("moved.html"), mock.transport);
    assert.equal(!result.read && result.reason, "redirect_rejected");
    assert.ok(!mock.requests.includes(target));
  });
});

describe("failures, retries, and re-import", () => {
  test("a network error is not recorded, so the next read retries and succeeds", async () => {
    let calls = 0;
    const { index, mock, id } = await course(`<a href="a.pdf">Alpha</a>`, {
      [`${START_URL}a.pdf`]: () => {
        calls++;
        if (calls === 1) throw new Error("connection reset");
        return pdf(makePdf([["page a"]]))();
      },
    });
    const first = await read(index, id("a.pdf"), mock.transport);
    assert.equal(!first.read && first.reason, "network_error");
    const second = await read(await loadCourse(index.courseId), id("a.pdf"), mock.transport);
    assert.equal(second.read, true);
  });

  test("an HTTP 404 is recorded and not fetched again", async () => {
    const { index, mock, id } = await course(`<a href="gone.pdf">Gone</a>`, {
      [`${START_URL}gone.pdf`]: () => new Response("missing", { status: 404 }),
    });
    const first = await read(index, id("gone.pdf"), mock.transport);
    assert.equal(!first.read && first.reason, "http_error");
    const count = mock.requests.length;
    const again = await read(await loadCourse(index.courseId), id("gone.pdf"), mock.transport);
    assert.equal(!again.read && again.reason, "http_error");
    assert.equal(mock.requests.length, count);
  });

  test("PDF reads stop at the character cap and continue with nextPage", async () => {
    const { index, mock, id } = await course(`<a href="a.pdf">Alpha</a>`, {
      [`${START_URL}a.pdf`]: pdf(makePdf([["first page text"], ["second page text"], ["third page text"]])),
    });
    LIMITS.maxCharsPerRead = 35; // fits two short pages, not three
    const first = await read(index, id("a.pdf"), mock.transport);
    assert.ok(first.read);
    assert.deepEqual(first.pages?.map((p) => p.page), [1, 2]);
    assert.equal(first.nextPage, 3);
    const rest = await readResource({ courseId: index.courseId, resourceId: id("a.pdf"), page: 3 }, { transport: mock.transport });
    assert.ok(rest.read);
    assert.deepEqual(rest.pages?.map((p) => p.page), [3]);
    assert.equal(rest.nextPage, undefined);
  });

  test("successful reads add to the byte budget, and re-import resets it", async () => {
    const { index, mock, id } = await course(`<a href="a.pdf">Alpha</a>`, { [`${START_URL}a.pdf`]: pdf(makePdf([["page a"]])) });
    const before = index.usage.bytes;
    await read(index, id("a.pdf"), mock.transport);
    const after = await loadCourse(index.courseId);
    assert.equal(after.usage.fetches, 2);
    assert.ok(after.usage.bytes > before);
    const again = await importCourse({ startUrl: START_URL, additionalScopes: [] }, { transport: mock.transport });
    assert.equal(again.usage.fetches, 1);
  });

  test("listCourses is empty before anything is imported", async () => {
    assert.deepEqual(await listCourses(), []);
  });
});

describe("concurrent tool calls", () => {
  test("parallel writes to the same file all succeed", async () => {
    const { writeJson, readJson, dataDir } = await import("../agent/lib/store.ts");
    const file = `${dataDir()}/parallel.json`;
    await Promise.all([1, 2, 3, 4, 5].map((n) => writeJson(file, { n })));
    assert.ok(typeof (await readJson<{ n: number }>(file))?.n === "number");
  });

  test("parallel reads cannot overspend the read budget", async () => {
    const files = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"];
    const routes = Object.fromEntries(files.map((f) => [`${START_URL}${f}`, pdf(makePdf([[`page ${f}`]]))]));
    const { index, mock, id } = await course(files.map((f) => `<a href="${f}">File ${f}</a>`).join(" "), routes);
    LIMITS.maxFetchesPerCourse = 3; // the import used one, so two reads remain
    const results = await Promise.all(files.map((f) => read(index, id(f), mock.transport)));
    assert.equal(results.filter((r) => r.read).length, 2);
    assert.equal(results.filter((r) => !r.read && r.reason === "fetch_budget_exhausted").length, 3);
    assert.equal(mock.requests.length, 3, "start page plus two reads");
    assert.equal((await loadCourse(index.courseId)).usage.fetches, 3);
  });
});

describe("reading long and truncated text", () => {
  test("a PDF page longer than one read continues inside the same page", async () => {
    const { index, mock, id } = await course(`<a href="a.pdf">Alpha</a>`, {
      [`${START_URL}a.pdf`]: pdf(makePdf([["first page text that is long"], ["second page"]])),
    });
    LIMITS.maxCharsPerRead = 10;
    const one = await read(index, id("a.pdf"), mock.transport);
    assert.ok(one.read);
    assert.deepEqual(one.pages, [{ page: 1, text: "first page" }]);
    assert.equal(one.nextPage, 1);
    assert.equal(one.nextOffset, 10);
    const two = await readResource({ courseId: index.courseId, resourceId: id("a.pdf"), page: 1, offset: 10 }, { transport: mock.transport });
    assert.ok(two.read);
    assert.equal(two.pages?.[0]?.text, " text that");
    const rest = await readResource({ courseId: index.courseId, resourceId: id("a.pdf"), page: 1, offset: 20 }, { transport: mock.transport });
    assert.ok(rest.read);
    assert.deepEqual(rest.pages, [{ page: 1, text: " is long" }]);
    assert.equal(rest.nextPage, 2, "page 2 does not fit in the remaining room");
    assert.equal(rest.nextOffset, undefined);
  });

  test("reaching the end of text cut by the size limit returns a notice", async () => {
    EXTRACT_LIMITS.maxTextChars = 30;
    const { index, mock, id } = await course(`<a href="a.pdf">Alpha</a>`, {
      [`${START_URL}a.pdf`]: pdf(makePdf([["page one text here"], ["page two text here"], ["page three text"]])),
    });
    const result = await read(index, id("a.pdf"), mock.transport);
    assert.ok(result.read);
    assert.equal(result.nextPage, undefined);
    assert.match(result.notice ?? "", /stopped at page 2 of 3.*not read/);
  });

  test("a complete read has no notice", async () => {
    const { index, mock, id } = await course(`<a href="a.pdf">Alpha</a>`, { [`${START_URL}a.pdf`]: pdf(makePdf([["short"]])) });
    const result = await read(index, id("a.pdf"), mock.transport);
    assert.ok(result.read);
    assert.equal(result.notice, undefined);
  });
});

describe("budget accounting and retries", () => {
  test("bytes downloaded before a size rejection still count, and that rejection is retried later", async () => {
    const big = () => new Response("y".repeat(5000), { status: 200, headers: { "content-type": "application/pdf" } });
    const { index, mock, id } = await course(`<a href="big.pdf">Big</a>`, { [`${START_URL}big.pdf`]: big });
    LIMITS.maxBytesPerCourse = index.usage.bytes + 50; // the budget, not the PDF limit, causes the rejection
    const result = await read(index, id("big.pdf"), mock.transport);
    assert.equal(!result.read && result.reason, "response_too_large");
    const after = await loadCourse(index.courseId);
    assert.ok(after.usage.bytes > index.usage.bytes + 50, "the downloaded bytes were counted");
    assert.equal(after.resources.find((r) => r.id === id("big.pdf"))?.extraction, undefined, "not recorded as a permanent failure");
  });

  test("server errors and rate limiting are retried on the next read", async () => {
    for (const status of [503, 429]) {
      useTempDataDir();
      let calls = 0;
      const { index, mock, id } = await course(`<a href="a.pdf">Alpha</a>`, {
        [`${START_URL}a.pdf`]: () => (++calls === 1 ? new Response("busy", { status }) : pdf(makePdf([["page a"]]))()),
      });
      const first = await read(index, id("a.pdf"), mock.transport);
      assert.equal(!first.read && first.reason, "http_error", String(status));
      const second = await read(await loadCourse(index.courseId), id("a.pdf"), mock.transport);
      assert.equal(second.read, true, `${status} is retried`);
    }
  });
});

describe("cached text and course ids", () => {
  test("text cached through another course's approved scope is not reused or citable", async () => {
    const cdn = "https://cdn.example-files.test/x/";
    const routes = {
      [`${FIXTURE_ORIGIN}/a/`]: html(`<a href="/shared/moved.html">Moved notes</a>`),
      [`${FIXTURE_ORIGIN}/b/`]: html(`<a href="/shared/moved.html">Moved notes</a>`),
      [`${FIXTURE_ORIGIN}/shared/moved.html`]: redirect(`${cdn}notes.html`),
      [`${cdn}notes.html`]: html("<p>notes served from the approved cdn directory</p>"),
    };
    const mock = mockTransport(routes);
    const a = await importCourse({ startUrl: `${FIXTURE_ORIGIN}/a/`, additionalScopes: [cdn] }, { transport: mock.transport });
    const b = await importCourse({ startUrl: `${FIXTURE_ORIGIN}/b/`, additionalScopes: [] }, { transport: mock.transport });
    const idIn = (index: CourseIndex) => index.resources.find((r) => r.url.endsWith("/shared/moved.html"))!.id;

    assert.equal((await read(a, idIn(a), mock.transport)).read, true, "course A may follow the redirect");
    const inB = await read(b, idIn(b), mock.transport);
    assert.equal(!inB.read && inB.reason, "redirect_rejected", "course B ignores A's cached text and rechecks");
    await assert.rejects(
      recordAttempt({ attemptId: "c-1", courseId: b.courseId, concept: "c", question: "q", learnerAnswer: "a", observation: "unclear", feedbackSummary: "f", sources: [{ resourceId: idIn(b) }] }),
      /cannot be cited/,
    );
  });

  test("course ids stay distinct for locations that slug the same, and stay stable", () => {
    const id = (u: string) => courseIdFor(new URL(u));
    assert.notEqual(id("https://a.b.edu/cs-1/"), id("https://a-b.edu/cs/1/"));
    assert.notEqual(id("https://site.test/CS107/"), id("https://site.test/cs107/"));
    const long = "https://site.test/" + "x".repeat(90);
    assert.notEqual(id(`${long}/one/`), id(`${long}/two/`));
    assert.equal(id("https://site.test/c/index.html"), id("https://site.test/c/"), "same directory, same id");
    for (const u of ["https://a.b.edu/cs-1/", `${long}/one/`]) assert.match(id(u), /^[a-z0-9-]{1,80}$/);
  });
});
