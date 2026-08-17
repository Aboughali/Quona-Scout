/**
 * CLI wrapper:  npm run scan
 *
 * Reads APIFY_TOKEN from the environment (loaded from .env, which is gitignored), runs the
 * scan, and writes findings to disk. The token is never printed and never persisted.
 *
 * This wrapper and the dev-server endpoint in vite.config.ts are interchangeable front doors
 * onto the same `executeScan()` -- which is what a future scheduled function will also call.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runScan, findingKey } from './runScan.mjs';
import { verifyToken } from './apifyClient.mjs';
import { loadConfig, loadFindings, appendScanRun, recordSourceResults } from './storage.mjs';
import { writeStagingRun, newRunId } from './staging.mjs';

/** Tiny .env reader -- avoids adding dotenv for one variable. */
export async function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const raw = await readFile(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[key]) process.env[key] = value;
  }
}

/**
 * The shared entry point. Returns a JSON-serializable summary so both the CLI and the HTTP
 * endpoint can report the same thing.
 */
export async function executeScan({ log = () => {}, dryRun = false, only = null } = {}) {
  await loadEnv();
  const token = process.env.APIFY_TOKEN;

  const check = await verifyToken(token);
  if (!check.ok) {
    return {
      ok: false,
      error: check.reason,
      hint: 'Add APIFY_TOKEN to .env (see .env.example). Get one at https://console.apify.com/account/integrations',
      findingsAdded: 0,
      sourceResults: [],
    };
  }
  log(`Apify token OK${check.username ? ` (account: ${check.username})` : ''}`);

  const config = await loadConfig();
  const existing = await loadFindings();
  const seen = new Set(existing.map((f) => f.finding_key ?? findingKey(f.source_domain, f.url, f.headline)));
  log(`${existing.length} findings already stored; ${config.sources.filter((s) => s.enabled).length} sources enabled.`);

  const startedAt = new Date().toISOString();
  const { findings, sourceResults } = await runScan(token, config, seen, log, { only });

  // As with backfill, the scan stages its output and stops. Nothing reaches the live findings
  // store without an explicit `npm run scan:promote`.
  const runId = newRunId();
  let staged = null;
  if (!dryRun) {
    staged = await writeStagingRun({
      runId,
      findings,
      mode: 'batch',
      status: 'complete',
      report: {
        startedAt,
        trigger: 'manual',
        scope: only ? `only:${only.join(',')}` : 'all-enabled-sources',
        sourcesScanned: sourceResults.map((s) => s.name),
        candidates: sourceResults.reduce((n, s) => n + (s.fetched ?? 0), 0),
      },
    });
    // Source bookkeeping only -- config is not findings data.
    await recordSourceResults(config, sourceResults);
  }

  const run = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger: 'manual',
    dryRun,
    only,
    findingsStaged: dryRun ? 0 : findings.length,
    findingsAdded: 0,
    existingFindings: existing.length,
    sourcesScanned: sourceResults.map((s) => s.name),
    stagingSucceeded: Boolean(staged),
    validationSucceeded: null,
    promoted: false,
    finalLiveFindingCount: existing.length,
    sourceResults,
  };
  if (!dryRun) await appendScanRun(run);

  return { ok: true, ...run, stagingDir: staged?.dir ?? null };
}

// Only run when invoked directly, so the dev server (and a future serverless handler) can
// import executeScan without side effects.
// pathToFileURL is required rather than string-concatenating "file://": the project path can
// contain spaces (it does), which import.meta.url percent-encodes, so a naive compare never
// matches. argv[1] is undefined when this module is imported via `node -e` or a bundler, so it
// is guarded -- calling pathToFileURL(undefined) throws.
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').filter(Boolean) : null;
  executeScan({ log: (m) => console.log(m), dryRun, only })
    .then((result) => {
      if (!result.ok) {
        console.error(`\nScan failed: ${result.error}\n${result.hint ?? ''}`);
        process.exit(1);
      }
      if (dryRun) {
        console.log(`\nDone. ${result.findingsStaged} new findings (dry run, nothing written).`);
      } else {
        console.log(`\nDone. ${result.findingsStaged} findings STAGED as ${result.runId}. Live store unchanged (${result.finalLiveFindingCount} findings).`);
        console.log(`Next: npm run scan:verify -- --run=${result.runId}`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
