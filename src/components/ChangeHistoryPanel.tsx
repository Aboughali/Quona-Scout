import type { Company, Fund } from '../types';
import { useEditor } from '../context/EditorContext';
import { CLASSIFICATION_REGISTRY, FIELD_REGISTRY } from '../lib/fields';
import { fundEntityId } from '../lib/funds';
import { DIMENSION_META } from '../lib/scoring';

const ALL_LABELS = new Map<string, string>([
  ...FIELD_REGISTRY.map((f) => [f.path, f.label] as const),
  ...CLASSIFICATION_REGISTRY.map((f) => [f.path, f.label] as const),
]);

const DIMENSION_LABELS = new Map<string, string>(DIMENSION_META.map((d) => [d.key, d.label]));

const SYNTHETIC_BASELINE_TS = '2026-08-13T00:00:00.000Z';

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(blank)';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(blank)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('type' in v && 'amount' in v) return `${v.type} — ${v.amount != null ? `$${v.amount}M` : 'undisclosed'}${v.date ? ` (${v.date})` : ''}`;
    return JSON.stringify(value);
  }
  return String(value);
}

function labelForPath(path: string): string {
  if (ALL_LABELS.has(path)) return ALL_LABELS.get(path)!;
  if (path.startsWith('round:')) return 'Rounds on Record';
  if (path.startsWith('investorRole.')) return `Investor role (${path.slice('investorRole.'.length)})`;
  if (path.startsWith('syndicateTierOverride.')) return `Syndicate assessment (${path.slice('syndicateTierOverride.'.length)})`;
  if (DIMENSION_LABELS.has(path)) return DIMENSION_LABELS.get(path)!;
  if (path === 'displayName' || path === 'hq' || path === 'investorType' || path === 'vintageYear' || path === 'fundSizeUsdM' || path === 'presenceCountries' || path === 'panAfrican' || path === 'notes') {
    return `Fund detail: ${path}`;
  }
  return path;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

interface Row {
  timestamp: string;
  kind: 'baseline' | 'change';
  headline: string;
  reason?: string;
  source?: string;
  evidenceUrl?: string;
  confidence?: string;
}

export function ChangeHistoryPanel({ company, fundIndex }: { company: Company; fundIndex: Map<string, Fund> }) {
  const { edits } = useEditor();
  const rows: Row[] = [];

  function pushEntityHistory(entityId: string, contextLabel: (path: string) => string) {
    const entityEdits = edits[entityId] ?? {};
    for (const [path, field] of Object.entries(entityEdits)) {
      if (field.history.length === 0) continue;
      const label = contextLabel(path);

      rows.push({
        timestamp: SYNTHETIC_BASELINE_TS,
        kind: 'baseline',
        headline: `AI / research value: ${label} = ${fmt(field.originalValue)}`,
        source: field.originalSource,
      });

      for (const h of field.history) {
        if (h.kind === 'source-added') {
          rows.push({
            timestamp: h.timestamp,
            kind: 'change',
            headline: `${h.user} added a corroborating source for ${label}`,
            source: h.source,
            evidenceUrl: h.evidenceUrl,
            confidence: h.confidence,
          });
          continue;
        }
        rows.push({
          timestamp: h.timestamp,
          kind: 'change',
          headline:
            h.kind === 'revert'
              ? `${h.user} reverted ${label} to the original research value (${fmt(h.newValue)})`
              : `${h.user} changed ${label}: ${fmt(h.previousValue)} → ${fmt(h.newValue)}`,
          reason: h.reason,
          source: h.source,
          evidenceUrl: h.evidenceUrl,
          confidence: h.confidence,
        });
      }
    }
  }

  pushEntityHistory(company.id, labelForPath);

  for (const inv of company.investors) {
    const entity = fundEntityId(inv);
    if (fundIndex.has(entity.replace('fund:', '')) || edits[entity]) {
      pushEntityHistory(entity, (path) => `${inv} — ${labelForPath(path)}`);
    }
  }

  rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  return (
    <section>
      <h3 className="text-sm font-semibold text-[var(--text-h)] mb-2">Change History</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--text-dim)]">No edits yet — every field still reflects the original research values.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="text-xs border border-[var(--border)] rounded-md p-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <span
                  className="font-medium"
                  style={{ color: r.kind === 'baseline' ? 'var(--text-dim)' : 'var(--text-h)' }}
                >
                  {r.headline}
                </span>
                <span className="text-[var(--text-dim)] whitespace-nowrap ml-2">{formatDateTime(r.timestamp)}</span>
              </div>
              {r.reason && (
                <p className="text-[var(--text)]">
                  <span className="text-[var(--text-dim)]">Reason: </span>"{r.reason}"
                </p>
              )}
              {r.source && (
                <p className="text-[var(--text-dim)]">
                  Source: {r.source}
                  {r.confidence ? ` · ${r.confidence} confidence` : ''}
                  {r.evidenceUrl && (
                    <>
                      {' · '}
                      <a href={r.evidenceUrl} target="_blank" rel="noreferrer" className="text-[var(--accent-ink)]">
                        evidence
                      </a>
                    </>
                  )}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
