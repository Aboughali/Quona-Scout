/**
 * CLI wrapper:  npm run scan:search
 *
 * Wide web search (via Apify) for the sources no archive API can reach -- Wamda, which is not
 * WordPress and exposes no search or sitemap, and TechAfrica News, which restricts its REST API.
 * See webSearch.mjs for why those two need a search engine rather than a crawl.
 *
 * Usage:
 *   npm run scan:search -- --ids=connect-money,enza     search for these companies
 *   npm run scan:search -- --scope=watchlist            statically-uncut companies
 *   npm run scan:search -- --dry-run                    build the queries, spend nothing
 *
 * Like every other collector here, this STAGES its output. Nothing reaches the live store until
 * `npm run scan:promote`, and the relevance guard in backfill.mjs judges every candidate first.
 *
 * COST: Apify's Google Search Results Scraper bills per search-results page, so this is one
 * charged page per company plus one actor start. The run prints the query count before it
 * spends anything, and --dry-run prints the queries and exits.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadEnv } from './cli.mjs';
import { assessRelevance, searchableName, selectCompanies } from './backfill.mjs';
import { buildFinding, findingKey } from './runScan.mjs';
import { buildQuery, runWebSearch, searchOnlySources, sourceForUrl } from './webSearch.mjs';
import { loadConfig, loadFindings, appendScanRun } from './storage.mjs';
import { writeStagingRun, newRunId } from './staging.mjs';

async function loadCompanies() {
  return JSON.parse(await readFile(path.join(process.cwd(), 'src', 'data', 'companies.json'), 'utf8'));
}

export async function executeSearch({ log = () => {}, dryRun = false, scope = 'watchlist', ids = null, limit = null } = {}) {
  await loadEnv();
  const token = process.env.APIFY_TOKEN;
  if (!token && !dryRun) {
    return { ok: false, error: 'APIFY_TOKEN is not set (see .env.example). Web search needs it; the archive backfill does not.' };
  }

  const config = await loadConfig();
  const allCompanies = await loadCompanies();
  const targets = searchOnlySources(config);
  if (!targets.length) {
    return { ok: false, error: 'Every enabled source has an archive API configured; web search has nothing to add.' };
  }

  let companies;
  if (ids?.length) {
    const wanted = new Set(ids.map((i) => i.trim().toLowerCase()).filter(Boolean));
    companies = allCompanies.filter((c) => wanted.has(c.id.toLowerCase()) || wanted.has(c.name.toLowerCase()));
  } else {
    companies = selectCompanies(allCompanies, scope);
  }
  if (limit) companies = companies.slice(0, limit);

  const domains = targets.map((s) => s.domain);
  log(`Searching ${domains.join(', ')} for ${companies.length} companies (${companies.length} charged search pages).`);

  const queries = companies.map((c) => buildQuery(searchableName(c.name), domains));
  const queryToCompany = new Map(queries.map((q, i) => [q, companies[i]]));

  if (dryRun) {
    queries.slice(0, 5).forEach((q) => log(`  ${q}`));
    if (queries.length > 5) log(`  ... and ${queries.length - 5} more`);
    return { ok: true, dryRun: true, queries: queries.length, findingsStaged: 0 };
  }

  const startedAt = new Date().toISOString();
  const resultsByQuery = await runWebSearch(token, queries, { log });

  const existing = await loadFindings();
  const seen = new Set(existing.map((f) => f.finding_key ?? findingKey(f.source_domain, f.url, f.headline)));
  const retrievedAt = new Date().toISOString();

  const findings = [];
  const stats = { queries: queries.length, results: 0, kept: 0, skippedDuplicate: 0, skippedIrrelevant: 0, unmatchedSource: 0, byTier: {} };

  for (const [query, results] of resultsByQuery) {
    const company = queryToCompany.get(query);
    if (!company) continue;
    for (const item of results) {
      stats.results += 1;
      const source = sourceForUrl(item.url, targets);
      if (!source) { stats.unmatchedSource += 1; continue; }

      const key = findingKey(source.domain, item.url, item.title);
      if (seen.has(key)) { stats.skippedDuplicate += 1; continue; }

      const verdict = assessRelevance(item, company, source);
      if (!verdict.keep) { stats.skippedIrrelevant += 1; continue; }

      const published = item.publishedAt ? new Date(item.publishedAt).toISOString() : null;
      const finding = buildFinding({
        item, source, key, url: item.url, headline: item.title,
        published: Number.isNaN(Date.parse(published ?? '')) ? null : published,
        retrievedAt, discovery: 'web-search',
      });
      finding.backfill_query = company.name;
      finding.backfill_tier = verdict.tier;
      // A search snippet is not article text; say so on the record rather than letting a short
      // body look like a truncated article.
      finding.raw_content_is_snippet = true;

      findings.push(finding);
      seen.add(key);
      stats.kept += 1;
      stats.byTier[verdict.tier] = (stats.byTier[verdict.tier] ?? 0) + 1;
      log(`  ${company.name}: ${item.url}`);
    }
  }

  const runId = newRunId();
  const staged = await writeStagingRun({
    runId,
    findings,
    mode: 'batch',
    status: 'complete',
    report: {
      startedAt, trigger: 'web-search', scope: ids?.length ? 'explicit-ids' : scope,
      companiesSearched: companies.length, candidates: stats.results,
      rejected: stats.skippedIrrelevant, sourcesScanned: domains,
    },
  });

  await appendScanRun({
    runId, startedAt, finishedAt: new Date().toISOString(), trigger: 'web-search',
    dryRun: false, scope: ids?.length ? 'explicit-ids' : scope,
    findingsStaged: findings.length, findingsAdded: 0,
    existingFindings: existing.length, stagingSucceeded: true, promoted: false,
    finalLiveFindingCount: existing.length, stats,
  });

  return { ok: true, runId, findingsStaged: findings.length, stats, stagingDir: staged.dir, liveCount: existing.length };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  const idsArg = arg('ids');
  executeSearch({
    log: (m) => console.log(m),
    dryRun: process.argv.includes('--dry-run'),
    scope: arg('scope') ?? 'watchlist',
    ids: idsArg ? idsArg.split(',').filter(Boolean) : null,
    limit: arg('limit') ? Number(arg('limit')) : null,
  })
    .then((r) => {
      if (!r.ok) { console.error(`\n${r.error}`); process.exit(1); }
      if (r.dryRun) { console.log(`\nDry run -- ${r.queries} queries built, nothing spent.`); return; }
      const s = r.stats;
      console.log('\n--- Web search summary ---');
      console.log(`Queries run        : ${s.queries}`);
      console.log(`Results returned   : ${s.results}`);
      console.log(`  kept             : ${s.kept} ${Object.keys(s.byTier).length ? `(${Object.entries(s.byTier).map(([t, n]) => `${t}: ${n}`).join(', ')})` : ''}`);
      console.log(`  already stored   : ${s.skippedDuplicate}`);
      console.log(`  not about company: ${s.skippedIrrelevant}`);
      console.log(`\n${r.findingsStaged} findings STAGED as ${r.runId}. Live store unchanged (${r.liveCount}).`);
      console.log(`\n  npm run scan:verify -- --run=${r.runId}`);
      console.log(`  npm run scan:promote -- --run=${r.runId}`);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
