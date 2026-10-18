// Deletes saved study progress. Usage: npm run reset-progress
// To also remove course indexes and cached course text, delete .study-coach/.
import { resetProgress } from "../agent/lib/store.ts";

console.log(`Removed ${await resetProgress()}`);
