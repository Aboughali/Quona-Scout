/**
 * CLI:  npm run scan:discard -- --run=scan_YYYYMMDD_HHMMSS
 *       npm run scan:discard -- --list
 *
 * Throws away a staged scan without touching the live store. This is the "the scan produced bad
 * results" escape hatch: because a scan only ever writes to staging/, discarding it is a no-op
 * as far as the live news data is concerned.
 */

import { pathToFileURL } from 'node:url';
import { listStagingRuns, discardStagingRun, validateStagingRun } from './staging.mjs';

export async function executeDiscard({ runId = null, list = false, log = () => {} } = {}) {
  const runs = await listStagingRuns();

  if (list || !runId) {
    if (!runs.length) { log('No staged runs.'); return { ok: true, runs: [] }; }
    log('Staged runs:');
    for (const r of runs) {
      try {
        const v = await validateStagingRun(r);
        log(`  ${r}  staged=${v.proposedFindings - v.currentFindings + v.duplicateFindings} new=${v.newFindings} ${v.ok ? 'VALID' : 'REJECTED'}`);
      } catch {
        log(`  ${r}  (unreadable -- incomplete staging)`);
      }
    }
    if (!runId) { log('\nPass --run=<id> to discard one.'); return { ok: true, runs }; }
  }

  const result = await discardStagingRun(runId);
  log(`Discarded staged run ${runId}. The live news store was not touched.`);
  return { ok: true, ...result };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  executeDiscard({ runId: arg('run'), list: process.argv.includes('--list'), log: (m) => console.log(m) })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
