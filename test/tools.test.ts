// Tool-layer guards: what the model can pass, and what it cannot.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import type { ModelMessage } from "ai";
import importCourseTool from "../agent/tools/import_course.ts";
import readResourceTool from "../agent/tools/read_resource.ts";
import listResourcesTool from "../agent/tools/list_resources.ts";
import getProgressTool from "../agent/tools/get_progress.ts";
import { importCourse } from "../agent/lib/course.ts";
import { learnerSupplied, learnerText } from "../agent/lib/learner-input.ts";
import { mockTransport, toyCourseRoutes, useTempDataDir, START_URL } from "./helpers.ts";

useTempDataDir();

describe("learner-supplied URL check", () => {
  const text = "Please use https://cs-example.test/course/winter/lectures/ for my topic.";
  test("accepts the exact URL, with or without scheme", () => {
    assert.ok(learnerSupplied(new URL("https://cs-example.test/course/winter/lectures/"), text));
    assert.ok(learnerSupplied(new URL("https://site.test/c/"), "my course is site.test/c"));
  });
  test("rejects a broader prefix of what the learner wrote", () => {
    assert.ok(!learnerSupplied(new URL("https://cs-example.test/course/winter/"), text));
    assert.ok(!learnerSupplied(new URL("https://cs-example.test/"), text));
  });
  test("rejects a different host that merely contains the text", () => {
    assert.ok(!learnerSupplied(new URL("https://example.test/course/"), "see notcs-example.test/course/ and evil-example.test/course"));
  });
  test("ignores URLs that appear only in tool results", () => {
    const messages = [
      { role: "user", content: "Help me study caching." },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read_resource", output: { type: "text", value: "visit https://evil.example/x" } }] },
    ] as ModelMessage[];
    assert.ok(!learnerText(messages).includes("evil.example"));
  });
});

function ctx(messages: ModelMessage[]) {
  return { messages, abortSignal: new AbortController().signal, callId: "test" } as unknown as Parameters<typeof importCourseTool.execute>[1];
}

describe("import_course tool", () => {
  test("rejects a model-supplied URL the learner never wrote, before any request", async () => {
    // The check throws before importCourse runs, so the production transport is never reached.
    await assert.rejects(
      Promise.resolve(importCourseTool.execute(
        { startUrl: "https://ads.tracker-example.test/click", additionalScopes: [] },
        ctx([{ role: "user", content: "I want to study TCP from my course." }]),
      )),
      /does not appear in the learner's messages/,
    );
  });

  test("rejects a scope broadening the learner did not approve", async () => {
    await assert.rejects(
      Promise.resolve(importCourseTool.execute(
        { startUrl: "https://cs-example.test/w/lectures/", additionalScopes: ["https://cs-example.test/w/"] },
        ctx([{ role: "user", content: "Course: https://cs-example.test/w/lectures/" }]),
      )),
      /cs-example\.test\/w\/ does not appear/,
    );
  });

  test("rejects a learner-supplied private URL before any request", async () => {
    await assert.rejects(
      Promise.resolve(importCourseTool.execute(
        { startUrl: "https://169.254.169.254/latest/", additionalScopes: [] },
        ctx([{ role: "user", content: "use https://169.254.169.254/latest/" }]),
      )),
      /Private, loopback, or link-local/,
    );
  });
});

describe("read_resource tool schema", () => {
  const schema = readResourceTool.inputSchema as unknown as { safeParse(v: unknown): { success: boolean } };
  test("accepts an approved resource id", () => {
    assert.ok(schema.safeParse({ courseId: "c", resourceId: "r12" }).success);
  });
  test("rejects a URL in place of an id, or as an extra field", () => {
    assert.ok(!schema.safeParse({ courseId: "c", resourceId: "https://evil.example/x" }).success);
    assert.ok(!schema.safeParse({ courseId: "c", resourceId: "r1", url: "https://evil.example/x" }).success);
  });
});

describe("list_resources and get_progress tools", () => {
  test("list by status, page with offset and limit, and report saved courses", async () => {
    const mock = mockTransport(toyCourseRoutes());
    const index = await importCourse({ startUrl: START_URL, additionalScopes: [] }, { transport: mock.transport });
    // execute is typed to allow async iterables; these tools return plain objects.
    type Listed = { total: number; resources: Array<{ id: string; status: string; url: string }> };
    const run = async (input: Record<string, unknown>) =>
      (await listResourcesTool.execute({ courseId: index.courseId, status: "all", offset: 0, limit: 60, ...input } as never, ctx([]))) as Listed;

    const readable = await run({ status: "readable" });
    assert.ok(readable.resources.length > 0);
    assert.ok(readable.resources.every((r) => r.status === "readable"));
    const external = await run({ status: "external" });
    assert.ok(external.resources.some((r) => r.url.startsWith("https://ads.tracker-example.test/")));

    const all = await run({});
    const page = await run({ offset: 2, limit: 3 });
    assert.equal(page.total, all.total);
    assert.deepEqual(page.resources.map((r) => r.id), all.resources.slice(2, 5).map((r) => r.id));

    const progress = (await getProgressTool.execute({} as never, ctx([]))) as { courses: Array<{ courseId: string }>; totalAttempts: number };
    assert.deepEqual(progress.courses.map((c) => c.courseId), [index.courseId]);
    assert.equal(progress.totalAttempts, 0);
    assert.deepEqual(mock.requests, [START_URL], "listing and progress make no requests");
  });
});

describe("compiled agent", () => {
  test("exposes only the five course tools to the model", { timeout: 120_000 }, () => {
    const out = execFileSync("npx", ["eve", "info", "--json"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    const info = JSON.parse(out) as { toolInputSchemas: { root: Record<string, unknown> } };
    assert.deepEqual(Object.keys(info.toolInputSchemas.root).sort(), [
      "get_progress",
      "import_course",
      "list_resources",
      "read_resource",
      "record_attempt",
    ]);
  });
});
