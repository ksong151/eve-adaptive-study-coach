import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import { importCourse, readResource, loadCourse, listCourses, CourseError, EMPTY_PAGE, type CourseIndex } from "../agent/lib/course.ts";
import { mockTransport, toyCourseRoutes, useTempDataDir, START_URL } from "./helpers.ts";

useTempDataDir();

function idFor(index: CourseIndex, path: string): string {
  const r = index.resources.find((res) => res.url === `${START_URL}${path}`);
  assert.ok(r, `fixture resource ${path} missing`);
  return r.id;
}

describe("course import and reading (mocked HTTP)", () => {
  let index: CourseIndex;
  let mock: ReturnType<typeof mockTransport>;

  before(async () => {
    mock = mockTransport(toyCourseRoutes());
    index = await importCourse({ startUrl: START_URL, additionalScopes: [] }, { transport: mock.transport });
  });

  test("import makes exactly one request: the start page", () => {
    assert.deepEqual(mock.requests, [START_URL]);
    assert.equal(index.courseId, "toy-course-example-toy101");
    assert.equal(index.resources[0]?.id, "r1");
    assert.equal(index.resources[0]?.extraction?.status, "extracted");
  });

  test("the index is persisted and listed", async () => {
    assert.equal((await loadCourse(index.courseId)).resources.length, index.resources.length);
    assert.deepEqual((await listCourses()).map((c) => c.courseId), [index.courseId]);
  });

  test("reads the start page from cache without another request", async () => {
    const before = mock.requests.length;
    const result = await readResource({ courseId: index.courseId, resourceId: "r1" }, { transport: mock.transport });
    assert.ok(result.read);
    assert.match(result.text ?? "", /An original, made-up course/);
    assert.equal(mock.requests.length, before);
  });

  test("reads a PDF with page numbers, then pages from cache", async () => {
    const id = idFor(index, "slides/lecture1.pdf");
    const first = await readResource({ courseId: index.courseId, resourceId: id }, { transport: mock.transport });
    assert.ok(first.read && first.kind === "pdf");
    assert.deepEqual(first.pages?.map((p) => p.page), [1, 2, 3, 4]);
    assert.equal(first.pages?.[3]?.text, EMPTY_PAGE, "image-only page is labeled, not silently empty");
    const count = mock.requests.length;
    const fromPage = await readResource({ courseId: index.courseId, resourceId: id, page: 3 }, { transport: mock.transport });
    assert.ok(fromPage.read);
    assert.deepEqual(fromPage.pages?.map((p) => p.page), [3, 4]);
    assert.equal(mock.requests.length, count, "cached read makes no request");
  });

  test("external ad link: listed, never requested, reported as not read", async () => {
    const ad = index.resources.find((r) => r.url.startsWith("https://ads.tracker-example.test/"));
    assert.ok(ad);
    const result = await readResource({ courseId: index.courseId, resourceId: ad.id }, { transport: mock.transport });
    assert.equal(result.read, false);
    assert.equal(!result.read && result.reason, "external");
    assert.ok(!mock.requests.some((u) => u.includes("tracker-example")));
  });

  test("blocked and outside-scope links are never requested", async () => {
    for (const r of index.resources.filter((res) => res.status === "blocked" || res.status === "outside_scope")) {
      const result = await readResource({ courseId: index.courseId, resourceId: r.id }, { transport: mock.transport });
      assert.equal(result.read, false, r.url);
    }
    assert.ok(!mock.requests.some((u) => u.includes("127.0.0.1") || u.includes("/other-course/") || u.startsWith("http:")));
  });

  test("off-site redirect: the redirect target is never requested and the failure is recorded", async () => {
    const id = idFor(index, "notes/moved.html");
    const result = await readResource({ courseId: index.courseId, resourceId: id }, { transport: mock.transport });
    assert.equal(!result.read && result.reason, "redirect_rejected");
    assert.ok(!mock.requests.includes("https://ads.tracker-example.test/landing"));
    const saved = await loadCourse(index.courseId);
    assert.equal(saved.resources.find((r) => r.id === id)?.extraction?.status, "failed");
  });

  test("scanned, broken, oversized, and unsupported resources report why they were not read", async () => {
    const cases: Array<[string, string]> = [
      ["slides/scanned.pdf", "no_text"],
      ["handouts/broken.pdf", "parse_failed"],
      ["slides/huge.pdf", "response_too_large"],
      ["notes/loop.html", "too_many_redirects"],
      ["files/starter.zip", "unsupported_format"],
    ];
    for (const [path, reason] of cases) {
      const result = await readResource({ courseId: index.courseId, resourceId: idFor(index, path) }, { transport: mock.transport });
      assert.equal(result.read, false, path);
      assert.equal(!result.read && result.reason, reason, path);
    }
  });

  test("a recorded failure is not re-fetched", async () => {
    const count = mock.requests.length;
    await readResource({ courseId: index.courseId, resourceId: idFor(index, "slides/scanned.pdf") }, { transport: mock.transport });
    assert.equal(mock.requests.length, count);
  });

  test("unknown resource ids and course ids are rejected", async () => {
    await assert.rejects(readResource({ courseId: index.courseId, resourceId: "r999" }, { transport: mock.transport }), CourseError);
    await assert.rejects(readResource({ courseId: "../../etc", resourceId: "r1" }, { transport: mock.transport }), /Invalid course id/);
    await assert.rejects(readResource({ courseId: "never-imported", resourceId: "r1" }, { transport: mock.transport }), /Import it first/);
  });
});

describe("import input validation", () => {
  test("private start page is rejected without a request", async () => {
    const mock = mockTransport({});
    await assert.rejects(importCourse({ startUrl: "https://127.0.0.1/course/", additionalScopes: [] }, { transport: mock.transport }), /Start page rejected/);
    assert.deepEqual(mock.requests, []);
  });

  test("site-root additional scope is rejected without a request", async () => {
    const mock = mockTransport({});
    await assert.rejects(
      importCourse({ startUrl: START_URL, additionalScopes: ["https://toy-course.example/"] }, { transport: mock.transport }),
      /site root/,
    );
    assert.deepEqual(mock.requests, []);
  });

  test("a start page that redirects off-site is not imported", async () => {
    const start = "https://toy-course.example/redirecting/";
    const mock = mockTransport({ [start]: () => new Response(null, { status: 302, headers: { location: "https://ads.tracker-example.test/" } }) });
    await assert.rejects(importCourse({ startUrl: start, additionalScopes: [] }, { transport: mock.transport }), /Could not import/);
    assert.deepEqual(mock.requests, [start]);
  });
});
