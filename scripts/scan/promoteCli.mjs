/**
 * CLI:  npm run scan:promote -- --run=scan_YYYYMMDD_HHMMSS
 *
 * The ONLY command that merges a staged scan into the live news store. Deliberately separate
 * from the scan itself: a long-running scan must not mutate production data as it goes.
 *
 * Promotion re-runs validation first (the live store may have moved since scan:verify), takes an
 * automatic pre-write backup, and writes atomically. If validation fails, nothing is written.
 *
 * --allow-destructive-change is the explicit, deliberately verbose opt-in for the one case the
 * guard would otherwise block: genuinely removing findings. No scan, backfill, enrich or verify
 * command can pass it, and it prints exactly what it is about to destroy.
 */

import { pathToFileURL } from 'node:url';
import { promoteStagingRun, validateStagingRun, listStagingRuns } from './staging.mjs';

export async function executePromote({ runId = null, allowDestructive = false, log = () => {} } = {}) {
  let target = runId;
  if (!target) {
    const runs = await listStagingRuns();
    if (!runs.length) return { ok: false, error: 'No staged runs found.' };
    target = runs[runs.length - 1];
    log(`No --run given; promoting the most recent staged run: ${target}`);
  }

  const pre = await validateStagingRun(target);
  if (!pre.ok && !allowDestructive) {
    log(`REJECTED -- ${target} did not pass validation:`);
    for (const r of pre.reasons) log(`  - ${r}`);
    log('');
    log('The live store has NOT been modified.');
    log('If you genuinely intend to remove findings, re-run with --allow-destructive-change.');
    return { ok: false, validation: pre };
  }

  if (allowDestructive && !pre.ok) {
    log(`!! DESTRUCTIVE PROMOTION: ${pre.potentiallyDropped} finding(s) will be REMOVED from the live store.`);
    log('!! A pre-write backup is being taken in backups/auto/ first.');
  }

  const result = await promoteStagingRun(target, { allowDestructive, log });
  log('');
  log(`Promoted ${target}: findings ${result.before} -> ${result.after}.`);
  if (result.writeReport?.backup) log(`Pre-write backup: ${result.writeReport.backup}`);
  return result;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  const allowDestructive = process.argv.includes('--allow-destructive-change');
  executePromote({ runId: arg('run'), allowDestructive, log: (m) => console.log(m) })
    .then((r) => {
      if (r.error) { console.error(r.error); process.exit(1); }
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
