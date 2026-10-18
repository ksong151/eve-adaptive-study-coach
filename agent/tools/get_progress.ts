import { defineTool } from "eve/tools";
import { z } from "zod";
import { listCourses } from "../lib/course.ts";
import { progressSummary } from "../lib/progress.ts";

export default defineTool({
  description:
    "Get saved study progress from earlier sessions: imported courses, concepts marked for revisit with their recommended resources, and recent attempts.",
  inputSchema: z.strictObject({
    courseId: z.string().min(1).max(80).optional(),
  }),
  async execute({ courseId }) {
    return { courses: await listCourses(), ...(await progressSummary(courseId)) };
  },
});
