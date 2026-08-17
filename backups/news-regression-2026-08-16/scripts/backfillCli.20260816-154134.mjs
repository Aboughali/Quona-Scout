/**
 * CLI wrapper:  npm run scan:backfill
 *
 * Fills in the history the weekly feed scan structurally cannot see (see archiveSearch.mjs),
 * by asking each source's archive for every tracked company by name.
 *
 * Usage:
 *   npm run scan:backfill                      -- final-watchlist companies (fast first run)
 *   npm run scan:backfill -- --scope=stage4    -- everything through the geography gate
 *   npm run scan:backfill -- --scope=all       -- all 828 companies (slow)
 *   npm run scan:backfill -- --ids=enza,numida -- exactly these companies
 *   npm run scan:backfill -- --only=TechCabal  -- restrict to one source
 *   npm run scan:backfill -- --limit=10        -- first N companies, for a cheap trial run
 *   npm run scan:backfill -- --dry-run         -- report what it would store, write nothing
 *
 * Findings are appended to the same store the weekly scan writes, deduplicated on the same key,
 * so running this repeatedly is safe. It does NOT attach anything to a company: run
 * `npm run scan:enrich` afterwards and the normal 0.8-confidence gate applies.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runBackfill, selectCompanies } from './backfill.mjs';
import { findingKey } from './runScan.mjs';
import { loadConfig, loadFindings, appendFindings, appendScanRun } from './storage.mjs';

/** The company database is read-only here, exactly as in enrichCli.mjs. */
async function loadCompanies() {
  return JSON.parse(await readFile(path.join(process.cwd(), 'src', 'data', 'companies.json'), 'utf8'));
}

export async function executeBackfill({ log = () => {}, dryRun = false, scope = 'watchlist', only = null, limit = null, ids = null } = {}) {
  const config = await loadConfig();
  const allCompanies = await loadCompanies();
  const existing = await loadFindings();
  const seen = new Set(existing.map((f) => f.finding_key ?? findingKey(f.source_domain, f.url, f.headline)));

  // --ids wins over --scope. It exists because the watchlist the investor actually sees is
  // computed WITH their edits, which live in the browser's localStorage: a company cut at
  // Stage 4 by the ETL can sit on the final watchlist because of a manual override, and no
  // Node script can know that. Export the watchlist from the app and pass the ids here to
  // target it exactly; --scope=all is the blunt alternative that is guaranteed to include it.
  let companies;
  if (ids?.length) {
    const wanted = new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean));
    companies = allCompanies.filter((c) => wanted.has(c.id.toLowerCase()) || wanted.has(c.name.toLowerCase()));
    const missing = [...wanted].filter((w) =>
      !allCompanies.some((c) => c.id.toLowerCase() === w || c.name.toLowerCase() === w));
    if (missing.length) log(`! not in the database, skipped: ${missing.join(', ')}`);
  } else {
    companies = selectCompanies(allCompanies, scope);
  }
  if (limit) companies = companies.slice(0, limit);

  log(`${existing.length} findings already stored; ${companies.length} companies in scope (${ids?.length ? 'explicit ids' : scope}).`);

  const startedAt = new Date().toISOString();
  // selectCompanies already applied the scope, so pass the chosen list through untouched.
  const { findings, stats, perSource } = await runBackfill(config, companies, seen, log, {
    scope: 'all', scopeLabel: ids?.length ? `${companies.length} named ids` : scope, only,
  });

  if (!dryRun && findings.length) await appendFindings(findings);

  const run = {
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger: 'backfill',
    dryRun,
    scope: ids?.length ? 'explicit-ids' : scope,
    findingsAdded: dryRun ? 0 : findings.length,
    sourceResults: perSource.map((s) => ({ ...s, status: s.errors && !s.kept ? 'error' : 'ok' })),
    stats,
  };
  if (!dryRun) await appendScanRun(run);

  return { ok: true, ...run };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const scope = arg('scope') ?? 'watchlist';
  const limit = arg('limit') ? Number(arg('limit')) : null;
  const onlyArg = arg('only');
  const only = onlyArg ? onlyArg.split(',').filter(Boolean) : null;
  const idsArg = arg('ids');
  const ids = idsArg ? idsArg.split(',').filter(Boolean) : null;
  const dryRun = process.argv.includes('--dry-run');

  executeBackfill({ log: (m) => console.log(m), dryRun, scope, only, limit, ids })
    .then((result) => {
      const s = result.stats;
      console.log('\n--- Backfill summary ---');
      console.log(`Companies searched     : ${s.companiesSearched} (${s.companiesWithHits} with coverage found)`);
      console.log(`Archive searches       : ${s.requests}`);
      console.log(`Titles ranked          : ${s.ranked}`);
      console.log(`  screened out cheaply : ${s.screenedOut}  (no name/founder/domain in title or excerpt)`);
      console.log(`  read in full         : ${s.bodiesFetched}`);
      console.log(`  kept                 : ${s.kept} ${Object.keys(s.byTier).length ? `(${Object.entries(s.byTier).map(([t, n]) => `${t}: ${n}`).join(', ')})` : ''}`);
      console.log(`  already stored       : ${s.skippedDuplicate}`);
      console.log(`  rejected after reading: ${s.skippedIrrelevant}`);
      if (s.errors) console.log(`Source errors          : ${s.errors}`);
      console.log(`\n${dryRun ? 'Dry run -- nothing written.' : `${result.findingsAdded} findings stored.`}`);
      console.log('Next: npm run scan:enrich   (matching and attachment still apply the 0.8 gate)');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
