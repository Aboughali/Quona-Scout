import { useMemo, useState } from 'react';
import type { Company } from '../types';
import type { EditsStore } from '../lib/editStore';
import { useEditor } from '../context/EditorContext';
import { normalizeCompanyNameForMatch } from '../lib/manualCompany';
import { resolveRounds } from '../lib/rounds';

interface DuplicateGroup {
  key: string;
  companies: Company[];
}

interface AmbiguousPair {
  a: Company;
  b: Company;
}

interface Metrics {
  totalRecords: number;
  uniqueCompanies: number;
  duplicateRecords: number;
  duplicateGroups: DuplicateGroup[];
  totalRounds: number;
  uniqueRounds: number;
  duplicateRounds: number;
}

/** Damerau-Levenshtein distance, capped for cost -- only used on short company names.
 *  Transpositions count as ONE edit, not two, because a swapped pair of letters is the single
 *  most common way the same company gets typed two different ways ("NjiaPay" / "Nijapay") and
 *  plain Levenshtein scores that the same as two unrelated substitutions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** Names that are near-identical but NOT canonically equal (e.g. "Nijapay" vs "NjiaPay").
 *  These are deliberately never auto-merged -- transposed letters can be two real, different
 *  companies, and merging them would destroy data that cannot be recovered. They are surfaced
 *  here for a human to judge, per the import brief's ambiguity rule. */
function findAmbiguousPairs(companies: Company[]): AmbiguousPair[] {
  const byLength = new Map<number, { c: Company; key: string }[]>();
  for (const c of companies) {
    const key = normalizeCompanyNameForMatch(c.name);
    if (key.length < 4) continue;
    for (const len of [key.length - 1, key.length, key.length + 1]) {
      if (!byLength.has(len)) byLength.set(len, []);
    }
    byLength.get(key.length)!.push({ c, key });
  }

  const pairs: AmbiguousPair[] = [];
  const compared = new Set<string>();
  for (const [len, bucket] of byLength) {
    const candidates = [...bucket, ...(byLength.get(len + 1) ?? [])];
    for (let i = 0; i < bucket.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        const x = bucket[i];
        const y = candidates[j];
        if (x.c.id === y.c.id || x.key === y.key) continue;
        const pairKey = x.c.id < y.c.id ? `${x.c.id}|${y.c.id}` : `${y.c.id}|${x.c.id}`;
        // Mark every pair examined, not only the matches -- otherwise each pair is compared
        // twice (once from each side of the bucket), doubling the distance computations.
        if (compared.has(pairKey)) continue;
        compared.add(pairKey);
        if (editDistance(x.key, y.key) <= 1) pairs.push({ a: x.c, b: y.c });
      }
    }
  }
  return pairs;
}

/** All metrics here are computed live from the CURRENT company database (gold-sheet import +
 *  manually-added companies) -- nothing is a stored/stale snapshot, so this always reflects
 *  reality, including immediately after a merge. Case brief Part 1/7/31. */
function computeMetrics(rawCompanies: Company[], edits: EditsStore): Metrics {
  const byNorm = new Map<string, Company[]>();
  for (const c of rawCompanies) {
    const key = normalizeCompanyNameForMatch(c.name);
    const arr = byNorm.get(key) ?? [];
    arr.push(c);
    byNorm.set(key, arr);
  }
  const duplicateGroups: DuplicateGroup[] = [...byNorm.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, companies]) => ({ key, companies }));

  let totalRounds = 0;
  let duplicateRounds = 0;
  for (const c of rawCompanies) {
    const rounds = resolveRounds(c, edits);
    totalRounds += rounds.length;
    const seen = new Set<string>();
    for (const r of rounds) {
      const fp = `${r.date ?? ''}|${(r.type ?? '').trim().toLowerCase()}`;
      if (seen.has(fp)) duplicateRounds += 1;
      else seen.add(fp);
    }
  }

  return {
    totalRecords: rawCompanies.length,
    uniqueCompanies: byNorm.size,
    duplicateRecords: rawCompanies.length - byNorm.size,
    duplicateGroups,
    totalRounds,
    uniqueRounds: totalRounds - duplicateRounds,
    duplicateRounds,
  };
}

