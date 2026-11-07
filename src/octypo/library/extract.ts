/**
 * Document text extraction for the Document Library content source.
 *
 * Supports plain text (.txt), Markdown (.md), PDF (.pdf via pdf-parse)
 * and Word (.docx via mammoth). Extracted text is capped to keep stored
 * source material bounded.
 */

import { logger } from "../../lib/logger.js";

/** Maximum number of characters of extracted text we persist. */
export const MAX_EXTRACTED_CHARS = 200_000;

/** Maximum accepted upload size (bytes) — defensive guard, mirrors multer limit. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const TEXT_MIME = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const PDF_MIME = new Set(["application/pdf"]);
const DOCX_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function extByName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** Trim to the cap, normalising whitespace lightly. */
function cap(text: string): string {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  return cleaned.length > MAX_EXTRACTED_CHARS
    ? cleaned.slice(0, MAX_EXTRACTED_CHARS)
    : cleaned;
}

/**
 * Extract plain text from an uploaded document buffer.
 * Throws a clear error on unsupported types, oversized input, or empty output.
 */
export async function extractText(
  filename: string,
  mimeType: string,
  buffer: Buffer
): Promise<string> {
  if (!buffer || buffer.length === 0) {
    throw new Error("Empty file — nothing to extract");
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      `File too large (${Math.round(buffer.length / 1024 / 1024)}MB, max ${MAX_FILE_BYTES / 1024 / 1024}MB)`
    );
  }

  const ext = extByName(filename);
  const mime = (mimeType || "").toLowerCase();

  let text: string;

  if (TEXT_MIME.has(mime) || ext === "txt" || ext === "md" || ext === "markdown") {
    text = buffer.toString("utf8");
  } else if (PDF_MIME.has(mime) || ext === "pdf") {
    // pdf-parse is CommonJS; import default lazily to avoid startup cost
    const mod = await import("pdf-parse");
    const pdfParse = (mod as unknown as { default: (b: Buffer) => Promise<{ text: string }> })
      .default;
    const parsed = await pdfParse(buffer);
    text = parsed.text;
  } else if (DOCX_MIME.has(mime) || ext === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else {
    throw new Error(
      `Unsupported file type "${mimeType || ext || "unknown"}". Accepted: .txt, .md, .pdf, .docx`
    );
  }

  const capped = cap(text);
  if (!capped) {
    throw new Error("No readable text could be extracted from this file");
  }

  logger.info(
    { filename, mimeType: mime, chars: capped.length },
    "[Library] Extracted document text"
  );

  return capped;
}
