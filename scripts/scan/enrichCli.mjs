/**
 * Phase 2 CLI: re-reads every stored finding, extracts structured facts, matches companies,
 * deduplicates funding events into signals, and writes both back.
 *
 * Safe to re-run: it is idempotent over the findings store and preserves user decisions on
 * signals. It never writes to companies.json.
 *
 *   npm run scan:enrich
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFindings, rewriteFindingsInPlace, mergeSignals } from './storage.mjs';
import { enrichFindings } from './enrich.mjs';

export async function executeEnrich({ log = () => {} } = {}) {
  const companies = JSON.parse(await readFile(path.join(process.cwd(), 'src', 'data', 'companies.json'), 'utf8'));
  const findings = await loadFindings();
  log(`${findings.length} findings, ${companies.length} companies in database.`);

  const { findings: enriched, signals, stats } = enrichFindings(findings, companies);

  // enrichFindings is 1:1 by construction (every finding is pushed before any `continue`), so
  // this maps position-for-position. rewriteFindingsInPlace re-checks that anyway: it fixes the
  // record set from what is on disk and rejects any mapper that drops or re-keys a finding.
  // Enrichment can therefore add fields but can never shrink the store.
  const writeReport = await rewriteFindingsInPlace((_f, i) => enriched[i], { operation: 'enrich' });
  log(`findings rewritten in place: ${writeReport.existingCount} -> ${writeReport.proposedCount} (0 dropped)`);

  const { signals: stored } = await mergeSignals(signals);

  log(`Matched to existing company : ${stats.matchedExisting}`);
  log(`Weak match -> needs review   : ${stats.needsReviewMatch}`);
  log(`No company match             : ${stats.unmatched}`);
  log(`Funding events detected      : ${stats.fundingEventsDetected}`);
  log(`  duplicate reports merged   : ${stats.signalsMerged}`);
  log(`  signals created            : ${stats.signalsCreated} (${stats.newCompanySignals} new company, ${stats.newRoundSignals} new round)`);
  log(`  below confidence floor     : ${stats.lowConfidenceIgnored}`);
  return { ok: true, ...stats, signals: stored.length };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  executeEnrich({ log: (m) => console.log(m) })
    .then(() => console.log('\nEnrichment complete.'))
    .catch((e) => { console.error(e); process.exit(1); });
}
