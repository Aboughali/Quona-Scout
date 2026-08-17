/**
 * CLI:  npm run scan:verify [-- --run=scan_YYYYMMDD_HHMMSS]
 *
 * Compares a staged run against the live store and reports exactly what promotion would do.
 * READ-ONLY: this command never writes to the live store, to staging, or to the run log.
 *
 * Exits 1 when promotion would be refused -- notably when `potentiallyDropped > 0`.
 *
 * With no --run, verifies the most recent staged run.
 */

import { pathToFileURL } from 'node:url';
import { listStagingRuns, validateStagingRun } from './staging.mjs';

export async function executeVerify({ runId = null, log = () => {} } = {}) {
  let target = runId;
  if (!target) {
    const runs = await listStagingRuns();
    if (!runs.length) return { ok: false, error: 'No staged runs found. Run a scan or backfill first.' };
    target = runs[runs.length - 1];
    log(`No --run given; verifying the most recent staged run: ${target}\n`);
  }

  const v = await validateStagingRun(target);

  log(`Staged run              : ${v.runId}  (mode: ${v.mode}, status: ${v.status})`);
  log('');
  log(`Current findings        : ${v.currentFindings}`);
  log(`Proposed findings       : ${v.proposedFindings}`);
  log(`New findings            : ${v.newFindings}`);
  log(`Existing retained       : ${v.existingRetained}`);
  log(`Potentially dropped     : ${v.potentiallyDropped}`);
  log(`Duplicate findings      : ${v.duplicateFindings}`);
  log('');
  log(`Signals existing        : ${v.signalsExisting}`);
  log(`Signals new             : ${v.signalsNew}`);
  log(`Signals retained        : ${v.signalsRetained}`);
  log(`Signals after merge     : ${v.signalsAfterMerge}`);
  log('');

  if (v.ok) {
    log(`VALIDATED -- safe to promote.`);
    log(`  npm run scan:promote -- --run=${v.runId}`);
  } else {
    log(`REJECTED -- promotion would lose data:`);
    for (const r of v.reasons) log(`  - ${r}`);
    if (v.droppedSample.length) {
      log(`  sample of findings that would be dropped:`);
      for (const d of v.droppedSample) log(`    ${d}`);
    }
  }
  return v;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  executeVerify({ runId: arg('run'), log: (m) => console.log(m) })
    .then((r) => {
      if (r.error) { console.error(r.error); process.exit(1); }
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
