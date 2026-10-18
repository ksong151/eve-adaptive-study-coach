import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadCourse } from "../lib/course.ts";

export default defineTool({
  description:
    "List indexed resources of an imported course, with their status: readable (may be read with read_resource), " +
    "unsupported_format, external, or blocked (listed only; contents unavailable). Filter by status; page with offset.",
  inputSchema: z.strictObject({
    courseId: z.string().min(1).max(80),
    status: z.enum(["readable", "unsupported_format", "external", "blocked", "all"]).default("all"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(60),
  }),
  async execute({ courseId, status, offset, limit }) {
    const index = await loadCourse(courseId);
    const matching = index.resources.filter((r) => status === "all" || r.status === status);
    return {
      courseId: index.courseId,
      total: matching.length,
      offset,
      resources: matching.slice(offset, offset + limit).map((r) => ({
        id: r.id,
        title: r.title,
        section: r.section,
        kind: r.kind,
        status: r.status,
        url: r.url,
        note: r.note,
        extraction: r.extraction ? `${r.extraction.status}${r.extraction.reason ? `: ${r.extraction.reason}` : ""}` : "not yet read",
      })),
    };
  },
});
