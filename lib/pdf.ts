/**
 * A PDF of plain text, written by hand.
 *
 * A cover letter has to become a file twice over: a form with a second
 * upload box wants one beside the resume, and on a phone the only way to
 * get something into a file picker is to have it on the device already.
 *
 * No library for it. Every PDF toolkit in npm is megabytes of font
 * machinery for a job that is one typeface, one size and left-aligned
 * text, and a serverless function pays for its size on every cold start.
 * What follows is the whole format needed for that: a catalog, a page
 * tree, Helvetica, and a content stream of positioned lines.
 */

const PAGE_WIDTH = 595; // A4 at 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const FONT_SIZE = 11;
const LINE_HEIGHT = 15.5;

const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT);

/**
 * Helvetica is roughly half the point size per character, a little more
 * once you include capitals and punctuation. Erring wide costs a slightly
 * short line; erring narrow runs text off the page.
 */
const CHARS_PER_LINE = Math.floor(USABLE_WIDTH / (FONT_SIZE * 0.52));

/**
 * The base font has no glyphs beyond Latin-1, and a character it cannot
 * draw comes out as something else entirely. Curly quotes and dashes are
 * what an LLM actually produces, so they are folded to the plain forms
 * rather than dropped.
 */
export function toLatin1(text: string): string {
  const swaps: [RegExp, string][] = [
    [/[‘’‚′]/g, "'"],
    [/[“”„″]/g, '"'],
    [/[–—−]/g, "-"],
    [/…/g, "..."],
    [/ /g, " "],
    [/[•●]/g, "-"],
    [/₹/g, "Rs."],
  ];
  let out = text;
  for (const [pattern, replacement] of swaps) out = out.replace(pattern, replacement);
  // Anything still outside Latin-1 has no glyph; a question mark at least
  // shows that something was there.
  return out.replace(/[^\x00-\xFF]/g, "?");
}

/** Parentheses and backslashes end a string literal early if left alone. */
function escapeText(text: string): string {
  return text.replace(/([\\()])/g, "\\$1");
}

/** Greedy wrap on whitespace, splitting any word longer than a line. */
export function wrapLines(text: string, width = CHARS_PER_LINE): string[] {
  const out: string[] = [];

  for (const paragraph of toLatin1(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }

    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      if (word.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        continue;
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }

  return out;
}

function contentStream(lines: string[]): string {
  const body = lines
    .map((line) => (line ? `(${escapeText(line)}) Tj T*` : "T*"))
    .join("\n");

  return [
    "BT",
    `/F1 ${FONT_SIZE} Tf`,
    `${LINE_HEIGHT} TL`,
    `${MARGIN} ${PAGE_HEIGHT - MARGIN - FONT_SIZE} Td`,
    body,
    "ET",
  ].join("\n");
}

/**
 * Text in, PDF bytes out.
 *
 * Offsets in the cross-reference table are byte counts from the start of
 * the file, so the body is assembled as buffers and measured as it goes
 * rather than built as one string and measured afterwards — a multi-byte
 * character would make those two disagree.
 */
export function textToPdf(text: string): Buffer {
  const all = wrapLines(text);
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(all.length, 1); i += LINES_PER_PAGE) {
    pages.push(all.slice(i, i + LINES_PER_PAGE));
  }

  const pageIds = pages.map((_, i) => 4 + i * 2);
  const objects: string[] = [];

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  pages.forEach((lines, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;

    const stream = contentStream(lines);
    const length = Buffer.byteLength(stream, "latin1");
    objects[contentId] = `<< /Length ${length} >>\nstream\n${stream}\nendstream`;
  });

  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (text: string) => {
    const buffer = Buffer.from(text, "latin1");
    chunks.push(buffer);
    offset += buffer.length;
  };

  push("%PDF-1.4\n");

  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    if (!objects[id]) continue;
    offsets[id] = offset;
    push(`${id} 0 obj\n${objects[id]}\nendobj\n`);
  }

  const xrefAt = offset;
  const count = objects.length;

  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    xref += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/** A file name a recruiter can find in a folder of downloads. */
export function coverLetterFilename(fullName: string, company: string): string {
  const slug = (value: string) =>
    toLatin1(value)
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const parts = [slug(fullName), "cover-letter", slug(company)].filter(Boolean);
  return `${parts.join("-") || "cover-letter"}.pdf`;
}
