import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadCourse } from "../lib/course.ts";

export default defineTool({
  description:
    "List indexed resources of an imported course, with their status: readable (may be read with read_resource), " +
    "unsupported_format, outside_scope, external, or blocked (listed only; contents unavailable). Filter by status or title text.",
  inputSchema: z.strictObject({
    courseId: z.string().min(1).max(80),
    status: z.enum(["readable", "unsupported_format", "outside_scope", "external", "blocked", "all"]).default("all"),
    titleContains: z.string().max(100).optional().describe("Case-insensitive filter on title and section."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(60),
  }),
  async execute({ courseId, status, titleContains, offset, limit }) {
    const index = await loadCourse(courseId);
    const needle = titleContains?.toLowerCase();
    const matching = index.resources.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (!needle || `${r.title} ${r.section}`.toLowerCase().includes(needle)),
    );
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
