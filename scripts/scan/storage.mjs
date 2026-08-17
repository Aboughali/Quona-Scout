/**
 * File-backed storage for the scan layer -- HARDENED.
 *
 * This is the ONLY part of the scan pipeline that touches disk, which is what makes runScan.mjs
 * portable: swapping this module for a database/KV adapter is all that is needed to move the
 * weekly scan to a serverless function.
 *
 * Findings are append-only and live in their own file. Nothing here writes to companies.json,
 * funds.json, investor_framework.json, or the browser's manual-override store.
 *
 * ---------------------------------------------------------------------------------------------
 * SAFETY MODEL (added after the 2026-08-16 regression, in which an ad-hoc reset filtered the
 * store from 209 findings down to 75 and the loss went unnoticed because nothing verified it)
 *
 *   1. STRICT LOADING     A malformed/truncated/empty findings file THROWS. It is never
 *                         laundered into [], because [] flowing into a whole-file write is
 *                         exactly how a corrupt read becomes total data loss.
 *   2. NO BLIND REPLACE   saveFindings() is gone. Every write goes through a guard that asserts
 *                         no existing finding_id disappeared and the count did not shrink.
 *   3. ATOMIC WRITES      Write .tmp -> fsync -> re-read and re-parse -> rename(). A crash
 *                         mid-write leaves the previous complete file, never a truncated one.
 *   4. PRE-WRITE BACKUP   Every live mutation snapshots the previous version to backups/auto/
 *                         first, under a unique name. Backups are never overwritten.
 *   5. EXPLICIT DESTRUCT  Shrinking the store is possible only via an explicit opt-in that no
 *                         ordinary scan/backfill/enrich command passes.
 *
 * The invariant that would have caught the incident regardless of its cause is #2 + #5: no
 * normal operation can reduce the findings count.
 * ---------------------------------------------------------------------------------------------
 */

import { readFile, mkdir, rename, open, copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Paths are resolved PER CALL rather than captured at module load.
 *
 * That is deliberate: a module-level constant bakes in whatever cwd/env existed at first import,
 * which makes the store impossible to redirect afterwards -- tests end up sharing one root, and
 * a future serverless adapter cannot rebind it either. QUONA_DATA_ROOT lets the test suite point
 * every path at a throwaway directory, so no test can reach the real store.
 */
function root() {
  return process.env.QUONA_DATA_ROOT || process.cwd();
}

export const configPath = () => path.join(root(), 'config', 'news_sources.json');
export const findingsPath = () => path.join(root(), 'src', 'data', 'news_findings.json');
export const scanLogPath = () => path.join(root(), 'src', 'data', 'scan_runs.json');
/** Phase 2: proposed database changes awaiting approval. Never company data itself. */
export const signalsPath = () => path.join(root(), 'src', 'data', 'news_signals.json');
/** Automatic pre-write snapshots. One per mutation, never overwritten. */
export const autoBackupDir = () => path.join(root(), 'backups', 'auto');

/** Raised whenever a write would lose data. Callers should let it propagate: the whole point is
 *  that the operation stops and the live file is left alone. */
export class DataLossError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DataLossError';
    this.details = details;
  }
}

/** Raised when a store on disk cannot be trusted. Never downgraded to an empty array. */
export class CorruptStoreError extends Error {
  constructor(message, filePath) {
    super(message);
    this.name = 'CorruptStoreError';
    this.filePath = filePath;
  }
}

// ---------------------------------------------------------------------------
// Strict reading
// ---------------------------------------------------------------------------

/**
 * Reads a JSON array, refusing to guess.
 *
 * A MISSING file returns [] -- that is genesis, the legitimate state before the first scan.
 * A file that EXISTS but is empty, truncated, malformed, or not an array throws, because those
 * are corruption, and the difference matters: only one of them is safe to build a write on.
 */
