import { defineTool } from "eve/tools";
import { z } from "zod";
import { CourseError, importCourse, importResult } from "../lib/course.ts";
import { guardedTransport } from "../lib/fetcher.ts";
import { learnerSupplied, learnerText } from "../lib/learner-input.ts";
import { checkPublicHttpsUrl } from "../lib/scope.ts";

export default defineTool({
  description:
    "Import a public course page the learner gave you. Fetches only that one page and indexes its direct links; it does not crawl. " +
    "Links on the same site as that page can be read; links to other sites are listed only. Pass additionalScopes only for other-site directory URLs the learner explicitly approved in their own message. " +
    "Both startUrl and every additionalScopes entry must appear verbatim in the learner's messages, or the call is rejected.",
  inputSchema: z.strictObject({
    startUrl: z.string().min(1).max(500).describe("The course homepage or materials page URL exactly as the learner wrote it."),
    additionalScopes: z
      .array(z.string().min(1).max(500))
      .max(3)
      .default([])
      .describe("Directory URLs (ending in /) on other sites that the learner explicitly approved."),
  }),
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
    return importResult(index);
  },
});
