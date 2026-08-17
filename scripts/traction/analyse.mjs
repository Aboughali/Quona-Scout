/**
 * Shared entry point for a traction upload: bytes in, a stored file plus 2-3 bullets out.
 *
 * Deliberately mirrors executeScan() in scripts/scan/cli.mjs -- one exported function that does
 * the whole job and returns a JSON-serializable result, with the HTTP layer (vite.config.ts)
 * acting as a thin adapter. Moving this behind a real server later means calling this same
 * function from a different wrapper.
 *
 * The file is saved BEFORE the model is called, and the entry is returned even when the model
 * call fails. An upload that cannot be summarised is still a document on the company's profile
 * with a stated reason -- it is never silently dropped, and the investor can type the bullets
 * themselves.
 */

import { loadEnv } from '../scan/cli.mjs';
import { extractDocument, SUPPORTED_EXTENSIONS } from './extract.mjs';
import { summariseTraction, MODEL } from './summarise.mjs';
import { saveUpload, appendUploadLog } from './storage.mjs';

export { SUPPORTED_EXTENSIONS };

/**
 * @param {object} args
 * @param {string} args.companyId
 * @param {string} [args.companyName]
 * @param {string} args.fileName
 * @param {'pitch-deck'|'financials'|'other'} [args.kind]  what the investor said they were uploading
 * @param {Buffer} args.buffer
 * @param {(msg: string) => void} [args.log]
 */
export async function analyseUpload({ companyId, companyName, fileName, kind = 'other', buffer, log = () => {} }) {
  await loadEnv();

  if (!companyId) return { ok: false, error: 'No company specified for this upload.' };
  if (!buffer?.length) return { ok: false, error: 'The uploaded file was empty.' };

  const stored = await saveUpload(companyId, fileName, buffer);
  log(`Stored ${fileName} (${(buffer.length / 1024).toFixed(0)}KB) as ${stored.relPath}`);

  const base = {
    id: stored.id,
    companyId,
    kind,
    fileName,
    fileSizeBytes: stored.sizeBytes,
    filePath: stored.relPath,
    uploadedAt: new Date().toISOString(),
  };

  // --- extraction (deterministic, offline) ---
  let doc;
  try {
    doc = extractDocument(buffer, fileName);
    log(doc.kind === 'pdf' ? 'Sending PDF to the model as a document block.' : `Extracted ${doc.extractedChars} characters of text.`);
  } catch (err) {
    await appendUploadLog({ ...base, status: 'unreadable', error: err.message });
    return {
      ok: true,
      entry: { ...base, aiStatus: 'unavailable', aiNote: err.message, bullets: [] },
    };
  }

  // --- summarisation (the model call) ---
  try {
    const result = await summariseTraction({ doc, fileName, companyName });
    log(`Model returned ${result.bullets.length} bullet(s); ~$${result.estimatedCostUsd ?? 0} at list price.`);

    const entry = {
      ...base,
      bullets: result.bullets,
      aiStatus: result.hasTractionData ? 'summarised' : 'no-traction-found',
      aiNote: result.hasTractionData
        ? null
        : 'The model found no traction metrics in this document. It is stored here, but add the numbers manually if they live elsewhere.',
      docKind: result.docKind,
      period: result.period,
      model: result.model,
      truncated: Boolean(doc.truncated),
      estimatedCostUsd: result.estimatedCostUsd,
    };
    await appendUploadLog({ ...entry, status: 'ok', usage: result.usage });
    return { ok: true, entry };
  } catch (err) {
    log(`! Summary failed: ${err.message}`);
    await appendUploadLog({ ...base, status: 'summary-failed', error: err.message, model: MODEL });
    return {
      ok: true,
      entry: {
        ...base,
        bullets: [],
        aiStatus: 'unavailable',
        // Surfaced verbatim in the UI: the investor should see exactly why there is no summary
        // rather than an empty card that looks like the document said nothing.
        aiNote: err.message,
      },
    };
  }
}
