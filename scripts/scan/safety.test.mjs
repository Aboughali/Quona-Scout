/**
 * Safety invariants for the news store.   Run:  npm run test:safety
 *
 * Every test runs against a throwaway QUONA_DATA_ROOT in the OS temp directory. The real
 * src/data/ store is never read or written by this file -- which is checked explicitly in the
 * final test, because a test suite for data-loss protection that could itself lose data would
 * be self-defeating.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as storage from './storage.mjs';
import * as staging from './staging.mjs';

let sandbox;

function finding(n, extra = {}) {
  return {
    finding_id: `f_test_${n}`,
    finding_key: `example.com|https://example.com/article-${n}`,
    url: `https://example.com/article-${n}`,
    headline: `Article ${n}`,
    source: 'Example',
    source_domain: 'example.com',
    status: 'new',
    ...extra,
  };
}

function signal(id, extra = {}) {
  return {
    signal_id: id,
    company_key: `id:${id}`,
    company_name: id,
    round_type: 'Series A',
    funding_amount: 1_000_000,
    status: 'pending',
    sources: [{ finding_id: `f_${id}`, url: `https://example.com/${id}`, source: 'Example' }],
    source_count: 1,
    ...extra,
  };
}

async function seedFindings(list) {
  await mkdir(path.join(sandbox, 'src', 'data'), { recursive: true });
  await writeFile(path.join(sandbox, 'src', 'data', 'news_findings.json'), JSON.stringify(list, null, 2) + '\n');
}

async function seedSignals(list) {
  await mkdir(path.join(sandbox, 'src', 'data'), { recursive: true });
  await writeFile(path.join(sandbox, 'src', 'data', 'news_signals.json'), JSON.stringify(list, null, 2) + '\n');
}

async function liveFindings() {
  return JSON.parse(await readFile(path.join(sandbox, 'src', 'data', 'news_findings.json'), 'utf8'));
}

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'quona-safety-'));
  process.env.QUONA_DATA_ROOT = sandbox;
});

afterEach(async () => {
  delete process.env.QUONA_DATA_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('findings store safety', () => {
  test('TEST 1  209 existing + 10 new -> 219', async () => {
    await seedFindings(Array.from({ length: 209 }, (_, i) => finding(i)));
    const res = await storage.appendFindings(Array.from({ length: 10 }, (_, i) => finding(1000 + i)));
    assert.equal(res.added, 10);
    assert.equal(res.total, 219);
    assert.equal((await liveFindings()).length, 219);
  });

  test('TEST 2  209 existing + enrichment -> 209, fields updated, none lost', async () => {
    await seedFindings(Array.from({ length: 209 }, (_, i) => finding(i)));
    const res = await storage.rewriteFindingsInPlace((f) => ({ ...f, status: 'enriched', company_match: 'acme' }));
    assert.equal(res.proposedCount, 209);
    assert.equal(res.dropped, 0);
    const live = await liveFindings();
    assert.equal(live.length, 209);
    assert.ok(live.every((f) => f.status === 'enriched'));
  });

  test('TEST 3  209 existing -> proposed 134 is REJECTED and the live file is untouched', async () => {
    const original = Array.from({ length: 209 }, (_, i) => finding(i));
    await seedFindings(original);

    await assert.rejects(
      () => storage.writeFindingsGuarded(original.slice(0, 134), { operation: 'test-shrink' }),
      (err) => {
        assert.equal(err.name, 'DataLossError');
        assert.match(err.message, /Normal operations must never reduce the findings count/);
        assert.equal(err.details.existingCount, 209);
        assert.equal(err.details.proposedCount, 134);
        return true;
      },
    );

    assert.equal((await liveFindings()).length, 209, 'live file must still hold 209');
  });

  test('TEST 3b  same count but a swapped record is still REJECTED', async () => {
    const original = Array.from({ length: 10 }, (_, i) => finding(i));
    await seedFindings(original);
    const sneaky = [...original.slice(0, 9), finding(999)]; // same length, one identity replaced

    await assert.rejects(
      () => storage.writeFindingsGuarded(sneaky, { operation: 'test-swap' }),
      (err) => {
        assert.equal(err.name, 'DataLossError');
        assert.match(err.message, /would disappear/);
        return true;
      },
    );
    assert.equal((await liveFindings()).length, 10);
  });

  test('TEST 4  malformed findings file THROWS and never becomes []', async () => {
    await mkdir(path.join(sandbox, 'src', 'data'), { recursive: true });
    const p = path.join(sandbox, 'src', 'data', 'news_findings.json');
    await writeFile(p, '[{"finding_id":"f_1"},{"finding_id": ');   // truncated

    await assert.rejects(() => storage.loadFindings(), (err) => {
      assert.equal(err.name, 'CorruptStoreError');
      assert.match(err.message, /not valid JSON/);
      return true;
    });

    // and an append on top of a corrupt store must not "recover" by starting from scratch
    await assert.rejects(() => storage.appendFindings([finding(1)]), (e) => e.name === 'CorruptStoreError');
    assert.match(await readFile(p, 'utf8'), /^\[\{"finding_id":"f_1"\}/, 'corrupt file left as-is');
  });

  test('TEST 4b  empty findings file THROWS rather than reading as zero findings', async () => {
    await mkdir(path.join(sandbox, 'src', 'data'), { recursive: true });
    await writeFile(path.join(sandbox, 'src', 'data', 'news_findings.json'), '');
    await assert.rejects(() => storage.loadFindings(), (e) => e.name === 'CorruptStoreError');
  });

  test('saveFindings() is removed and fails loudly', async () => {
    await seedFindings([finding(1)]);
    await assert.rejects(() => storage.saveFindings([]), (err) => {
      assert.match(err.message, /has been removed/);
      return true;
    });
    assert.equal((await liveFindings()).length, 1);
  });

  test('--allow-destructive-change is the only way to shrink the store', async () => {
    const original = Array.from({ length: 10 }, (_, i) => finding(i));
    await seedFindings(original);
    const res = await storage.writeFindingsGuarded(original.slice(0, 4), { operation: 'deliberate', allowDestructive: true });
    assert.equal(res.destructive, true);
    assert.equal(res.dropped, 6);
    assert.equal((await liveFindings()).length, 4);
  });
});

describe('signal preservation', () => {
  test('TEST 5  existing + new signals -> union, existing retained', async () => {
    await seedSignals([signal('alpha'), signal('beta')]);
    const { signals: out } = await storage.mergeSignals([signal('gamma')]);
    const ids = out.map((s) => s.signal_id).sort();
    assert.deepEqual(ids, ['alpha', 'beta', 'gamma']);
  });

  test('TEST 6  an approved signal not rediscovered stays, and stays approved', async () => {
    await seedSignals([
      signal('moneyhash', { status: 'approved', decided_by: 'investor', decided_at: '2026-08-16T00:00:00Z' }),
      signal('ignored-one', { status: 'ignored' }),
    ]);

    // A later scan rediscovers neither.
    const { signals: out } = await storage.mergeSignals([signal('unrelated')]);

    const mh = out.find((s) => s.signal_id === 'moneyhash');
    assert.ok(mh, 'approved signal must survive a scan that did not rediscover it');
    assert.equal(mh.status, 'approved');
    assert.equal(mh.decided_by, 'investor');
    assert.equal(out.find((s) => s.signal_id === 'ignored-one').status, 'ignored');
  });

  test('a rediscovered decided signal is refreshed but NOT reset to pending', async () => {
    await seedSignals([signal('alpha', { status: 'approved', decided_at: 'x' })]);
    const rediscovered = signal('alpha', {
      status: 'pending',
      sources: [{ finding_id: 'f_new', url: 'https://other.com/alpha', source: 'Other' }],
    });
    const { signals: out } = await storage.mergeSignals([rediscovered]);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'approved', 'user decision must win');
    assert.equal(out[0].sources.length, 2, 'sources are unioned, not replaced');
  });

  test('MoneyHash URLs survive a scan that rediscovers nothing', async () => {
    const urls = [
      'https://techcabal.com/2025/01/21/egyptian-fintech-moneyhash-raises-5-2-million/',
      'https://techpoint.africa/news/egypts-moneyhash-raises-preseriesa/',
      'https://techcrunch.com/2024/02/27/moneyhash-raises-4-5m-for-its-payment-orchestration-platform-serving-merchants-in-mena/',
      'https://www.pymnts.com/news/investment-tracker/2025/moneyhash-raises-5-2-million-for-payments-orchestration-platform/',
    ];
    await seedSignals([
      signal('mh1', { sources: urls.slice(0, 2).map((u) => ({ url: u })), source_count: 2 }),
      signal('mh2', { round_type: null, sources: [{ url: urls[2] }], source_count: 1 }),
      signal('mh3', { round_type: 'other', sources: [{ url: urls[3] }], source_count: 1 }),
    ]);

    const { signals: out } = await storage.mergeSignals([]);   // scan found nothing at all
    const surviving = out.flatMap((s) => s.sources.map((x) => x.url));
    for (const u of urls) assert.ok(surviving.includes(u), `${u} must survive`);
  });
});

describe('atomic writes and backups', () => {
  test('TEST 9  a failed atomic write leaves the previous live file intact', async () => {
    await seedFindings([finding(1), finding(2)]);
    const p = path.join(sandbox, 'src', 'data', 'news_findings.json');
    const before = await readFile(p, 'utf8');

    // Unserialisable payload: JSON.stringify throws before anything is renamed into place.
    const circular = [finding(1), finding(2), finding(3)];
    circular[2].self = circular[2];

    await assert.rejects(() => storage.atomicWriteJson(p, circular));
    assert.equal(await readFile(p, 'utf8'), before, 'live file byte-identical after failed write');
    assert.equal(existsSync(`${p}.tmp`), false, 'no .tmp left behind as a live file');
  });

  test('a count mismatch refuses to promote the temp file', async () => {
    await seedFindings([finding(1)]);
    const p = path.join(sandbox, 'src', 'data', 'news_findings.json');
    await assert.rejects(
      () => storage.atomicWriteJson(p, [finding(1), finding(2)], { expectCount: 5 }),
      (e) => e.name === 'DataLossError',
    );
    assert.equal((await liveFindings()).length, 1);
  });

  test('TEST 10  an automatic backup is created before the live store is modified', async () => {
    await seedFindings(Array.from({ length: 5 }, (_, i) => finding(i)));
    const res = await storage.appendFindings([finding(99)]);

    assert.ok(res.backup, 'appendFindings must report a backup path');
    assert.ok(existsSync(res.backup), 'backup file must exist on disk');
    const backed = JSON.parse(await readFile(res.backup, 'utf8'));
    assert.equal(backed.length, 5, 'backup holds the PREVIOUS version, taken before the write');
    assert.equal((await liveFindings()).length, 6);
  });

  test('backups are never overwritten', async () => {
    await seedFindings([finding(1)]);
    const a = await storage.appendFindings([finding(2)]);
    const b = await storage.appendFindings([finding(3)]);
    assert.notEqual(a.backup, b.backup, 'two mutations must produce two distinct backups');
    assert.ok(existsSync(a.backup) && existsSync(b.backup));
  });
});

describe('staging and promotion', () => {
  test('TEST 7  a scan that crashes before promotion leaves the live store unchanged', async () => {
    await seedFindings(Array.from({ length: 75 }, (_, i) => finding(i)));

    // A run that staged its output but never reached 'complete'.
    await staging.writeStagingRun({
      runId: 'scan_crashed',
      findings: Array.from({ length: 40 }, (_, i) => finding(500 + i)),
      status: 'interrupted',
    });

    assert.equal((await liveFindings()).length, 75, 'staging alone must not touch live');

    const v = await staging.validateStagingRun('scan_crashed');
    assert.equal(v.ok, false);
    assert.match(v.reasons.join(' '), /not "complete"/);

    await assert.rejects(() => staging.promoteStagingRun('scan_crashed'), (e) => e.name === 'DataLossError');
    assert.equal((await liveFindings()).length, 75, 'live store still 75 after refused promotion');
  });

  test('TEST 8  staging with fewer findings than live is refused promotion', async () => {
    const live = Array.from({ length: 209 }, (_, i) => finding(i));
    await seedFindings(live);

    await staging.writeStagingRun({
      runId: 'scan_short',
      findings: live.slice(0, 134),
      mode: 'full',              // a complete proposed dataset -- and it is short
      status: 'complete',
    });

    const v = await staging.validateStagingRun('scan_short');
    assert.equal(v.ok, false);
    assert.equal(v.currentFindings, 209);
    assert.equal(v.proposedFindings, 134);
    assert.equal(v.potentiallyDropped, 75);

    await assert.rejects(() => staging.promoteStagingRun('scan_short'), (e) => e.name === 'DataLossError');
    assert.equal((await liveFindings()).length, 209);
  });

  test('a valid batch promotes, and the run log records the outcome', async () => {
    await seedFindings(Array.from({ length: 75 }, (_, i) => finding(i)));
    await staging.writeStagingRun({
      runId: 'scan_good',
      findings: Array.from({ length: 12 }, (_, i) => finding(800 + i)),
      status: 'complete',
      report: { trigger: 'backfill', scope: 'watchlist' },
    });

    const v = await staging.validateStagingRun('scan_good');
    assert.equal(v.ok, true);
    assert.equal(v.newFindings, 12);
    assert.equal(v.potentiallyDropped, 0);

    const res = await staging.promoteStagingRun('scan_good');
    assert.equal(res.after, 87);

    const runs = await storage.loadScanRuns();
    const logged = runs[runs.length - 1];
    assert.equal(logged.runId, 'scan_good');
    assert.equal(logged.promoted, true);
    assert.equal(logged.validationSucceeded, true);
    assert.equal(logged.finalLiveFindingCount, 87);
  });

  test('duplicates in a staged batch are absorbed, not double-stored', async () => {
    const live = Array.from({ length: 10 }, (_, i) => finding(i));
    await seedFindings(live);
    await staging.writeStagingRun({
      runId: 'scan_dupes',
      findings: [finding(0), finding(1), finding(500)],   // two already stored
      status: 'complete',
    });
    const v = await staging.validateStagingRun('scan_dupes');
    assert.equal(v.duplicateFindings, 2);
    assert.equal(v.newFindings, 1);
    await staging.promoteStagingRun('scan_dupes');
    assert.equal((await liveFindings()).length, 11);
  });

  test('discarding a staged run never touches the live store', async () => {
    await seedFindings(Array.from({ length: 75 }, (_, i) => finding(i)));
    await staging.writeStagingRun({ runId: 'scan_bad', findings: [finding(900)], status: 'complete' });
    await staging.discardStagingRun('scan_bad');
    assert.equal(existsSync(staging.stagingDirFor('scan_bad')), false);
    assert.equal((await liveFindings()).length, 75);
  });
});

describe('test isolation', () => {
  test('this suite never resolves paths into the real project src/data', async () => {
    assert.ok(storage.findingsPath().startsWith(sandbox), `findings path escaped the sandbox: ${storage.findingsPath()}`);
    assert.ok(storage.signalsPath().startsWith(sandbox));
    assert.ok(storage.autoBackupDir().startsWith(sandbox));
    assert.ok(staging.stagingRoot().startsWith(sandbox));
  });
});
