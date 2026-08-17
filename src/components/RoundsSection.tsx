import { useState } from 'react';
import type { Company, EditConfidence, Fund, RoundRecord } from '../types';
import { useEditor } from '../context/EditorContext';
import {
  CURRENCY_OPTIONS,
  ROUND_TYPE_OPTIONS,
  allRoundIds,
  formatAmount,
  getRoundDefault,
  newRoundTemplate,
  resolveRounds,
  summarizeRounds,
} from '../lib/rounds';
import { uid } from '../lib/editStore';
import { DATA_BUILD_DATE } from '../lib/colors';
import { onboardNewInvestors } from '../lib/investorAutomation';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'research' | 'judgment' | 'new' | 'removed' }) {
  const styles: Record<string, React.CSSProperties> = {
    judgment: { color: 'var(--accent-ink)', borderColor: 'var(--accent-ink)', background: 'var(--accent-dim)' },
    new: { color: 'var(--strong)', borderColor: 'var(--strong)' },
    removed: { color: 'var(--weak)', borderColor: 'var(--weak)' },
    research: { color: 'var(--text-dim)', borderColor: 'var(--border)' },
  };
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide font-medium" style={styles[tone]}>
      {children}
    </span>
  );
}

interface RoundFormState {
  type: string;
  amount: string;
  currency: string;
  date: string;
  investors: string;
  leadInvestor: string;
  sources: { label: string; url: string }[];
  confidence: EditConfidence;
  notes: string;
  verified: boolean;
}

function toFormState(r: RoundRecord): RoundFormState {
  return {
    type: r.type ?? 'Seed',
    amount: r.amount != null ? String(r.amount) : '',
    currency: r.currency || 'USD',
    date: r.date ?? '',
    investors: r.investors.join(', '),
    leadInvestor: r.leadInvestor ?? '',
    sources: r.sources.length ? r.sources.map((s) => ({ label: s.label, url: s.url ?? '' })) : [{ label: '', url: '' }],
    confidence: r.confidence,
    notes: r.notes,
    verified: r.verified,
  };
}

function fromFormState(f: RoundFormState, status: RoundRecord['status'], id: string): RoundRecord {
  return {
    id,
    type: f.type || null,
    amount: f.amount.trim() ? Number(f.amount) : null,
    currency: f.currency || 'USD',
    date: f.date.trim() || null,
    investors: f.investors.split(',').map((s) => s.trim()).filter(Boolean),
    leadInvestor: f.leadInvestor.trim() || null,
    sources: f.sources.filter((s) => s.label.trim()).map((s) => ({ label: s.label.trim(), url: s.url.trim() || undefined })),
    confidence: f.confidence,
    notes: f.notes.trim(),
    verified: f.verified,
    status,
  };
}

