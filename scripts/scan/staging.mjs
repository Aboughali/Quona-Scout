/**
 * Staging for the scan layer.
 *
 * A long-running scan must never mutate production data as it goes. It writes into
 *
 *   staging/scan_<timestamp>/
 *       findings.json      the findings this run produced
 *       signals.json       the signals this run derived (optional)
 *       scan_report.json   what the run did, and whether it completed
 *
 * and only a separate, deliberate PROMOTE step merges that into the live store:
 *
 *   SCAN -> STAGING -> VALIDATE -> COMPARE AGAINST LIVE -> PROMOTE -> LIVE NEWS STORE
 *
 * If the scan crashes, is killed, or produces nonsense, the live store is untouched and the
 * staged run can simply be discarded. This is the structural answer to "a scan that finds
 * nothing must not empty the store": an incomplete run has no promote step at all.
 *
 * Two staging modes:
 *   'batch' (default)  findings.json holds only the NEW findings. Promotion appends them, so a
 *                      deletion is not even representable.
 *   'full'             findings.json holds a complete proposed dataset. Promotion runs it
 *                      through the same non-shrinking guard, so a short dataset is rejected.
 */

import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  loadFindings, loadSignals, appendFindings, writeFindingsGuarded, mergeSignals,
  appendScanRun, atomicWriteJson, identityOf, signalEventKey,
  DataLossError,
} from './storage.mjs';

/** Resolved per call, for the same reason as the paths in storage.mjs. */
export const stagingRoot = () => path.join(process.env.QUONA_DATA_ROOT || process.cwd(), 'staging');

export function stagingDirFor(runId) {
  return path.join(stagingRoot(), runId);
}

