// Deletes local study data. Usage:
//   npm run reset-progress            # progress only
//   npm run reset-progress -- --all   # progress, course indexes, and cached course text
import { resetData } from "../agent/lib/store.ts";

const includeCourses = process.argv.includes("--all");
for (const removed of await resetData({ includeCourses })) console.log(`Removed ${removed}`);
