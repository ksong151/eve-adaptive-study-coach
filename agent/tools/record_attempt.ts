import { defineTool } from "eve/tools";
import { z } from "zod";
import { OBSERVATIONS, recordAttempt } from "../lib/progress.ts";

export default defineTool({
  description:
    "Save one diagnostic question, the learner's answer, and your observation to local progress so later sessions can revisit it. " +
    "Observations: demonstrated, partially_demonstrated, needs_review, or unclear (ambiguous answer or insufficient source). " +
    "sources must be resources you actually read; cited pages must be extracted PDF pages. Calls citing unread resources are rejected.",
  inputSchema: z.strictObject({
    courseId: z.string().min(1).max(80),
    concept: z.string().min(1).max(120).describe("Short name of the concept tested, e.g. 'TCP sequence numbers'."),
    question: z.string().min(1).max(1500),
    learnerAnswer: z.string().min(1).max(4000).describe("The learner's answer, verbatim."),
    observation: z.enum(OBSERVATIONS),
    feedbackSummary: z.string().min(1).max(1500),
    sources: z
      .array(z.strictObject({ resourceId: z.string().regex(/^r\d{1,4}$/), pages: z.array(z.number().int().min(1)).max(20).optional() }))
      .min(1)
      .max(5),
    recommendedResourceId: z.string().regex(/^r\d{1,4}$/).optional().describe("Indexed resource the learner should revisit."),
  }),
  async execute(input, ctx) {
    const attempt = await recordAttempt({ attemptId: ctx.callId, ...input });
    return { saved: true, attempt };
  },
});