export function newRunId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `scan_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Writes a scan's output into its own staging directory.
 * `status` is 'complete' only when the caller reached the end of the run without throwing;
 * validation refuses to promote anything else.
 */
export async function writeStagingRun({
  runId = newRunId(), findings = [], signals = null, mode = 'batch', status = 'complete', report = {},
} = {}) {
  const dir = stagingDirFor(runId);
  await mkdir(dir, { recursive: true });

  await atomicWriteJson(path.join(dir, 'findings.json'), findings, { expectCount: findings.length });
  if (signals) {
    await atomicWriteJson(path.join(dir, 'signals.json'), signals, { expectCount: signals.length });
  }

  const scanReport = {
    runId,
    mode,
    status,
    stagedAt: new Date().toISOString(),
    findingsStaged: findings.length,
    signalsStaged: signals ? signals.length : 0,
    promoted: false,
    ...report,
  };
  await atomicWriteJson(path.join(dir, 'scan_report.json'), scanReport);
  return { runId, dir, report: scanReport };
}

export async function listStagingRuns() {
  if (!existsSync(stagingRoot())) return [];
  const entries = await readdir(stagingRoot(), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function readStagingRun(runId) {
  const dir = stagingDirFor(runId);
  if (!existsSync(dir)) throw new Error(`No staged run named ${runId} (looked in ${dir}).`);

  const reportPath = path.join(dir, 'scan_report.json');
  const findingsPath = path.join(dir, 'findings.json');
  const signalsPath = path.join(dir, 'signals.json');

  if (!existsSync(reportPath)) throw new Error(`Staged run ${runId} has no scan_report.json -- it did not finish staging.`);
  if (!existsSync(findingsPath)) throw new Error(`Staged run ${runId} has no findings.json.`);

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const findings = JSON.parse(await readFile(findingsPath, 'utf8'));
  const signals = existsSync(signalsPath) ? JSON.parse(await readFile(signalsPath, 'utf8')) : null;
  return { runId, dir, report, findings, signals };
}

/**
 * Compares a staged run against the live store WITHOUT touching anything.
 *
 * Returns a report with `ok`. `ok === false` means promotion is refused; the reasons say why.
 */
export async function validateStagingRun(runId) {
  const { report, findings: staged, signals: stagedSignals } = await readStagingRun(runId);
  const live = await loadFindings();
  const liveSignals = await loadSignals();

  const liveIds = new Set(live.map(identityOf));
  const reasons = [];

  let proposed;
  let newFindings = 0;
  let duplicates = 0;

  if (report.mode === 'full') {
    proposed = staged;
  } else {
    const seen = new Set(liveIds);
    const toAdd = [];
    for (const f of staged) {
      const id = identityOf(f);
      if (seen.has(id)) { duplicates += 1; continue; }
      seen.add(id);
      toAdd.push(f);
    }
    newFindings = toAdd.length;
    proposed = [...live, ...toAdd];
  }

  const proposedIds = new Set(proposed.map(identityOf));
  const dropped = [...liveIds].filter((id) => !proposedIds.has(id));
  const retained = liveIds.size - dropped.length;

  if (report.mode === 'full') {
    newFindings = [...proposedIds].filter((id) => !liveIds.has(id)).length;
    duplicates = staged.length - new Set(staged.map(identityOf)).size;
  }

  if (report.status !== 'complete') {
    reasons.push(`Staged run status is "${report.status}", not "complete" -- an unfinished run is never promoted.`);
  }
  if (dropped.length > 0) {
    reasons.push(`${dropped.length} live finding(s) would be dropped. Promotion must never remove findings.`);
  }
  if (proposed.length < live.length) {
    reasons.push(`Proposed dataset (${proposed.length}) is smaller than live (${live.length}).`);
  }

  // Signals are union-merged at promote time, so nothing can be lost; report the arithmetic.
  const liveSignalIds = new Set(liveSignals.map((s) => s.signal_id));
  const liveEventKeys = new Set(liveSignals.map(signalEventKey));
  const newSignals = (stagedSignals ?? []).filter(
    (s) => !liveSignalIds.has(s.signal_id) && !liveEventKeys.has(signalEventKey(s)),
  ).length;

  return {
    ok: reasons.length === 0,
    runId,
    mode: report.mode,
    status: report.status,
    currentFindings: live.length,
    proposedFindings: proposed.length,
    newFindings,
    existingRetained: retained,
    potentiallyDropped: dropped.length,
    duplicateFindings: duplicates,
    signalsExisting: liveSignals.length,
    signalsNew: newSignals,
    signalsRetained: liveSignals.length,
    signalsAfterMerge: liveSignals.length + newSignals,
    reasons,
    droppedSample: dropped.slice(0, 10),
  };
}

/**
 * Promotes a validated staged run into the live store.
 *
 * Validation is re-run here rather than trusted from an earlier call: the live store may have
 * changed since. Nothing is written unless validation passes.
 */
export async function promoteStagingRun(runId, { allowDestructive = false, log = () => {} } = {}) {
  const validation = await validateStagingRun(runId);
  if (!validation.ok && !allowDestructive) {
    throw new DataLossError(
      `REJECTED: staged run ${runId} did not pass validation.\n  - ${validation.reasons.join('\n  - ')}`,
      validation,
    );
  }

  const { report, findings: staged, signals: stagedSignals } = await readStagingRun(runId);
  const before = (await loadFindings()).length;

  let writeReport;
  if (report.mode === 'full') {
    writeReport = await writeFindingsGuarded(staged, { operation: `promote:${runId}`, allowDestructive });
  } else {
    writeReport = await appendFindings(staged);
  }
  log(`findings: ${before} -> ${(await loadFindings()).length}`);

  let signalReport = null;
  if (stagedSignals?.length) {
    signalReport = await mergeSignals(stagedSignals);
    log(`signals: ${signalReport.existingCount} -> ${signalReport.finalCount}`);
  }

  const finalCount = (await loadFindings()).length;

  await appendScanRun({
    runId,
    startedAt: report.startedAt ?? report.stagedAt,
    finishedAt: new Date().toISOString(),
    trigger: report.trigger ?? 'promote',
    scope: report.scope ?? null,
    dryRun: false,
    companiesSearched: report.companiesSearched ?? null,
    candidates: report.candidates ?? null,
    findingsStaged: staged.length,
    findingsAdded: finalCount - before,
    findingsExistingBefore: before,
    duplicates: validation.duplicateFindings,
    rejected: report.rejected ?? null,
    sourcesScanned: report.sourcesScanned ?? null,
    stagingSucceeded: report.status === 'complete',
    validationSucceeded: validation.ok,
    promoted: true,
    destructiveOverride: allowDestructive && !validation.ok,
    finalLiveFindingCount: finalCount,
    backup: writeReport.backup ?? null,
  });

  // Mark the staged run so it cannot be promoted twice.
  await atomicWriteJson(path.join(stagingDirFor(runId), 'scan_report.json'), {
    ...report, promoted: true, promotedAt: new Date().toISOString(), finalLiveFindingCount: finalCount,
  });

  return { ok: true, runId, before, after: finalCount, validation, writeReport, signalReport };
}

/** Deletes a staged run. Only ever touches staging/ -- never the live store. */
export async function discardStagingRun(runId) {
  const dir = stagingDirFor(runId);
  if (!existsSync(dir)) throw new Error(`No staged run named ${runId}.`);
  if (path.resolve(dir) === path.resolve(stagingRoot())) throw new Error('Refusing to remove the staging root.');
  await rm(dir, { recursive: true, force: true });
  return { discarded: runId };
}
