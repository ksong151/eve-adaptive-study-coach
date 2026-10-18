import { defineEval } from "eve/evals";
import { COURSE_URL, toyCourseStubs } from "./stubs.ts";

export default defineEval({
  description: "Imports the learner's course, asks a grounded question, then records a missed concept with a recommended resource.",
  timeoutMs: 240_000,
  async test(t) {
    const session = await t.session({ stubs: toyCourseStubs });

    const ask = await session.send(`My course page is ${COURSE_URL}. Quiz me on cache hit rate with one short question.`);
    ask.expectOk();
    ask.calledTool("import_course", { input: { startUrl: /toy-course\.example\/toy101/ } });
    ask.calledTool("read_resource");
    ask.messageIncludes("?");
    t.judge("The assistant asks one short-answer question about cache hit rate, names the course resource it is based on, and does not reveal the answer.", { on: ask.message }).atLeast(0.7);

    const answer = await session.send("Hit rate is misses divided by total requests.");
    answer.expectOk();
    answer.calledTool("record_attempt", {
      input: {
        observation: (value: unknown) => value === "needs_review" || value === "partially_demonstrated",
        recommendedResourceId: /^r\d+$/,
        sources: (value: unknown) => Array.isArray(value) && value.length > 0,
      },
    });
    t.judge(
      "The feedback says the answer describes the miss rate, explains that hit rate is hits divided by hits plus misses, cites a course resource, and recommends a specific resource to revisit. It does not call the result a grade or mastery score.",
      { on: answer.message },
    ).atLeast(0.7);
    t.succeeded();
  },
});
