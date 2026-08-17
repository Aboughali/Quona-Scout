/**
 * Disk storage for uploaded traction documents.
 *
 * WHAT LIVES WHERE, and why:
 *   - The FILE itself lives here, on disk, under data/traction/<companyId>/. It is far too
 *     large for localStorage and the investor needs to be able to re-open the original.
 *   - The ENTRY (title, bullets, who added it, when) lives in the browser's edit layer, next to
 *     field overrides and commentary, so it travels with the existing backup/restore flow.
 *   - uploads.json here is an append-only AUDIT LOG of what was uploaded and what the model
 *     said about it. It is never read by the UI; it exists so a summary can be traced back to
 *     a file, a model, and a moment in time even if the browser store is cleared.
 *
 * Same single-responsibility split as scripts/scan/storage.mjs: this is the only traction file
 * that touches disk, so moving the endpoint to a real server means replacing this module alone.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
export const TRACTION_DIR = path.join(ROOT, 'data', 'traction');
export const UPLOAD_LOG_PATH = path.join(TRACTION_DIR, 'uploads.json');

/**
 * Makes a user-supplied filename safe to write. Strips any directory component and anything
 * that is not a plain filename character, so a crafted name cannot escape TRACTION_DIR.
 */
export function safeFileName(fileName = 'upload') {
  const base = path.basename(String(fileName)).replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  const cleaned = base.replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'upload';
}

/** Company ids are internal slugs; the same guard applies since they become a directory name. */
function safeCompanyId(companyId = 'unknown') {
  return String(companyId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Writes the uploaded bytes to disk.
 * @returns {Promise<{id:string, storedAs:string, relPath:string, sizeBytes:number}>}
 *          relPath is what the UI keeps, and what GET /api/traction/file resolves.
 */
export async function saveUpload(companyId, fileName, buffer) {
  const id = uid();
  const dir = safeCompanyId(companyId);
  const storedAs = `${id}-${safeFileName(fileName)}`;
  const absDir = path.join(TRACTION_DIR, dir);
  await mkdir(absDir, { recursive: true });
  await writeFile(path.join(absDir, storedAs), buffer);
  return { id, storedAs, relPath: `${dir}/${storedAs}`, sizeBytes: buffer.length };
}

/**
 * Resolves a stored file's path, refusing anything that escapes TRACTION_DIR. Callers must
 * treat a null return as "not found" -- never fall back to the raw input path.
 */
export function resolveStoredFile(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  const abs = path.resolve(TRACTION_DIR, relPath);
  const root = path.resolve(TRACTION_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return existsSync(abs) ? abs : null;
}

export async function loadUploadLog() {
  if (!existsSync(UPLOAD_LOG_PATH)) return [];
  try {
    const parsed = JSON.parse(await readFile(UPLOAD_LOG_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append-only: an upload record is never rewritten, so the trail stays immutable. */
export async function appendUploadLog(record) {
  const log = await loadUploadLog();
  log.push(record);
  await mkdir(TRACTION_DIR, { recursive: true });
  await writeFile(UPLOAD_LOG_PATH, JSON.stringify(log, null, 2) + '\n');
  return log.length;
}
