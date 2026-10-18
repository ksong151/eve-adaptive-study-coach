// Runs the importer (and optionally one read) without a model, using the same
// guarded network path as the agent. Usage:
//   npm run inspect -- <startUrl> [--scope <dirUrl>]... [--read <resourceId>] [--page <n>]
import { importCourse, readResource, summarizeIndex } from "../agent/lib/course.ts";
import { guardedTransport } from "../agent/lib/fetcher.ts";

const args = process.argv.slice(2);
const startUrl = args[0];
if (!startUrl || startUrl.startsWith("--")) {
  console.error("Usage: npm run inspect -- <startUrl> [--scope <dirUrl>]... [--read <resourceId>] [--page <n>]");
  process.exit(2);
}
const flag = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));

const index = await importCourse({ startUrl, additionalScopes: flag("--scope") }, { transport: guardedTransport });
console.log(JSON.stringify(summarizeIndex(index), null, 2));
for (const r of index.resources) {
  console.log(`${r.id.padEnd(5)} ${r.status.padEnd(18)} ${r.kind.padEnd(5)} ${r.title}${r.note ? `  [${r.note}]` : ""}\n      ${r.url}`);
}

const readId = flag("--read")[0];
if (readId) {
  const page = Number(flag("--page")[0] ?? 1);
  const result = await readResource({ courseId: index.courseId, resourceId: readId, page }, { transport: guardedTransport });
  if (!result.read) {
    console.log(`\nNOT READ ${readId}: ${result.reason}: ${result.detail}`);
  } else if (result.pages) {
    console.log(`\nREAD ${readId} "${result.title}" (${result.totalPages} pages)`);
    for (const p of result.pages.slice(0, 2)) console.log(`--- page ${p.page} ---\n${p.text.slice(0, 600)}`);
  } else {
    console.log(`\nREAD ${readId} "${result.title}" (${result.totalChars} chars)\n${(result.text ?? "").slice(0, 600)}`);
  }
}
