import { defineTool } from "eve/tools";
import { z } from "zod";
import { CourseError, importCourse, summarizeIndex } from "../lib/course.ts";
import { guardedTransport } from "../lib/fetcher.ts";
import { learnerSupplied, learnerText } from "../lib/learner-input.ts";
import { checkPublicHttpsUrl } from "../lib/scope.ts";

export default defineTool({
  description:
    "Import a public course page the learner gave you. Fetches only that one page and indexes its direct links; it does not crawl. " +
    "The default approved scope is the page's own directory. Pass additionalScopes only for directory URLs the learner explicitly approved in their own message. " +
    "Both startUrl and every additionalScopes entry must appear verbatim in the learner's messages, or the call is rejected.",
  inputSchema: z.strictObject({
    startUrl: z.string().min(1).max(500).describe("The course homepage or materials page URL exactly as the learner wrote it."),
    additionalScopes: z
      .array(z.string().min(1).max(500))
      .max(3)
      .default([])
      .describe("Extra directory URLs the learner explicitly approved, e.g. a sibling assets directory."),
  }),
  label: { start: ({ startUrl }) => `Import course page ${startUrl}` },
  async execute({ startUrl, additionalScopes }, ctx) {
    const text = learnerText(ctx.messages);
    const [start, ...scopes] = [startUrl, ...additionalScopes].map((raw) => {
      const parsed = checkPublicHttpsUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!parsed.allowed) throw new CourseError(parsed.detail);
      if (!learnerSupplied(parsed.url, text)) {
        throw new CourseError(
          `${parsed.url.href} does not appear in the learner's messages. Ask the learner to paste the exact URL they want to use; do not supply URLs yourself.`,
        );
      }
      return parsed.url.href;
    });
    const index = await importCourse(
      { startUrl: start!, additionalScopes: scopes },
      { transport: guardedTransport, signal: ctx.abortSignal },
    );
    return {
      ...summarizeIndex(index),
      readableResources: index.resources
        .filter((r) => r.status === "readable")
        .slice(0, 40)
        .map(({ id, title, kind, section }) => ({ id, title, kind, section })),
      note: "Only r1 (the start page) has been read so far. Other resources are unread until read_resource succeeds.",
    };
  },
});
