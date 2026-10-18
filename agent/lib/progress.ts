// Study observations, persisted locally across sessions. These are the
// coach's notes about one answer, not a validated mastery measurement.
import { readJson, writeJson, progressFile, withLock } from "./store.ts";
import { cachedTextFor, CourseError, loadCourse, type CourseIndex } from "./course.ts";

export const OBSERVATIONS = ["demonstrated", "partially_demonstrated", "needs_review", "unclear"] as const;
export type Observation = (typeof OBSERVATIONS)[number];

export interface SourceRef {
  resourceId: string;
  title: string;
  url: string;
  pages?: number[];
}

export interface Attempt {
  id: string;
  recordedAt: string;
  courseId: string;
  concept: string;
  question: string;
  learnerAnswer: string;
  observation: Observation;
  feedbackSummary: string;
  sources: SourceRef[];
  recommended?: SourceRef & { contentRead: boolean };
  revisit: boolean;
}

interface ProgressFile {
  version: 1;
  attempts: Attempt[];
}

export async function loadProgress(): Promise<ProgressFile> {
  return (await readJson<ProgressFile>(progressFile())) ?? { version: 1, attempts: [] };
}

async function resolveSource(
  index: CourseIndex,
  ref: { resourceId: string; pages?: number[] },
  mustBeRead: boolean,
): Promise<SourceRef & { contentRead: boolean }> {
  const r = index.resources.find((res) => res.id === ref.resourceId);
  if (!r) throw new CourseError(`Resource "${ref.resourceId}" is not in course "${index.courseId}".`);
  const cached = await cachedTextFor(index, r);
  if (mustBeRead && !cached) {
    throw new CourseError(
      `Resource ${r.id} ("${r.title}") has no extracted text, so it cannot be cited as a source. Read it with read_resource first, or cite a resource that was read.`,
    );
  }
  if (ref.pages?.length) {
    // Only pages with extracted text can be cited.
    const available = new Set((cached?.pages ?? []).filter((p) => p.text.length > 0).map((p) => p.page));
    const missing = ref.pages.filter((p) => !available.has(p));
    if (cached?.kind !== "pdf" || missing.length > 0) {
      throw new CourseError(`Resource ${r.id} has no extracted page(s) ${missing.join(", ") || ref.pages.join(", ")}.`);
    }
  }
  return { resourceId: r.id, title: r.title, url: r.url, pages: ref.pages, contentRead: cached !== undefined };
}

async function recordAttemptUnlocked(input: {
  attemptId: string;
  courseId: string;
  concept: string;
  question: string;
  learnerAnswer: string;
  observation: Observation;
  feedbackSummary: string;
  sources: Array<{ resourceId: string; pages?: number[] }>;
  recommendedResourceId?: string;
}): Promise<Attempt> {
  const index = await loadCourse(input.courseId);
  // Collapse whitespace so "Hit  rate" and "Hit rate" are one concept.
  const concept = input.concept.replace(/\s+/g, " ").trim();
  if (concept === "") throw new CourseError("The concept name must not be empty.");
  const sources: SourceRef[] = [];
  for (const ref of input.sources) {
    const { contentRead: _read, ...source } = await resolveSource(index, ref, true);
    sources.push(source);
  }
  const recommended = input.recommendedResourceId
    ? await resolveSource(index, { resourceId: input.recommendedResourceId }, false)
    : undefined;
  if (recommended && index.resources.find((r) => r.id === recommended.resourceId)?.status === "blocked") {
    throw new CourseError(`Resource ${recommended.resourceId} is blocked (not https, or a local address), so it cannot be recommended.`);
  }

  const progress = await loadProgress();
  // A durable step can re-run after an interruption; the tool call id makes the write idempotent.
  const existing = progress.attempts.find((a) => a.id === input.attemptId);
  if (existing) return existing;

  const attempt: Attempt = {
    id: input.attemptId,
    recordedAt: new Date().toISOString(),
    courseId: index.courseId,
    concept,
    question: input.question,
    learnerAnswer: input.learnerAnswer,
    observation: input.observation,
    feedbackSummary: input.feedbackSummary,
    sources,
    recommended,
    revisit: input.observation !== "demonstrated",
  };
  progress.attempts.push(attempt);
  await writeJson(progressFile(), progress);
  return attempt;
}

/** Saves one attempt. Calls are serialized so parallel saves cannot drop each other. */
export function recordAttempt(input: Parameters<typeof recordAttemptUnlocked>[0]): Promise<Attempt> {
  return withLock(progressFile(), () => recordAttemptUnlocked(input));
}

/** The latest attempt per (course, concept), plus the concepts still marked for revisit. */
export async function progressSummary(courseId?: string) {
  const { attempts } = await loadProgress();
  const relevant = courseId ? attempts.filter((a) => a.courseId === courseId) : attempts;
  const latest = new Map<string, Attempt>();
  for (const a of relevant) latest.set(`${a.courseId}\u0000${a.concept.toLowerCase()}`, a);
  const revisit = [...latest.values()]
    .filter((a) => a.revisit)
    .map((a) => ({
      courseId: a.courseId,
      concept: a.concept,
      lastObservation: a.observation,
      lastAttemptAt: a.recordedAt,
      recommended: a.recommended,
      sources: a.sources,
    }));
  return {
    totalAttempts: relevant.length,
    revisit,
    recentAttempts: relevant.slice(-5).map(({ learnerAnswer: _a, ...rest }) => rest),
  };
}