async function readJsonArrayStrict(filePath, label) {
  if (!existsSync(filePath)) return [];

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new CorruptStoreError(`${label} exists but could not be read: ${err.message}`, filePath);
  }

  if (raw.trim() === '') {
    throw new CorruptStoreError(
      `${label} is empty. Refusing to continue -- an empty store is indistinguishable from ` +
      `total data loss. Restore from backups/auto/ or backups/ before retrying.`,
      filePath,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptStoreError(
      `${label} is not valid JSON (${err.message}). Refusing to continue -- the previous ` +
      `behaviour of treating this as an empty store is what turns corruption into deletion.`,
      filePath,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new CorruptStoreError(`${label} is valid JSON but not an array.`, filePath);
  }
  return parsed;
}

export async function loadConfig() {
  const raw = await readFile(configPath(), 'utf8');
  return JSON.parse(raw);
}

export async function loadFindings() {
  return readJsonArrayStrict(findingsPath(), 'news_findings.json');
}

export async function loadSignals() {
  return readJsonArrayStrict(signalsPath(), 'news_signals.json');
}

export async function loadScanRuns() {
  return readJsonArrayStrict(scanLogPath(), 'scan_runs.json');
}

// ---------------------------------------------------------------------------
// Atomic writing
// ---------------------------------------------------------------------------

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Snapshots the current version of `filePath` into backups/auto/ BEFORE it is modified.
 * Never overwrites an existing backup: if the same second already has one, a counter is added.
 * Returns the backup path, or null when there was nothing to back up yet.
 */
export async function backupBeforeWrite(filePath) {
  if (!existsSync(filePath)) return null;
  await mkdir(autoBackupDir(), { recursive: true });

  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let target = path.join(autoBackupDir(), `${base}_${stamp()}${ext}`);
  let n = 1;
  while (existsSync(target)) {
    target = path.join(autoBackupDir(), `${base}_${stamp()}_${n++}${ext}`);
  }
  await copyFile(filePath, target);
  return target;
}

/**
 * Writes JSON atomically.
 *
 *   tmp -> fsync -> read back and re-parse -> verify record count -> rename over the live path
 *
 * rename(2) is atomic on POSIX, so a reader either sees the entire old file or the entire new
 * one. The read-back is not paranoia theatre: it is what catches a short write or a full disk
 * BEFORE the bad bytes are promoted to the live path.
 */
export async function atomicWriteJson(filePath, data, { expectCount = null } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = JSON.stringify(data, null, 2) + '\n';

  let fh;
  try {
    fh = await open(tmp, 'w');
    await fh.writeFile(payload, 'utf8');
    await fh.sync();          // force to disk before we trust it
  } finally {
    await fh?.close();
  }

  // Verify the temp file independently of the buffer we just wrote.
  let verified;
  try {
    verified = JSON.parse(await readFile(tmp, 'utf8'));
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new CorruptStoreError(`Refusing to promote ${path.basename(filePath)}: the staged temp file did not parse (${err.message}).`, tmp);
  }

  if (expectCount !== null && Array.isArray(verified) && verified.length !== expectCount) {
    await unlink(tmp).catch(() => {});
    throw new DataLossError(
      `Refusing to promote ${path.basename(filePath)}: expected ${expectCount} records, temp file has ${verified.length}.`,
      { expectCount, actual: verified.length },
    );
  }

  await rename(tmp, filePath);   // atomic
  return filePath;
}

// ---------------------------------------------------------------------------
// The findings guard
// ---------------------------------------------------------------------------

/** Stable identity for a finding. Prefers the explicit key, falls back to id, then URL. */
export function identityOf(finding) {
  return finding.finding_key ?? finding.finding_id ?? finding.url ?? JSON.stringify(finding);
}

/**
 * The core invariant.
 *
 * Throws unless `proposed` is a superset of `existing`: same count or larger, and every existing
 * finding still present by identity. Returns a report when it passes.
 */
export function assertNoFindingsLost(existing, proposed, { operation = 'write' } = {}) {
  const existingIds = new Set(existing.map(identityOf));
  const proposedIds = new Set(proposed.map(identityOf));

  const missing = [...existingIds].filter((id) => !proposedIds.has(id));

  if (proposed.length < existing.length) {
    throw new DataLossError(
      `REJECTED (${operation}): proposed ${proposed.length} findings but ${existing.length} are stored. ` +
      `Normal operations must never reduce the findings count. ` +
      `If this removal is genuinely intended, use the explicit --allow-destructive-change path.`,
      { existingCount: existing.length, proposedCount: proposed.length, missingCount: missing.length, missing: missing.slice(0, 20) },
    );
  }

  if (missing.length > 0) {
    throw new DataLossError(
      `REJECTED (${operation}): ${missing.length} existing finding(s) would disappear, even though ` +
      `the total count did not shrink. Existing findings must never be dropped as a side effect.`,
      { existingCount: existing.length, proposedCount: proposed.length, missingCount: missing.length, missing: missing.slice(0, 20) },
    );
  }

  return {
    ok: true,
    existingCount: existing.length,
    proposedCount: proposed.length,
    added: proposed.length - existing.length,
    retained: existingIds.size,
    dropped: 0,
  };
}

/**
 * The single gate through which every findings write passes.
 *
 * `allowDestructive` exists so a future, deliberate cleanup is possible -- but no scan, backfill,
 * enrich or promote command passes it. It is reachable only from a command the operator types
 * with --allow-destructive-change.
 */
export async function writeFindingsGuarded(proposed, { operation = 'write', allowDestructive = false } = {}) {
  const existing = await loadFindings();

  let report;
  if (allowDestructive) {
    const existingIds = new Set(existing.map(identityOf));
    const proposedIds = new Set(proposed.map(identityOf));
    const missing = [...existingIds].filter((id) => !proposedIds.has(id));
    report = {
      ok: true, destructive: true,
      existingCount: existing.length, proposedCount: proposed.length,
      added: Math.max(0, proposed.length - existing.length),
      retained: existingIds.size - missing.length,
      dropped: missing.length,
    };
  } else {
    report = assertNoFindingsLost(existing, proposed, { operation });
  }

  const backup = await backupBeforeWrite(findingsPath());
  await atomicWriteJson(findingsPath(), proposed, { expectCount: proposed.length });
  return { ...report, backup };
}

/**
 * Appends new findings, skipping any whose identity is already stored.
 * Guaranteed non-shrinking by construction, and still routed through the guard.
 */
export async function appendFindings(newFindings) {
  const existing = await loadFindings();
  const seen = new Set(existing.map(identityOf));

  const toAdd = [];
  let duplicates = 0;
  for (const f of newFindings) {
    const id = identityOf(f);
    if (seen.has(id)) { duplicates += 1; continue; }
    seen.add(id);
    toAdd.push(f);
  }

  const merged = [...existing, ...toAdd];
  const report = await writeFindingsGuarded(merged, { operation: 'appendFindings' });
  return { total: merged.length, added: toAdd.length, duplicates, ...report };
}

/**
 * Enrichment's only write path. Maps over the stored findings and writes the result back.
 *
 * `mapFn` receives each finding and must return a finding -- it can add or update fields, but
 * the set of findings is fixed by this function, so enrichment structurally cannot drop one.
 * The guard still runs, as a second line of defence against a mapFn that returns undefined.
 */
export async function rewriteFindingsInPlace(mapFn, { operation = 'rewriteFindingsInPlace' } = {}) {
  const existing = await loadFindings();
  const updated = existing.map((f, i) => {
    const next = mapFn(f, i);
    if (!next || typeof next !== 'object') {
      throw new DataLossError(`REJECTED (${operation}): the mapper returned no finding at index ${i}.`, { index: i });
    }
    // Identity is not the mapper's to change.
    if (identityOf(next) !== identityOf(f)) {
      throw new DataLossError(
        `REJECTED (${operation}): the mapper changed the identity of the finding at index ${i} ` +
        `(${identityOf(f)} -> ${identityOf(next)}). Enrichment may add fields, never re-key records.`,
        { index: i },
      );
    }
    return next;
  });
  return writeFindingsGuarded(updated, { operation });
}

/**
 * REMOVED. This function replaced the entire findings store with whatever it was handed, which
 * is the mechanism behind the 2026-08-16 loss. It is kept as a loud failure so that any leftover
 * caller -- or an ad-hoc script pasted from an old transcript -- breaks immediately and visibly
 * instead of quietly deleting the store.
 */
export async function saveFindings() {
  throw new DataLossError(
    'saveFindings() has been removed because it could replace the entire findings store.\n' +
    '  - To add findings:    appendFindings(newFindings)\n' +
    '  - To enrich in place: rewriteFindingsInPlace(mapFn)\n' +
    '  - To promote a scan:  promoteStaging(runId)   (see staging.mjs)\n' +
    'All three refuse to shrink the store.',
  );
}

// ---------------------------------------------------------------------------
// Config + run log
// ---------------------------------------------------------------------------

export async function saveConfig(config) {
  await backupBeforeWrite(configPath());
  await atomicWriteJson(configPath(), config);
}

/** Kept generous: the run log is the audit trail that makes a silent regression detectable. */
const MAX_SCAN_RUNS = 500;

export async function appendScanRun(run) {
  const runs = await loadScanRuns();
  runs.push(run);
  const trimmed = runs.slice(-MAX_SCAN_RUNS);
  await backupBeforeWrite(scanLogPath());
  await atomicWriteJson(scanLogPath(), trimmed, { expectCount: trimmed.length });
  return trimmed.length;
}

/** Writes lastScan/lastSuccess back into the source config after a run. */
export async function recordSourceResults(config, sourceResults) {
  for (const result of sourceResults) {
    const source = config.sources.find((s) => s.name === result.name);
    if (!source) continue;
    source.lastScan = result.scannedAt ?? new Date().toISOString();
    if (result.status === 'ok' && result.kept > 0) source.lastSuccess = source.lastScan;
  }
  await saveConfig(config);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Event identity, used when a re-derived signal has a fresh signal_id but describes the same
 *  financing event. signal_id is generated with Date.now(), so it is NOT stable across runs. */
export function signalEventKey(sig) {
  return `${sig.company_key}|${sig.round_type || ''}|${sig.funding_amount ?? ''}`;
}

/**
 * Merges freshly-derived signals with stored ones as a UNION.
 *
 * The previous implementation built its output from `incoming` alone, so any stored signal the
 * current scan did not rediscover was silently dropped -- which is why the three MoneyHash
 * signals were one enrich run away from being lost permanently.
 *
 * Rules:
 *   - Every stored signal survives, rediscovered or not.
 *   - A stored signal the scan re-derives is refreshed with new evidence, but the user's
 *     decision (approved/ignored) and its timestamps are preserved and never reset to pending.
 *   - Sources are unioned by URL, so corroboration accumulates instead of being replaced.
 */
export async function mergeSignals(incoming) {
  const existing = await loadSignals();

  const byId = new Map(existing.map((s) => [s.signal_id, s]));
  const byEvent = new Map(existing.map((s) => [signalEventKey(s), s]));

  for (const sig of incoming) {
    const prior = byId.get(sig.signal_id) ?? byEvent.get(signalEventKey(sig));

    if (!prior) {
      byId.set(sig.signal_id, sig);
      byEvent.set(signalEventKey(sig), sig);
      continue;
    }

    // Union the evidence by URL -- never replace the stored source list.
    const seenUrls = new Set((prior.sources ?? []).map((s) => s.url));
    const mergedSources = [...(prior.sources ?? [])];
    for (const s of sig.sources ?? []) {
      if (!seenUrls.has(s.url)) { seenUrls.add(s.url); mergedSources.push(s); }
    }

    const decided = prior.status && prior.status !== 'pending';
    const merged = {
      ...sig,
      signal_id: prior.signal_id,
      // The user's decision wins, always.
      status: decided ? prior.status : (sig.status ?? prior.status),
      decided_at: prior.decided_at,
      decided_by: prior.decided_by,
      company_id: prior.company_id ?? sig.company_id,
      created_at: prior.created_at ?? sig.created_at,
      updated_at: new Date().toISOString(),
      sources: mergedSources,
      source_count: mergedSources.length,
    };
    byId.set(merged.signal_id, merged);
    byEvent.set(signalEventKey(merged), merged);
  }

  const out = [...byId.values()];

  // Signals are union-merged, so this is a genuine invariant, not a courtesy check.
  if (out.length < existing.length) {
    throw new DataLossError(
      `REJECTED (mergeSignals): ${existing.length} signals stored but the merge produced ${out.length}.`,
      { existingCount: existing.length, proposedCount: out.length },
    );
  }
  const lostIds = existing.map((s) => s.signal_id).filter((id) => !byId.has(id));
  if (lostIds.length) {
    throw new DataLossError(
      `REJECTED (mergeSignals): ${lostIds.length} stored signal(s) would disappear.`,
      { lost: lostIds.slice(0, 20) },
    );
  }

  const backup = await backupBeforeWrite(signalsPath());
  await atomicWriteJson(signalsPath(), out, { expectCount: out.length });
  return { signals: out, existingCount: existing.length, finalCount: out.length, backup };
}
