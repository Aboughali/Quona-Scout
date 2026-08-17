/**
 * Turns an uploaded traction document into something the model can actually read.
 *
 * Two output shapes, because they cost very different amounts:
 *   { kind: 'pdf',   base64 }  -- PDFs go to the API as a native document block, so Claude sees
 *                                 the slides as laid out (charts, tables, screenshots included).
 *   { kind: 'text',  text }    -- everything else is converted to plain text HERE, locally, so
 *                                 only the extracted characters are ever billed as input.
 *
 * The OOXML formats (.xlsx/.docx/.pptx) are ZIP archives of XML, so they are unzipped and the
 * text nodes are pulled out directly. That keeps a financial model's numbers intact without
 * shipping the whole binary to the API.
 *
 * NOTHING HERE CALLS THE MODEL. Extraction is deterministic and offline; summarise.mjs is the
 * only file that talks to Anthropic. That split means a parsing bug can never be mistaken for
 * a model hallucination, and an unsupported file type fails loudly before any spend occurs.
 */

import { unzipSync, strFromU8 } from 'fflate';

/** Hard ceiling on extracted text handed to the model. A 200-tab financial model can run to
 *  millions of characters; the traction story is always in the first pages. */
const MAX_TEXT_CHARS = 120_000;
/** The Messages API caps a request at 32MB, and base64 inflates by ~33%. Stay well under. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Widest row reconstructed from a spreadsheet. Guards against a stray cell at column ZZ
 *  turning every row into thousands of empty tabs. */
const MAX_SHEET_COLUMNS = 64;

export const SUPPORTED_EXTENSIONS = [
  '.pdf', '.xlsx', '.xlsm', '.docx', '.pptx', '.csv', '.tsv', '.txt', '.md', '.json',
];

function extensionOf(fileName = '') {
  const m = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

function truncate(text) {
  // Strip control characters (common in exported spreadsheets) but keep tabs and newlines,
  // which carry the table structure the model reads the numbers out of.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  const clean = (text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
  if (clean.length <= MAX_TEXT_CHARS) return { text: clean, truncated: false };
  return { text: `${clean.slice(0, MAX_TEXT_CHARS)}\n\n[... document truncated for length ...]`, truncated: true };
}

function xmlText(xml) {
  return xml
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * OOXML namespace prefixes are writer-dependent: Excel emits `<c>`/`<v>`, while the exporter
 * that produced this project's own spreadsheets emits `<x:c>`/`<x:v>`, and Word/PowerPoint use
 * `<w:t>`/`<a:t>`. Matching on the LOCAL name with an optional prefix is the only thing that
 * reads all of them -- assuming one writer's prefix is the bug that silently returns "" for
 * a perfectly readable file.
 */
const el = (localName) => `<(?:[A-Za-z0-9]+:)?${localName}`;
const endEl = (localName) => `<\\/(?:[A-Za-z0-9]+:)?${localName}>`;

/** Every `<tag>…</tag>` body in document order, prefix-tolerant. */
function textNodes(xml, localName) {
  const out = [];
  const re = new RegExp(`${el(localName)}(?:\\s[^>]*)?>([\\s\\S]*?)${endEl(localName)}`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(xmlText(m[1]));
  return out;
}

function unzip(buffer) {
  return unzipSync(new Uint8Array(buffer));
}

// ---------------------------------------------------------------------------
// .xlsx / .xlsm  -- financials
// ---------------------------------------------------------------------------

/** Spreadsheet cells store repeated strings once, in sharedStrings.xml, and reference them by
 *  index. Without resolving that table every text cell reads as a bare number. */
function sharedStrings(files) {
  const raw = files['xl/sharedStrings.xml'];
  if (!raw) return [];
  const xml = strFromU8(raw);
  // One <si> is one string, but it may be split across several <t> runs by formatting.
  const items = xml.match(new RegExp(`${el('si')}(?:\\s[^>]*)?>[\\s\\S]*?${endEl('si')}`, 'g')) || [];
  return items.map((si) => textNodes(si, 't').join(''));
}

/** Sheet display names in workbook order, mapped through the relationship file. Falls back to
 *  the on-disk file name, which is never wrong -- only less readable. */
function sheetNames(files) {
  const names = new Map();
  const workbook = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (!workbook || !rels) return names;

  const relTargets = new Map();
  // Attribute order is writer-dependent (Excel writes Id first, other exporters write Target
  // first), so each attribute is read independently rather than in a fixed sequence.
  for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relTargets.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }
  // `sheet\b` deliberately does not match the enclosing <sheets> wrapper.
  for (const m of strFromU8(workbook).matchAll(new RegExp(`${el('sheet')}\\b[^>]*>`, 'g'))) {
    const name = m[0].match(/\bname="([^"]*)"/)?.[1];
    const rid = m[0].match(/\br:id="([^"]*)"/)?.[1];
    const target = rid ? relTargets.get(rid) : null;
    if (name && target) names.set(`xl/${target}`, xmlText(name));
  }
  return names;
}

/** "AB12" -> 27. Cells carry their address, and honouring it keeps columns aligned even when
 *  the writer omits empty cells entirely -- which is what makes a financial table readable. */
