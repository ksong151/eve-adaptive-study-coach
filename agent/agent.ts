import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
  // Removes eve's optional bash, read_file, write_file, web_fetch, web_search,
  // and agent tools. The model only gets the course tools in agent/tools/.
  defaultTools: false,
});
