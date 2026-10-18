// Local, single-user JSON storage. Everything lives under one data directory
// (default: ./.study-coach, ignored by Git) so reset is a single delete.
import { createHash } from "node:crypto";
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

/** Writes via a temporary file and rename so a crash cannot leave half a file. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
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
