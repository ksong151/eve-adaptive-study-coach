import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import { importCourse, readResource, type CourseIndex } from "../agent/lib/course.ts";
import { loadProgress, progressSummary, recordAttempt } from "../agent/lib/progress.ts";
import { resetProgress } from "../agent/lib/store.ts";
import { html, mockTransport, toyCourseRoutes, useTempDataDir, START_URL, FIXTURE_ORIGIN } from "./helpers.ts";

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
    await resetProgress();
    assert.equal((await loadProgress()).attempts.length, 0);
  });
});

describe("progress details", () => {
  let index: CourseIndex;
  let notesId: string;
  const attempt = (id: string, extra: Record<string, unknown>) => ({
    attemptId: id,
    courseId: index.courseId,
    concept: "Cache hits",
    question: "What is a cache hit?",
    learnerAnswer: "answer",
    observation: "needs_review" as const,
    feedbackSummary: "feedback",
    sources: [{ resourceId: "r1" }],
    ...extra,
  });

  before(async () => {
    await resetProgress();
    const mock = mockTransport(toyCourseRoutes());
    index = await importCourse({ startUrl: START_URL, additionalScopes: [] }, { transport: mock.transport });
    notesId = index.resources.find((r) => r.url.endsWith("notes/cache-basics.html"))!.id;
    await readResource({ courseId: index.courseId, resourceId: notesId }, { transport: mock.transport });
  });

  test("the start page can be cited, since the import extracted it", async () => {
    const saved = await recordAttempt(attempt("d-1", {}));
    assert.equal(saved.sources[0]?.resourceId, "r1");
  });

  test("page numbers on an HTML resource are rejected", async () => {
    await assert.rejects(recordAttempt(attempt("d-2", { sources: [{ resourceId: notesId, pages: [1] }] })), /no extracted page/);
  });

  test("a replayed call id returns the original record unchanged", async () => {
    const replay = await recordAttempt(attempt("d-1", { observation: "demonstrated", concept: "Something else" }));
    assert.equal(replay.observation, "needs_review");
    assert.equal(replay.concept, "Cache hits");
  });

  test("concepts that differ only in case are merged", async () => {
    await recordAttempt(attempt("d-3", { concept: "CACHE HITS", observation: "demonstrated" }));
    const summary = await progressSummary(index.courseId);
    assert.deepEqual(summary.revisit, []);
  });

  test("the summary can be filtered to one course", async () => {
    const otherStart = `${FIXTURE_ORIGIN}/toy102/`;
    const mock = mockTransport({ [otherStart]: html("<title>TOY 102</title><p>Other course</p>") });
    const other = await importCourse({ startUrl: otherStart, additionalScopes: [] }, { transport: mock.transport });
    await recordAttempt({ ...attempt("d-4", {}), courseId: other.courseId, concept: "Other topic" });
    assert.deepEqual((await progressSummary(other.courseId)).revisit.map((r) => r.concept), ["Other topic"]);
    assert.ok(!(await progressSummary(index.courseId)).revisit.some((r) => r.concept === "Other topic"));
    assert.equal((await progressSummary()).totalAttempts, 3);
  });
});

describe("concurrent saves", () => {
  test("parallel record_attempt calls are all kept", async () => {
    await resetProgress();
    const mock = mockTransport(toyCourseRoutes());
    const index = await importCourse({ startUrl: START_URL, additionalScopes: [] }, { transport: mock.transport });
    const base = { courseId: index.courseId, question: "q", learnerAnswer: "a", observation: "unclear" as const, feedbackSummary: "f", sources: [{ resourceId: "r1" }] };
    await Promise.all(["p-1", "p-2", "p-3"].map((id, i) => recordAttempt({ ...base, attemptId: id, concept: `Concept ${i}` })));
    assert.deepEqual((await loadProgress()).attempts.map((a) => a.id).sort(), ["p-1", "p-2", "p-3"]);
  });
});
