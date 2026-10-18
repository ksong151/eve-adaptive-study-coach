// Code-level check that a URL came from the learner, not from the model or a
// fetched page. Tool results (where page text lives) have role "tool", so
// only user-role text counts.
import type { ModelMessage } from "ai";

export function learnerText(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === "text") parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the learner's text contains this URL (scheme optional). The match
 * must end where the URL ends, so "site.io/a/b/" does not count as the learner
 * supplying the broader "site.io/a/".
 */
export function learnerSupplied(url: URL, text: string): boolean {
  const target = `${url.host}${url.pathname}${url.search}`.replace(/\/$/, "");
  const pattern = new RegExp(
    `(^|[\\s"'(<\\[]|https?://)${escapeRegExp(target)}/?(?=$|[\\s"'<>),;\\]]|[.!?](?:$|\\s))`,
    "im",
  );
  return pattern.test(text);
}