function columnIndex(ref) {
  const letters = (ref || '').toUpperCase().match(/^[A-Z]+/)?.[0];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function extractXlsx(buffer) {
  const files = unzip(buffer);
  const strings = sharedStrings(files);
  const names = sheetNames(files);

  const sheetPaths = Object.keys(files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  // Matches both `<c ...>…</c>` and the self-closing `<c ... />` used for styled-but-empty cells.
  const cellRe = new RegExp(`${el('c')}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)${endEl('c')})`, 'g');
  const rowRe = new RegExp(`${el('row')}(?:\\s[^>]*)?>([\\s\\S]*?)${endEl('row')}`, 'g');

  const out = [];
  for (const path of sheetPaths) {
    const xml = strFromU8(files[path]);
    const lines = [];
    for (const rowMatch of xml.matchAll(rowRe)) {
      const cells = [];
      let cursor = 0;
      for (const cellMatch of rowMatch[1].matchAll(cellRe)) {
        const attrs = cellMatch[1] ?? '';
        const body = cellMatch[2] ?? '';
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];

        let value;
        if (type === 's') {
          value = strings[Number(textNodes(body, 'v')[0])] ?? '';
        } else if (type === 'inlineStr' || type === 'str') {
          value = textNodes(body, 't').join('') || textNodes(body, 'v').join('');
        } else {
          // Numeric (or date-serial) cells hold the raw value; the display format lives
          // elsewhere and is deliberately not applied -- the model reads the true number.
          value = textNodes(body, 'v')[0] ?? '';
        }

        const at = columnIndex(attrs.match(/\br="([^"]+)"/)?.[1]);
        const target = at >= 0 ? at : cursor;
        if (target < MAX_SHEET_COLUMNS) {
          while (cells.length < target) cells.push('');
          cells[target] = value;
          cursor = target + 1;
        }
      }
      // Drop rows that are entirely empty -- spreadsheets are full of spacer rows.
      if (cells.some((c) => c !== '')) lines.push(cells.join('\t'));
    }
    if (!lines.length) continue;
    out.push(`### Sheet: ${names.get(path) ?? path.split('/').pop()}\n${lines.join('\n')}`);
  }
  return out.join('\n\n');
}

// ---------------------------------------------------------------------------
// .docx / .pptx  -- decks and memos
// ---------------------------------------------------------------------------

function extractDocx(buffer) {
  const files = unzip(buffer);
  const doc = files['word/document.xml'];
  if (!doc) return '';

  // Paragraph boundaries carry meaning (a heading vs. its body), so they survive as newlines.
  const src = strFromU8(doc)
    .replace(new RegExp(endEl('p'), 'g'), '\n')
    .replace(new RegExp(`${el('tab')}\\b[^>]*\\/?>`, 'g'), '\t');

  const chunks = src.match(new RegExp(`${el('t')}(?:\\s[^>]*)?>[\\s\\S]*?${endEl('t')}|\\n|\\t`, 'g')) || [];
  return chunks
    .map((chunk) => (chunk === '\n' || chunk === '\t' ? chunk : xmlText(chunk.replace(/<[^>]+>/g, ''))))
    .join('')
    .replace(/\n{3,}/g, '\n\n');
}

function extractPptx(buffer) {
  const files = unzip(buffer);
  const slidePaths = Object.keys(files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  return slidePaths
    .map((path, i) => {
      const lines = textNodes(strFromU8(files[path]), 't').filter((t) => t.trim());
      return lines.length ? `### Slide ${i + 1}\n${lines.join('\n')}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------

/**
 * @param {Buffer|Uint8Array} buffer  raw uploaded bytes
 * @param {string} fileName
 * @returns {{ kind: 'pdf'|'text', base64?: string, text?: string, truncated?: boolean, extractedChars?: number }}
 * @throws {Error} with a user-facing message when the type is unsupported or the file is unreadable
 */
export function extractDocument(buffer, fileName) {
  const ext = extensionOf(fileName);

  if (ext === '.pdf') {
    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error(
        `PDF is ${(buffer.length / 1024 / 1024).toFixed(1)}MB; the API request limit allows about ` +
        `${MAX_PDF_BYTES / 1024 / 1024}MB. Export a lighter version (or split it) and re-upload.`
      );
    }
    return { kind: 'pdf', base64: Buffer.from(buffer).toString('base64') };
  }

  let text;
  try {
    if (ext === '.xlsx' || ext === '.xlsm') text = extractXlsx(buffer);
    else if (ext === '.docx') text = extractDocx(buffer);
    else if (ext === '.pptx') text = extractPptx(buffer);
    else if (['.csv', '.tsv', '.txt', '.md', '.json'].includes(ext)) text = Buffer.from(buffer).toString('utf8');
    else {
      throw new Error(
        `Unsupported file type "${ext || fileName}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}. ` +
        'Legacy .xls/.ppt/.doc must be re-saved in the modern format (or exported to PDF) first.'
      );
    }
  } catch (err) {
    if (err.message.startsWith('Unsupported file type')) throw err;
    throw new Error(`Could not read "${fileName}": ${err.message}`);
  }

  const { text: capped, truncated } = truncate(text);
  if (!capped) {
    throw new Error(
      `No readable text found in "${fileName}" -- it looks like a slide-image or scanned document ` +
      'with no text layer. Export it as PDF and upload that instead: PDFs are read visually, so ' +
      'image-only decks work fine.'
    );
  }
  return { kind: 'text', text: capped, truncated, extractedChars: capped.length };
}
