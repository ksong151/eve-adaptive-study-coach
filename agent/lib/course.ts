// Course import, resource listing, and resource reading. Tools call these
// functions; tests call them directly with a mocked transport.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson, courseFile, contentFile, coursesLock, dataDir, withLock } from "./store.ts";
import { buildScope, checkFetchAllowed, checkPublicHttpsUrl, describeScope, directoryPrefix, type CourseScope } from "./scope.ts";
import { boundedFetch, FetchRejected, type FetchLimits, type SupportedContentType, type Transport } from "./fetcher.ts";
import { discoverLinks, type ResourceKind, type ResourceStatus } from "./links.ts";
import { extractHtml, extractPdf, type Extraction, type ExtractedPage } from "./extract.ts";

export const LIMITS = {
  /** Links kept from the start page. */
  maxIndexedLinks: 250,
  /** Network reads per imported course (cached reads are free). */
  maxFetchesPerCourse: 30,
  /** Bytes downloaded per imported course. */
  maxBytesPerCourse: 60 * 1024 * 1024,
  html: { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, maxRedirects: 3 } satisfies FetchLimits,
  pdf: { maxBytes: 15 * 1024 * 1024, timeoutMs: 30_000, maxRedirects: 3 } satisfies FetchLimits,
  /** Characters of source text returned per read_resource call. */
  maxCharsPerRead: 12_000,
};

/** Shown in place of a PDF page that has no text layer (often a diagram or photo). */
export const EMPTY_PAGE = "[No extractable text on this page. It may be an image; its contents were not read.]";

export interface ExtractionRecord {
  status: "extracted" | "failed";
  /** Failure reason, or "" when extracted. */
  reason: string;
  detail: string;
  at: string;
}

export interface Resource {
  id: string;
  url: string;
  title: string;
  section: string;
  kind: ResourceKind;
  status: ResourceStatus;
  note: string;
  extraction?: ExtractionRecord;
}

export interface CourseIndex {
  version: 1;
  courseId: string;
  startUrl: string;
  pageTitle: string;
  scope: CourseScope;
  importedAt: string;
  truncatedLinks: number;
  usage: { fetches: number; bytes: number };
  resources: Resource[];
}

export interface CachedContent {
  url: string;
  finalUrl: string;
  title: string;
  kind: "html" | "pdf";
  text?: string;
  pages?: ExtractedPage[];
  totalPages?: number;
  /** Extraction stopped at the text size limit, so the end of this resource was not read. */
  textLimitReached?: boolean;
  bytes: number;
  extractedAt: string;
}

export class CourseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseError";
  }
}

/**
 * Stable id from the start page's host and directory: a readable slug plus a
 * hash of the exact (case-sensitive) location, so "a.b.edu/cs-1/" and
 * "a-b.edu/cs/1/" do not share an id. Example: "web-stanford-edu-class-cs107-98c6589c".
 */
export function courseIdFor(startUrl: URL): string {
  const location = `${startUrl.host}${directoryPrefix(startUrl)}`;
  const hash = createHash("sha256").update(location).digest("hex").slice(0, 8);
  const slug = location
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/, "");
  return `${slug}-${hash}`;
}

export async function loadCourse(courseId: string): Promise<CourseIndex> {
  if (!/^[a-z0-9-]{1,80}$/.test(courseId)) throw new CourseError(`Invalid course id: ${courseId}`);
  const index = await readJson<CourseIndex>(courseFile(courseId));
  if (!index) throw new CourseError(`No imported course with id "${courseId}". Import it first with import_course.`);
  return index;
}

/**
 * The cached text for a resource, if this course may use it. Text is cached by
 * URL for every course, so text one course fetched through a redirect into its
 * own approved scope is ignored by a course whose scope does not allow it.
 */
export async function cachedTextFor(index: CourseIndex, r: Resource): Promise<CachedContent | undefined> {
  if (r.status !== "readable") return undefined;
  const cached = await readJson<CachedContent>(contentFile(r.url));
  return cached && checkFetchAllowed(cached.finalUrl, index.scope).allowed ? cached : undefined;
}

