/**
 * Traction: investor-supplied evidence that a company is working.
 *
 * Two ways in, both landing in the same list on the company profile:
 *   UPLOAD  -- a pitch deck, financial model or KPI export. The file is stored server-side and
 *              the AI agent reads it and writes 2-3 bulleted updates (see scripts/traction/).
 *   MANUAL  -- the investor types the numbers in directly. No model involved: the data is
 *              already structured, so summarising it would only add a chance to get it wrong.
 *
 * WHERE THE STATE LIVES. Entries sit in localStorage alongside field edits, commentary and
 * manually-added companies -- they are investor judgment layered on top of the static dataset,
 * exactly like those, and they ride the same backup/restore flow. Only the uploaded FILE lives
 * on disk (it is far too big for localStorage), referenced here by `filePath`.
 *
 * Provenance is never lost: every entry records who added it, when, and whether the bullets
 * came from the model or from a person. `aiStatus` is what the UI labels each card with, so a
 * generated summary can never be mistaken for a hand-checked one.
 */

export type TractionKind = 'pitch-deck' | 'financials' | 'other' | 'manual';

export type TractionAiStatus =
  /** The model read the document and found traction metrics. */
  | 'summarised'
  /** The model read the document but there was no traction evidence in it. */
  | 'no-traction-found'
  /** No summary exists -- unreadable file, no API key, or the call failed. `aiNote` says why. */
  | 'unavailable'
  /** Entered by hand; no model was involved. */
  | 'manual';

export interface TractionMetric {
  label: string;
  value: string;
}

export interface TractionEntry {
  id: string;
  companyId: string;
  kind: TractionKind;
  addedAt: string;
  addedBy: string;

  /** 2-3 bullets: model-written for uploads, derived from the typed metrics for manual entries. */
  bullets: string[];
  aiStatus: TractionAiStatus;
  /** Plain-language explanation shown on the card when there is no usable summary. */
  aiNote?: string | null;

  // --- uploads only ---
  fileName?: string;
  fileSizeBytes?: number;
  /** Server-relative path under data/traction; resolved by GET /api/traction/file. */
  filePath?: string;
  /** What the model judged the document to be ("Pitch deck", "Management accounts"). */
  docKind?: string;
  /** Period the figures cover, as stated in the document. */
  period?: string | null;
  model?: string;
  truncated?: boolean;
  estimatedCostUsd?: number | null;

  // --- manual entries only ---
  title?: string;
  metrics?: TractionMetric[];
  asOf?: string;
  sourceLabel?: string;
  note?: string;
}

export type TractionStore = Record<string, TractionEntry[]>; // companyId -> entries

const TRACTION_KEY = 'quona-scout-traction-v1';

export function loadTraction(): TractionStore {
  try {
    const raw = localStorage.getItem(TRACTION_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveTraction(store: TractionStore) {
  localStorage.setItem(TRACTION_KEY, JSON.stringify(store));
}

export function addTraction(store: TractionStore, entry: TractionEntry): TractionStore {
  const existing = store[entry.companyId] ?? [];
  return { ...store, [entry.companyId]: [...existing, entry] };
}

export function removeTraction(store: TractionStore, companyId: string, entryId: string): TractionStore {
  const existing = store[companyId] ?? [];
  return { ...store, [companyId]: existing.filter((e) => e.id !== entryId) };
}

// ---------------------------------------------------------------------------
// Upload client
// ---------------------------------------------------------------------------

/** Where the analyser lives. Today the Vite dev-server middleware; pointing this at a deployed
 *  function later is a one-line change, because the response shape is the same. */
const TRACTION_ENDPOINT = '/api/traction';

export const ACCEPTED_UPLOAD_TYPES = '.pdf,.xlsx,.xlsm,.docx,.pptx,.csv,.tsv,.txt,.md,.json';

/** Header values must be ASCII; filenames and company names routinely are not. */
const encodeHeader = (value: string) => encodeURIComponent(value ?? '');

export interface UploadResult {
  ok: boolean;
  entry?: Omit<TractionEntry, 'addedBy' | 'addedAt'> & { uploadedAt: string };
  error?: string;
}

/**
 * Sends the file to the analyser as raw bytes. Returns ok:false only when the request itself
 * failed -- a document that could not be summarised still comes back ok:true with an entry
 * whose `aiStatus` is 'unavailable' and whose `aiNote` explains why, because the upload itself
 * succeeded and the file is stored.
 */
export async function uploadTractionDocument(args: {
  file: File;
  companyId: string;
  companyName: string;
  kind: TractionKind;
}): Promise<UploadResult> {
  const { file, companyId, companyName, kind } = args;
  try {
    const res = await fetch(TRACTION_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-company-id': encodeHeader(companyId),
        'x-company-name': encodeHeader(companyName),
        'x-file-name': encodeHeader(file.name),
        'x-kind': encodeHeader(kind),
      },
      body: file,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `Upload failed (HTTP ${res.status}).` };
    return { ok: true, entry: data.entry };
  } catch (err) {
    // A thrown fetch means the response never arrived, which has two very different causes:
    // no dev server, or a request the server closed on us. Guessing "server unreachable" for
    // both sent people looking for a broken analyser when the real problem was an oversized
    // file, so the size is reported first when it is the likelier explanation.
    const sizeMb = file.size / 1024 / 1024;
    if (sizeMb > 25) {
      return {
        ok: false,
        error:
          `The upload did not complete — "${file.name}" is ${sizeMb.toFixed(0)}MB, which may exceed ` +
          'what the local analyser accepts. Export a lighter version and try again.',
      };
    }
    return {
      ok: false,
      error:
        'Could not reach the local analyser. It is served by the Vite dev server, so it is only ' +
        `available under \`npm run dev\` (not \`vite preview\` or a static build). ${(err as Error).message}`,
    };
  }
}

/** Link that re-opens a stored document in a new tab. */
export function tractionFileUrl(filePath: string): string {
  return `${TRACTION_ENDPOINT}/file?path=${encodeURIComponent(filePath)}`;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export const KIND_LABEL: Record<TractionKind, string> = {
  'pitch-deck': 'Pitch deck',
  financials: 'Financials',
  other: 'Document',
  manual: 'Manual entry',
};

export function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Manual entries get their bullets built deterministically from the typed metrics, so every
 *  card in the list reads the same way whether a person or the model produced it. The period is
 *  deliberately NOT repeated per bullet -- the card header already carries it once. */
export function bulletsFromMetrics(metrics: TractionMetric[], note?: string): string[] {
  const filled = metrics.filter((m) => m.label.trim() && m.value.trim());
  const bullets = filled.slice(0, 3).map((m) => `${m.label.trim()}: ${m.value.trim()}`);
  if (bullets.length < 3 && note?.trim()) bullets.push(note.trim());
  return bullets;
}