export function DataQualityView({ rawCompanies, edits, onOpenCompany }: { rawCompanies: Company[]; edits: EditsStore; onOpenCompany: (id: string) => void }) {
  const { mergeCompanies } = useEditor();
  const [lastAudit, setLastAudit] = useState<string | null>(null);
  const [mergeMessage, setMergeMessage] = useState<string | null>(null);

  const metrics = useMemo(() => computeMetrics(rawCompanies, edits), [rawCompanies, edits]);
  // Keyed on the company list ALONE: near-duplicate name detection is ~110k string-distance
  // comparisons and depends only on names, so recomputing it on every edit was pure waste.
  const ambiguousPairs = useMemo(() => findAmbiguousPairs(rawCompanies), [rawCompanies]);

  function handleMerge(sourceId: string, targetId: string) {
    const result = mergeCompanies(sourceId, targetId);
    setMergeMessage(result.message);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-h)]">Data Quality / Reconciliation</h2>
          <p className="text-xs text-[var(--text-dim)]">
            Live metrics computed from the current company database (gold-sheet import + manually-added companies), never a stale snapshot.
            {lastAudit && ` Last audit run: ${lastAudit}.`}
          </p>
        </div>
        <button
          onClick={() => setLastAudit(new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}
          className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium"
        >
          Run Deduplication Audit
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-[var(--border)] rounded-md p-3">
          <h3 className="text-xs font-semibold text-[var(--text-dim)] uppercase mb-2">Companies</h3>
          <div className="text-2xl font-semibold text-[var(--text-h)]">
            {metrics.totalRecords.toLocaleString()} <span className="text-xs font-normal text-[var(--text-dim)]">records</span>
          </div>
          <div className="text-sm text-[var(--text)]">{metrics.uniqueCompanies.toLocaleString()} unique companies</div>
          <div className="text-sm font-medium" style={{ color: metrics.duplicateRecords > 0 ? 'var(--weak)' : 'var(--strong)' }}>
            {metrics.duplicateRecords.toLocaleString()} duplicate records
          </div>
        </div>
        <div className="border border-[var(--border)] rounded-md p-3">
          <h3 className="text-xs font-semibold text-[var(--text-dim)] uppercase mb-2">Funding rounds</h3>
          <div className="text-2xl font-semibold text-[var(--text-h)]">
            {metrics.totalRounds.toLocaleString()} <span className="text-xs font-normal text-[var(--text-dim)]">total</span>
          </div>
          <div className="text-sm text-[var(--text)]">{metrics.uniqueRounds.toLocaleString()} unique rounds</div>
          <div className="text-sm font-medium" style={{ color: metrics.duplicateRounds > 0 ? 'var(--weak)' : 'var(--strong)' }}>
            {metrics.duplicateRounds.toLocaleString()} duplicate records
          </div>
        </div>
      </div>

      {mergeMessage && (
        <div className="text-xs px-3 py-2 rounded-md border" style={{ borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' }}>
          {mergeMessage}{' '}
          <button onClick={() => setMergeMessage(null)} className="underline">
            Dismiss
          </button>
        </div>
      )}

      {ambiguousPairs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-h)] mb-1">Flagged for Manual Review — Similar Names</h3>
          <p className="text-xs text-[var(--text-dim)] mb-2">
            These names are near-identical but not the same after normalization. They are deliberately <b>not</b> merged
            automatically: they may be two genuinely different companies. Open both and decide.
          </p>
          <div className="space-y-1.5">
            {ambiguousPairs.map(({ a, b }) => (
              <div key={`${a.id}|${b.id}`} className="border border-[var(--border)] rounded-md p-2 text-xs flex items-center justify-between gap-3 flex-wrap"
                   style={{ borderColor: 'var(--moderate)' }}>
                <span className="text-[var(--text-h)]">
                  <b>{a.name}</b> ({a.country ?? '—'}, {resolveRounds(a, edits).length} rounds) vs{' '}
                  <b>{b.name}</b> ({b.country ?? '—'}, {resolveRounds(b, edits).length} rounds)
                </span>
                <span className="flex gap-2 shrink-0">
                  <button onClick={() => onOpenCompany(a.id)} className="underline text-[var(--accent-ink)]">Open {a.name}</button>
                  <button onClick={() => onOpenCompany(b.id)} className="underline text-[var(--accent-ink)]">Open {b.name}</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-[var(--text-h)] mb-2">Duplicate Review</h3>
        {metrics.duplicateGroups.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--strong)' }}>
            No duplicate company names found. Duplicate company names remaining = 0.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-[var(--text-dim)] border-b border-[var(--border)]">
                  <th className="py-1.5 pr-3">Duplicate company</th>
                  <th className="py-1.5 pr-3">Records</th>
                  <th className="py-1.5 pr-3">Funding rounds</th>
                  <th className="py-1.5 pr-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {metrics.duplicateGroups.map(({ key, companies }) => {
                  const target = companies[0];
                  const totalRoundsInGroup = companies.reduce((sum, c) => sum + resolveRounds(c, edits).length, 0);
                  return (
                    <tr key={key} className="border-b border-[var(--border)] align-top">
                      <td className="py-1.5 pr-3 text-[var(--text-h)]">{companies.map((c) => c.name).join(' / ')}</td>
                      <td className="py-1.5 pr-3">{companies.length} records</td>
                      <td className="py-1.5 pr-3">{totalRoundsInGroup} rounds</td>
                      <td className="py-1.5 pr-3 space-y-1">
                        {companies.slice(1).map((source) => (
                          <button
                            key={source.id}
                            onClick={() => handleMerge(source.id, target.id)}
                            className="block text-[11px] px-2 py-1 rounded-md border border-[var(--accent-ink)] text-[var(--accent-ink)]"
                          >
                            Merge "{source.name}" into "{target.name}"
                          </button>
                        ))}
                        <button onClick={() => onOpenCompany(target.id)} className="block text-[11px] text-[var(--text-dim)] underline">
                          Open {target.name}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