const ALLOWED_TYPES: Record<Exclude<ResourceKind, "other">, SupportedContentType[]> = {
  html: ["text/html"],
  pdf: ["application/pdf"],
};

function extractionToCache(extraction: Extraction & { ok: true }, url: string, finalUrl: string, bytes: number): CachedContent {
  const base = { url, finalUrl, bytes, extractedAt: new Date().toISOString(), textLimitReached: extraction.textLimitReached };
  return extraction.kind === "pdf"
    ? { ...base, title: "", kind: "pdf", pages: extraction.pages, totalPages: extraction.totalPages }
    : { ...base, title: extraction.title, kind: "html", text: extraction.text };
}

async function extract(bytes: Uint8Array, contentType: SupportedContentType): Promise<Extraction> {
  if (contentType === "application/pdf") return extractPdf(bytes);
  return extractHtml(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

/** Body of importCourse; call it only while holding the courses lock. */
async function importCourseUnlocked(
  input: { startUrl: string; additionalScopes: readonly string[] },
  deps: { transport: Transport; signal?: AbortSignal },
): Promise<CourseIndex> {
  const start = checkPublicHttpsUrl(input.startUrl);
  if (!start.allowed) throw new CourseError(`Start page rejected: ${start.detail}`);
  const built = buildScope(start.url, input.additionalScopes);
  if ("error" in built) throw new CourseError(built.error);
  const { scope } = built;

  let fetched;
  try {
    fetched = await boundedFetch(start.url.href, scope, {
      transport: deps.transport,
      limits: LIMITS.html,
      allowedTypes: ["text/html"],
      signal: deps.signal,
    });
  } catch (error) {
    if (error instanceof FetchRejected) throw new CourseError(`Could not import ${start.url.href}: ${error.message}`);
    throw error;
  }

  const html = new TextDecoder().decode(fetched.bytes);
  const discovered = discoverLinks(html, fetched.finalUrl, scope, LIMITS.maxIndexedLinks);
  const startExtraction = extractHtml(html);
  const now = new Date().toISOString();

  const startResource: Resource = {
    id: "r1",
    url: fetched.finalUrl,
    title: discovered.pageTitle || "Course start page",
    section: "",
    kind: "html",
    status: "readable",
    note: "The page you supplied.",
    extraction: startExtraction.ok
      ? { status: "extracted", reason: "", detail: "", at: now }
      : { status: "failed", reason: startExtraction.reason, detail: startExtraction.detail, at: now },
  };
  if (startExtraction.ok) {
    await writeJson(contentFile(fetched.finalUrl), extractionToCache(startExtraction, fetched.finalUrl, fetched.finalUrl, fetched.bytes.byteLength));
  }

  const resources: Resource[] = [startResource];
  for (const link of discovered.links) {
    if (link.url === fetched.finalUrl) continue;
    resources.push({ id: `r${resources.length + 1}`, ...link });
  }

  const index: CourseIndex = {
    version: 1,
    courseId: courseIdFor(start.url),
    startUrl: fetched.finalUrl,
    pageTitle: discovered.pageTitle,
    scope,
    importedAt: now,
    truncatedLinks: discovered.truncated,
    usage: { fetches: 1, bytes: fetched.bytes.byteLength },
    resources,
  };
  await writeJson(courseFile(index.courseId), index);
  return index;
}

export function summarizeIndex(index: CourseIndex) {
  const byStatus: Record<string, number> = {};
  for (const r of index.resources) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    courseId: index.courseId,
    startUrl: index.startUrl,
    pageTitle: index.pageTitle,
    approvedScope: describeScope(index.scope),
    resourceCounts: byStatus,
    truncatedLinks: index.truncatedLinks,
  };
}

/** What import_course returns to the model: the summary, readable resources, and an honest note. */
export function importResult(index: CourseIndex) {
  const start = index.resources[0];
  const startFailed =
    start?.extraction?.status === "failed" ? ` The start page's text could not be extracted (${start.extraction.reason}).` : "";
  return {
    ...summarizeIndex(index),
    readableResources: index.resources
      .filter((r) => r.status === "readable")
      .slice(0, 40)
      .map(({ id, title, kind, section }) => ({ id, title, kind, section })),
    note:
      "No resource text has been returned to you yet. Call read_resource before relying on or citing any resource, including r1 (the start page)." +
      startFailed,
  };
}

export type ReadResult =
  | {
      read: true;
      courseId: string;
      resourceId: string;
      title: string;
      url: string;
      kind: "html" | "pdf";
      /** PDF: the pages returned in this call. */
      pages?: ExtractedPage[];
      totalPages?: number;
      /** PDF: where to continue. With nextOffset, continue inside that page. */
      nextPage?: number;
      /** HTML: the slice returned in this call. */
      text?: string;
      offset?: number;
      nextOffset?: number;
      totalChars?: number;
      /** Set when this read reached the end of the extracted text but extraction had stopped early. */
      notice?: string;
    }
  | {
      read: false;
      courseId: string;
      resourceId: string;
      title: string;
      url: string;
      reason: string;
      detail: string;
    };

function notRead(index: CourseIndex, r: Resource, reason: string, detail: string): ReadResult {
  return { read: false, courseId: index.courseId, resourceId: r.id, title: r.title, url: r.url, reason, detail };
}

function windowContent(index: CourseIndex, r: Resource, content: CachedContent, page: number, offset: number): ReadResult {
  const base = { read: true as const, courseId: index.courseId, resourceId: r.id, title: content.title || r.title, url: r.url, kind: content.kind };
  const max = LIMITS.maxCharsPerRead;
  if (content.kind === "pdf") {
    const pages = content.pages ?? [];
    const out: ExtractedPage[] = [];
    let chars = 0;
    let nextPage: number | undefined;
    let nextOffset: number | undefined;
    for (const p of pages) {
      if (p.page < page) continue;
      // offset applies within the first requested page only.
      const start = p.page === page ? Math.min(offset, p.text.length) : 0;
      const text = p.text.length === 0 ? EMPTY_PAGE : p.text.slice(start);
      if (out.length > 0 && chars + text.length > max) {
        nextPage = p.page;
        break;
      }
      if (text.length > max) {
        // One long page: return part of it and say where to continue.
        out.push({ page: p.page, text: text.slice(0, max) });
        nextPage = p.page;
        nextOffset = start + max;
        break;
      }
      out.push({ page: p.page, text });
      chars += text.length;
    }
    const lastExtracted = pages.at(-1)?.page ?? 0;
    const notice =
      nextPage === undefined && content.textLimitReached
        ? `Text extraction stopped at page ${lastExtracted} of ${content.totalPages} because of the size limit; the rest of this PDF was not read.`
        : undefined;
    return { ...base, pages: out, totalPages: content.totalPages, nextPage, nextOffset, notice };
  }
  const text = content.text ?? "";
  const slice = text.slice(offset, offset + max);
  const nextOffset = offset + slice.length < text.length ? offset + slice.length : undefined;
  const notice =
    nextOffset === undefined && content.textLimitReached
      ? "Text extraction stopped at the size limit; the rest of this page was not read."
      : undefined;
  return { ...base, text: slice, offset, nextOffset, totalChars: text.length, notice };
}

/**
 * Body of readResource; call it only while holding the courses lock. Fetches
 * only when the resource is "readable" and not already cached; failures are
 * recorded on the index and returned as read: false.
 */
async function readResourceUnlocked(
  input: { courseId: string; resourceId: string; page?: number; offset?: number },
  deps: { transport: Transport; signal?: AbortSignal },
): Promise<ReadResult> {
  const index = await loadCourse(input.courseId);
  const r = index.resources.find((res) => res.id === input.resourceId);
  if (!r) throw new CourseError(`Resource "${input.resourceId}" is not in course "${index.courseId}". Use list_resources to see valid ids.`);
  const page = input.page ?? 1;
  const offset = input.offset ?? 0;

  if (r.status !== "readable" || r.kind === "other") {
    return notRead(index, r, r.status, r.note || "This resource is listed only; its contents were not fetched.");
  }

  const cached = await cachedTextFor(index, r);
  if (cached) return windowContent(index, r, cached, page, offset);
  if (r.extraction?.status === "failed") return notRead(index, r, r.extraction.reason, r.extraction.detail);

  if (index.usage.fetches >= LIMITS.maxFetchesPerCourse) {
    return notRead(index, r, "fetch_budget_exhausted", `This course has used its ${LIMITS.maxFetchesPerCourse} network reads. Re-import the course to reset the budget.`);
  }
  const limits = r.kind === "pdf" ? LIMITS.pdf : LIMITS.html;
  const remainingBytes = LIMITS.maxBytesPerCourse - index.usage.bytes;
  if (remainingBytes <= 0) {
    return notRead(index, r, "byte_budget_exhausted", "This course has used its download budget. Re-import the course to reset it.");
  }

  const now = new Date().toISOString();
  index.usage.fetches += 1;
  let result: ReadResult;
  try {
    const fetched = await boundedFetch(r.url, index.scope, {
      transport: deps.transport,
      limits: { ...limits, maxBytes: Math.min(limits.maxBytes, remainingBytes) },
      allowedTypes: ALLOWED_TYPES[r.kind],
      signal: deps.signal,
    });
    index.usage.bytes += fetched.bytes.byteLength;
    const extraction = await extract(fetched.bytes, fetched.contentType);
    if (extraction.ok) {
      const content = extractionToCache(extraction, r.url, fetched.finalUrl, fetched.bytes.byteLength);
      await writeJson(contentFile(r.url), content);
      r.extraction = { status: "extracted", reason: "", detail: "", at: now };
      result = windowContent(index, r, content, page, offset);
    } else {
      r.extraction = { status: "failed", reason: extraction.reason, detail: extraction.detail, at: now };
      result = notRead(index, r, extraction.reason, extraction.detail);
    }
  } catch (error) {
    if (!(error instanceof FetchRejected)) throw error;
    index.usage.bytes += error.bytesRead;
    // Failures that may succeed later are not recorded, so the next read retries them:
    // timeouts, network errors, rate limiting and server errors, and size rejections
    // that happened only because little of the course's byte budget was left.
    const retryableHttp = error.reason === "http_error" && (error.status === 429 || (error.status ?? 0) >= 500);
    const budgetLimited = error.reason === "response_too_large" && remainingBytes < limits.maxBytes;
    const transient = error.reason === "timeout" || error.reason === "network_error" || retryableHttp || budgetLimited;
    if (!transient) r.extraction = { status: "failed", reason: error.reason, detail: error.message, at: now };
    result = notRead(index, r, error.reason, error.message);
  }
  await writeJson(courseFile(index.courseId), index);
  return result;
}

/**
 * Fetches one start page (the only request this makes), indexes its direct
 * links, and saves the index. Callers must already have confirmed that
 * startUrl and additionalScopes came from the learner.
 */
export function importCourse(
  input: { startUrl: string; additionalScopes: readonly string[] },
  deps: { transport: Transport; signal?: AbortSignal },
): Promise<CourseIndex> {
  return withLock(coursesLock(), () => importCourseUnlocked(input, deps));
}

/**
 * Reads an indexed resource by id. Calls are serialized so concurrent reads
 * cannot overspend the budget or overwrite each other's index updates.
 */
export function readResource(
  input: { courseId: string; resourceId: string; page?: number; offset?: number },
  deps: { transport: Transport; signal?: AbortSignal },
): Promise<ReadResult> {
  return withLock(coursesLock(), () => readResourceUnlocked(input, deps));
}

export async function listCourses(): Promise<Array<{ courseId: string; startUrl: string; pageTitle: string; importedAt: string; approvedScope: string }>> {
  let files: string[];
  try {
    files = await readdir(path.join(dataDir(), "courses"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const courses = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const index = await readJson<CourseIndex>(path.join(dataDir(), "courses", file));
    if (index) {
      courses.push({
        courseId: index.courseId,
        startUrl: index.startUrl,
        pageTitle: index.pageTitle,
        importedAt: index.importedAt,
        approvedScope: describeScope(index.scope),
      });
    }
  }
  return courses;
}
