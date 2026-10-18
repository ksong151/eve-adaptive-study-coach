// Local, single-user JSON storage. Everything lives under one data directory
// (default: ./.study-coach, ignored by Git) so reset is a single delete.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function dataDir(): string {
  return path.resolve(process.env.STUDY_COACH_DATA_DIR ?? path.join(process.cwd(), ".study-coach"));
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Writes via a uniquely named temporary file and rename, so a crash cannot
 * leave half a file and concurrent writes cannot share a temporary file.
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

const locks = new Map<string, Promise<void>>();

/**
 * Runs `fn` after every earlier call with the same key has settled. Tool calls
 * from one model step run in parallel, so read-modify-write updates of the
 * same JSON file go through this. It serializes within one process only.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}

/** Lock key for course indexes and their usage budgets. */
export function coursesLock(): string {
  return path.join(dataDir(), "courses");
}

export function courseFile(courseId: string): string {
  return path.join(dataDir(), "courses", `${courseId}.json`);
}

export function contentFile(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return path.join(dataDir(), "content", `${hash}.json`);
}

export function progressFile(): string {
  return path.join(dataDir(), "progress.json");
}

/** Deletes saved progress. Course indexes and cached text are kept. */
export async function resetProgress(): Promise<string> {
  await rm(progressFile(), { force: true });
  return progressFile();
}
