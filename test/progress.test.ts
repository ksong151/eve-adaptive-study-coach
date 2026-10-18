import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import { importCourse, readResource, type CourseIndex } from "../agent/lib/course.ts";
import { loadProgress, progressSummary, recordAttempt } from "../agent/lib/progress.ts";
import { resetData } from "../agent/lib/store.ts";
import { mockTransport, toyCourseRoutes, useTempDataDir, START_URL } from "./helpers.ts";

useTempDataDir();

describe("progress persistence", () => {
  let index: CourseIndex;
  let pdfId: string;
  let notesId: string;

  before(async () => {
    const mock = mockTransport(toyCourseRoutes());
    index = await importCourse({ startUrl: START_URL, additionalScopes: [] }, { transport: mock.transport });
    pdfId = index.resources.find((r) => r.url.endsWith("slides/lecture1.pdf"))!.id;
    notesId = index.resources.find((r) => r.url.endsWith("notes/cache-basics.html"))!.id;
    await readResource({ courseId: index.courseId, resourceId: pdfId }, { transport: mock.transport });
  });

  const base = () => ({
    courseId: index.courseId,
    concept: "Hit rate",
    question: "How is hit rate computed?",
    learnerAnswer: "misses divided by total",
    feedbackSummary: "That is the miss rate; hit rate uses hits.",
  });

  test("records an attempt citing a read PDF page and recommends a resource", async () => {
    const attempt = await recordAttempt({
      ...base(),
      attemptId: "call-1",
      observation: "needs_review",
      sources: [{ resourceId: pdfId, pages: [2] }],
      recommendedResourceId: notesId,
    });
    assert.equal(attempt.revisit, true);
    assert.equal(attempt.sources[0]?.url, `${START_URL}slides/lecture1.pdf`);
    assert.deepEqual(attempt.sources[0]?.pages, [2]);
    assert.equal(attempt.recommended?.resourceId, notesId);
    assert.equal(attempt.recommended?.contentRead, false, "recommended notes were not read");
  });

  test("the same tool call id is not recorded twice", async () => {
    await recordAttempt({ ...base(), attemptId: "call-1", observation: "needs_review", sources: [{ resourceId: pdfId }] });
    assert.equal((await loadProgress()).attempts.length, 1);
  });

  test("citing an unread resource is rejected", async () => {
    await assert.rejects(
      recordAttempt({ ...base(), attemptId: "call-2", observation: "demonstrated", sources: [{ resourceId: notesId }] }),
      /cannot be cited/,
    );
  });

  test("citing a page that was not extracted is rejected", async () => {
    await assert.rejects(
      recordAttempt({ ...base(), attemptId: "call-3", observation: "demonstrated", sources: [{ resourceId: pdfId, pages: [9] }] }),
      /no extracted page/,
    );
  });

  test("citing an image-only page with no extracted text is rejected", async () => {
    await assert.rejects(
      recordAttempt({ ...base(), attemptId: "call-3b", observation: "demonstrated", sources: [{ resourceId: pdfId, pages: [4] }] }),
      /no extracted page/,
    );
  });

  test("citing an external resource is rejected", async () => {
    const ad = index.resources.find((r) => r.status === "external")!;
    await assert.rejects(
      recordAttempt({ ...base(), attemptId: "call-4", observation: "demonstrated", sources: [{ resourceId: ad.id }] }),
      /cannot be cited/,
    );
  });

  test("summary keeps the latest observation per concept", async () => {
    let summary = await progressSummary(index.courseId);
    assert.deepEqual(summary.revisit.map((r) => r.concept), ["Hit rate"]);
    await recordAttempt({ ...base(), attemptId: "call-5", observation: "demonstrated", sources: [{ resourceId: pdfId, pages: [2] }] });
    summary = await progressSummary(index.courseId);
    assert.deepEqual(summary.revisit, []);
    assert.equal(summary.totalAttempts, 2);
  });

  test("progress survives a fresh load from disk and can be reset", async () => {
    assert.equal((await loadProgress()).attempts.length, 2);
    await resetData({ includeCourses: false });
    assert.equal((await loadProgress()).attempts.length, 0);
  });
});