function RoundForm({ initial, onCancel, onSave }: { initial: RoundFormState; onCancel: () => void; onSave: (f: RoundFormState, reason: string, source: string, evidenceUrl: string, changeConfidence: EditConfidence) => void }) {
  const [f, setF] = useState(initial);
  const [reason, setReason] = useState('');
  const [changeSource, setChangeSource] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [changeConfidence, setChangeConfidence] = useState<EditConfidence>('Medium');

  function update<K extends keyof RoundFormState>(key: K, val: RoundFormState[K]) {
    setF((prev) => ({ ...prev, [key]: val }));
  }

  function updateSource(i: number, key: 'label' | 'url', val: string) {
    setF((prev) => ({ ...prev, sources: prev.sources.map((s, idx) => (idx === i ? { ...s, [key]: val } : s)) }));
  }

  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-2 mt-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-[var(--text-dim)] uppercase">Round type</label>
          <select
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            value={f.type}
            onChange={(e) => update('type', e.target.value)}
          >
            {ROUND_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-dim)] uppercase">Date</label>
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="YYYY-MM-DD or YYYY"
            value={f.date}
            onChange={(e) => update('date', e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-dim)] uppercase">Amount ($M)</label>
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            type="number"
            placeholder="e.g. 2.5"
            value={f.amount}
            onChange={(e) => update('amount', e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-dim)] uppercase">Currency</label>
          <select
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            value={f.currency}
            onChange={(e) => update('currency', e.target.value)}
          >
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-[10px] text-[var(--text-dim)] uppercase">Investors (comma-separated)</label>
        <input
          className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
          value={f.investors}
          onChange={(e) => update('investors', e.target.value)}
        />
      </div>
      <div>
        <label className="text-[10px] text-[var(--text-dim)] uppercase">Lead investor (if known)</label>
        <input
          className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
          value={f.leadInvestor}
          onChange={(e) => update('leadInvestor', e.target.value)}
        />
      </div>

      <div>
        <label className="text-[10px] text-[var(--text-dim)] uppercase">Sources — add both if they disagree, explain the choice in Reason below</label>
        {f.sources.map((s, i) => (
          <div key={i} className="flex gap-2 mb-1">
            <input
              className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              placeholder="Source label"
              value={s.label}
              onChange={(e) => updateSource(i, 'label', e.target.value)}
            />
            <input
              className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              placeholder="URL (optional)"
              value={s.url}
              onChange={(e) => updateSource(i, 'url', e.target.value)}
            />
          </div>
        ))}
        <button
          onClick={() => update('sources', [...f.sources, { label: '', url: '' }])}
          className="text-[11px] text-[var(--accent-ink)]"
        >
          + another source
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 items-end">
        <div>
          <label className="text-[10px] text-[var(--text-dim)] uppercase">Round data confidence</label>
          <select
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            value={f.confidence}
            onChange={(e) => update('confidence', e.target.value as EditConfidence)}
          >
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--text)] pb-2">
          <input type="checkbox" checked={f.verified} onChange={(e) => update('verified', e.target.checked)} />
          Verified
        </label>
      </div>

      <div>
        <label className="text-[10px] text-[var(--text-dim)] uppercase">Notes</label>
        <textarea
          className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
          rows={2}
          value={f.notes}
          onChange={(e) => update('notes', e.target.value)}
        />
      </div>

      <div className="border-t border-[var(--border)] pt-2 space-y-2">
        <p className="text-[10px] text-[var(--text-dim)] uppercase">Why this change (required to save)</p>
        <textarea
          className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
          rows={2}
          placeholder="Reason for adjustment (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex gap-2">
          <input
            className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="Source of this change (required) — e.g. founder meeting"
            value={changeSource}
            onChange={(e) => setChangeSource(e.target.value)}
          />
          <select
            className="text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            value={changeConfidence}
            onChange={(e) => setChangeConfidence(e.target.value as EditConfidence)}
          >
            <option value="High">High confidence</option>
            <option value="Medium">Medium confidence</option>
            <option value="Low">Low confidence</option>
          </select>
        </div>
        <input
          className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
          placeholder="Evidence / supporting URL for this change (optional)"
          value={evidenceUrl}
          onChange={(e) => setEvidenceUrl(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            onClick={() => reason.trim() && changeSource.trim() && onSave(f, reason.trim(), changeSource.trim(), evidenceUrl.trim(), changeConfidence)}
            disabled={!reason.trim() || !changeSource.trim()}
            className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40"
          >
            Save round
          </button>
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md text-[var(--text-dim)]">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function RoundCard({ raw, id, fundIndex }: { raw: Company; id: string; fundIndex: Map<string, Fund> }) {
  const { getField, overrideField, revertFieldValue, userName } = useEditor();
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [removeReason, setRemoveReason] = useState('');
  const [removeSource, setRemoveSource] = useState('');

  const def = getRoundDefault(raw, id);
  const path = `round:${id}`;
  const field = getField(raw.id, path, def.value, def.source);
  const current = field.currentValue as RoundRecord | null;
  const lastEntry = field.history.at(-1);
  const isNew = def.value === null;

  if (!current) return null;

  function save(f: RoundFormState, reason: string, source: string, evidenceUrl: string, confidence: EditConfidence) {
    const newRound = fromFormState(f, 'active', id);
    overrideField(raw.id, path, def.value, def.source, {
      newValue: newRound,
      reason,
      source,
      evidenceUrl: evidenceUrl || undefined,
      confidence,
    });
    // Part 6/23: any investor named on this round who doesn't already have a fund profile
    // gets one auto-created and auto-researched -- no separate "add investor" step needed.
    onboardNewInvestors(newRound.investors, fundIndex, overrideField);
    setMode('view');
  }

  function remove() {
    if (!removeReason.trim() || !removeSource.trim() || !current) return;
    overrideField(raw.id, path, def.value, def.source, {
      newValue: { ...current, status: 'removed' },
      reason: removeReason.trim(),
      source: removeSource.trim(),
    });
    setMode('view');
  }

  function markUnverified() {
    if (!current) return;
    overrideField(raw.id, path, def.value, def.source, {
      newValue: { ...current, verified: false },
      reason: 'Flagged unverified by investor',
      source: `${userName} — manual flag`,
    });
  }

  function revert() {
    revertFieldValue(raw.id, path, def.value, def.source);
    setMode('view');
  }

  return (
    <div className="border border-[var(--border)] rounded-md p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-sm font-medium text-[var(--text-h)]">{current.type ?? 'Round'}</span>
          <span className="text-sm text-[var(--text)]"> — {formatAmount(current.amount, current.currency)}</span>
          {current.date && <span className="text-xs text-[var(--text-dim)]"> · {current.date}</span>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isNew && <Badge tone="new">Investor-added</Badge>}
          {field.isOverridden && !isNew && <Badge tone="judgment">Investor Judgment</Badge>}
          {!current.verified && <Badge tone="removed">Unverified</Badge>}
        </div>
      </div>

      {current.sourceDataset && (
        <p className="text-[10px] text-[var(--text-dim)]">
          Dataset: {current.sourceDataset === 'Both (2023-2026 Intake Dataset + Deals 2019-2025)' ? 'Merged from both sheets (Intake + 2019-2025)' : current.sourceDataset}
        </p>
      )}

      {current.conflict && !field.isOverridden && (
        <div className="border rounded p-2 text-xs space-y-1" style={{ borderColor: 'var(--moderate)', background: 'rgba(251, 191, 36, 0.08)' }}>
          <p className="font-medium" style={{ color: 'var(--moderate)' }}>
            DATA CONFLICT — the two source datasets disagree on {current.conflict.field === 'amountUsdM' ? 'amount' : 'round type'}
          </p>
          {current.conflict.values.map((v, i) => (
            <p key={i} className="text-[var(--text-dim)]">
              {String(v.value)} — <span className="text-[var(--text)]">{v.source}</span>
            </p>
          ))}
          <p className="text-[var(--text-dim)]">Currently showing: {current.conflict.field === 'amountUsdM' ? formatAmount(current.amount, current.currency) : current.type}. Use Edit below to choose the active value.</p>
        </div>
      )}

      <div className="text-xs text-[var(--text)]">
        {current.investors.length ? current.investors.join(', ') : 'No investors on record'}
        {current.leadInvestor && <span className="text-[var(--text-dim)]"> · lead: {current.leadInvestor}</span>}
      </div>

      {current.notes && <p className="text-xs text-[var(--text-dim)]">{current.notes}</p>}

      {current.sources.length > 0 && (
        <div className="text-[11px] text-[var(--text-dim)] flex flex-wrap gap-2">
          {current.sources.map((s, i) => (
            <span key={i}>
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer" className="text-[var(--accent-ink)]">
                  {s.label}
                </a>
              ) : (
                s.label
              )}
            </span>
          ))}
        </div>
      )}

      <div className="text-[11px] text-[var(--text-dim)]">
        {field.isOverridden
          ? `Source: ${lastEntry?.source ?? def.source} · ${lastEntry ? formatDate(lastEntry.timestamp) : ''} · ${lastEntry?.user ?? ''} · ${current.confidence} confidence`
          : `${def.source} · Last verified ${DATA_BUILD_DATE} · ${current.confidence} confidence`}
      </div>

      {mode === 'view' && (
        <div className="flex gap-3 pt-1">
          <button onClick={() => setMode('edit')} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            Edit
          </button>
          <button onClick={markUnverified} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            Mark unverified
          </button>
          <button onClick={() => setMode('remove')} className="text-xs text-[var(--text-dim)] hover:text-[var(--weak)]">
            Remove
          </button>
          {field.isOverridden && (
            <button onClick={revert} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
              Revert to original
            </button>
          )}
        </div>
      )}

      {mode === 'edit' && <RoundForm initial={toFormState(current)} onCancel={() => setMode('view')} onSave={save} />}

      {mode === 'remove' && (
        <div className="space-y-2 border-t border-[var(--border)] pt-2">
          <textarea
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            rows={2}
            placeholder="Reason for removing this round (required)"
            value={removeReason}
            onChange={(e) => setRemoveReason(e.target.value)}
          />
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="Source (required)"
            value={removeSource}
            onChange={(e) => setRemoveSource(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              onClick={remove}
              disabled={!removeReason.trim() || !removeSource.trim()}
              className="text-xs px-3 py-1.5 rounded-md text-white bg-[var(--weak)] font-medium disabled:opacity-40"
            >
              Confirm remove
            </button>
            <button onClick={() => setMode('view')} className="text-xs px-3 py-1.5 rounded-md text-[var(--text-dim)]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RemovedRoundCard({ raw, id }: { raw: Company; id: string }) {
  const { getField, revertFieldValue } = useEditor();
  const def = getRoundDefault(raw, id);
  const path = `round:${id}`;
  const field = getField(raw.id, path, def.value, def.source);
  const current = field.currentValue as RoundRecord | null;
  if (!current || current.status !== 'removed') return null;

  return (
    <div className="border border-[var(--border)] rounded-md p-3 opacity-50 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm text-[var(--text-h)]">
          {current.type} — {formatAmount(current.amount, current.currency)} {current.date && `· ${current.date}`}
        </span>
        <Badge tone="removed">Removed</Badge>
      </div>
      <p className="text-[11px] text-[var(--text-dim)]">{field.history.at(-1)?.reason}</p>
      <button onClick={() => revertFieldValue(raw.id, path, def.value, def.source)} className="text-xs text-[var(--accent-ink)]">
        Restore
      </button>
    </div>
  );
}

export function RoundsSection({ raw, edits, fundIndex }: { raw: Company; edits: ReturnType<typeof useEditor>['edits']; fundIndex: Map<string, Fund> }) {
  const { overrideField, userName } = useEditor();
  const [addingId, setAddingId] = useState<string | null>(null);

  const ids = allRoundIds(raw, edits);
  const activeRounds = resolveRounds(raw, edits);
  const summary = summarizeRounds(activeRounds);
  const removedIds = ids.filter((id) => {
    const def = getRoundDefault(raw, id);
    const value = (edits[raw.id]?.[`round:${id}`]?.currentValue ?? def.value) as RoundRecord | null;
    return value?.status === 'removed';
  });
  const [showRemoved, setShowRemoved] = useState(false);

  function startAdd() {
    setAddingId(`new-${uid()}`);
  }

  function saveNew(f: RoundFormState, reason: string, source: string, evidenceUrl: string, confidence: EditConfidence) {
    if (!addingId) return;
    const newRound = fromFormState(f, 'active', addingId);
    overrideField(raw.id, `round:${addingId}`, null, 'Investor-added — no automated research behind this round', {
      newValue: newRound,
      reason,
      source,
      evidenceUrl: evidenceUrl || undefined,
      confidence,
    });
    onboardNewInvestors(newRound.investors, fundIndex, overrideField);
    setAddingId(null);
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--text-h)]">Rounds on Record</h3>
        <button onClick={startAdd} className="text-xs px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent-ink)]">
          + Add Round
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <div className="border border-[var(--border)] rounded p-2">
          <div className="text-[var(--text-dim)]">Rounds on record</div>
          <div className="text-[var(--text-h)] font-semibold">{summary.count}</div>
        </div>
        <div className="border border-[var(--border)] rounded p-2">
          <div className="text-[var(--text-dim)]">Total disclosed funding</div>
          <div className="text-[var(--text-h)] font-semibold">${summary.totalDisclosedUsdM.toFixed(1)}M</div>
        </div>
        <div className="border border-[var(--border)] rounded p-2">
          <div className="text-[var(--text-dim)]">Latest round</div>
          <div className="text-[var(--text-h)] font-semibold">
            {summary.latest ? `${summary.latest.type} — ${formatAmount(summary.latest.amount, summary.latest.currency)}` : '—'}
          </div>
          {summary.latest?.date && <div className="text-[var(--text-dim)]">{summary.latest.date}</div>}
        </div>
      </div>

      {addingId && (
        <div className="border border-[var(--accent-ink)] rounded-md p-3 mb-3">
          <p className="text-xs text-[var(--text-dim)] mb-1">New round — added by {userName}</p>
          <RoundForm initial={toFormState(newRoundTemplate(addingId))} onCancel={() => setAddingId(null)} onSave={saveNew} />
        </div>
      )}

      <div className="space-y-2">
        {ids
          .filter((id) => {
            const def = getRoundDefault(raw, id);
            const value = (edits[raw.id]?.[`round:${id}`]?.currentValue ?? def.value) as RoundRecord | null;
            return value && value.status !== 'removed';
          })
          .map((id) => (
            <RoundCard key={id} raw={raw} id={id} fundIndex={fundIndex} />
          ))}
      </div>

      {removedIds.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setShowRemoved((s) => !s)} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            {showRemoved ? 'Hide' : 'Show'} removed rounds ({removedIds.length})
          </button>
          {showRemoved && (
            <div className="space-y-2 mt-2">
              {removedIds.map((id) => (
                <RemovedRoundCard key={id} raw={raw} id={id} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
