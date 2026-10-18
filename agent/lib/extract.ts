// Turns fetched bytes into plain text. HTML keeps block structure as line
// breaks; PDFs keep one entry per page so citations can name page numbers.
import { parse } from "node-html-parser";
import { extractText, getDocumentProxy } from "unpdf";

export interface ExtractedPage {
  page: number;
  text: string;
}

/** textLimitReached: the text was cut at EXTRACT_LIMITS.maxTextChars, so the rest was not read. */
export type Extraction =
  | { ok: true; title: string; kind: "html"; text: string; textLimitReached: boolean }
  | { ok: true; kind: "pdf"; pages: ExtractedPage[]; totalPages: number; textLimitReached: boolean }
  | { ok: false; reason: "no_text" | "parse_failed" | "too_many_pages"; detail: string };

export const EXTRACT_LIMITS = {
  maxPdfPages: 200,
  /** Characters of text kept per resource; anything after this is not read. */
  maxTextChars: 400_000,
};

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractHtml(html: string): Extraction {
  // The parser keeps a doctype as a text node, so strip it before parsing.
  const root = parse(html.replace(/<!doctype[^>]*>/gi, ""));
  root.querySelectorAll("script, style, noscript, template, svg, nav").forEach((node) => node.remove());
  const title = tidy(root.querySelector("title")?.text ?? "") || tidy(root.querySelector("h1")?.text ?? "");
  // Some pages (CS144's, for one) parse without a <body>, so drop <head> and use the whole document.
  root.querySelectorAll("head").forEach((node) => node.remove());
  const body = root.querySelector("body") ?? root;
  const full = tidy(body.structuredText);
  if (full.length === 0) return { ok: false, reason: "no_text", detail: "The page contains no extractable text." };
  const text = full.slice(0, EXTRACT_LIMITS.maxTextChars);
  return { ok: true, title, kind: "html", text, textLimitReached: text.length < full.length };
}

export async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  if (new TextDecoder().decode(bytes.subarray(0, 1024)).indexOf("%PDF-") === -1) {
    return { ok: false, reason: "parse_failed", detail: "The response is labeled PDF but has no PDF header." };
  }
  let pdf;
  try {
    // pdf.js may take ownership of the buffer, so pass a copy.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (error) {
    return { ok: false, reason: "parse_failed", detail: `PDF could not be parsed: ${errorMessage(error)}` };
  }
  try {
    if (pdf.numPages > EXTRACT_LIMITS.maxPdfPages) {
      return { ok: false, reason: "too_many_pages", detail: `PDF has ${pdf.numPages} pages; limit is ${EXTRACT_LIMITS.maxPdfPages}.` };
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    let room = EXTRACT_LIMITS.maxTextChars;
    let textLimitReached = false;
    const pages: ExtractedPage[] = [];
    for (const [index, pageText] of text.entries()) {
      const cleaned = tidy(pageText);
      if (cleaned.length > room) {
        // Keep what fits of this page, then stop: later pages were not read.
        if (room > 0) pages.push({ page: index + 1, text: cleaned.slice(0, room) });
        textLimitReached = true;
        break;
      }
      pages.push({ page: index + 1, text: cleaned });
      room -= cleaned.length;
    }
    if (pages.every((p) => p.text.length === 0)) {
      return {
        ok: false,
        reason: "no_text",
        detail: "No text layer found (the PDF may be scanned images). Its contents were not read.",
      };
    }
    return { ok: true, kind: "pdf", pages, totalPages, textLimitReached };
  } catch (error) {
    return { ok: false, reason: "parse_failed", detail: `PDF text extraction failed: ${errorMessage(error)}` };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
