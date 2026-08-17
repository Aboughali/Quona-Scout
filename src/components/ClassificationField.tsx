import { useState } from 'react';
import type { Company, EditConfidence } from '../types';
import type { ClassificationDef } from '../lib/fields';
import { getFieldDefault } from '../lib/fields';
import { useEditor } from '../context/EditorContext';
import { DATA_BUILD_DATE } from '../lib/colors';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

/** Same audit-trail engine as EditableField, specialized for Yes/No classification gates
 *  (Fintech?, Series A?, 3+ markets?, Strong syndicate?) with the exact
 *  "Automated: X / Investor judgment: Y" presentation asked for. */
export function ClassificationField({
  raw,
  def,
  liveAutomatedValue,
  liveAutomatedSource,
}: {
  raw: Company;
  def: ClassificationDef;
  /** For strongSyndicate, the automated value depends on live fund data, not just static JSON. */
  liveAutomatedValue?: boolean;
  liveAutomatedSource?: string;
}) {
  const { getField, overrideField, revertFieldValue, edits } = useEditor();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<boolean>(true);
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [confidence, setConfidence] = useState<EditConfidence>('Medium');

  const staticDefault = getFieldDefault(raw, def.path, edits);
  const originalValue = liveAutomatedValue ?? (staticDefault.value as boolean);
  const originalSource = liveAutomatedSource ?? staticDefault.source;
  const field = getField(raw.id, def.path, originalValue, originalSource);
  const current = field.currentValue as boolean;
  const lastEntry = field.history.at(-1);

  function openEditor() {
    setDraft(!current);
    setReason('');
    setSource('');
    setEvidenceUrl('');
    setConfidence('Medium');
    setEditing(true);
  }

  function save() {
    if (!reason.trim() || !source.trim()) return;
    overrideField(raw.id, def.path, originalValue, originalSource, {
      newValue: draft,
      reason: reason.trim(),
      source: source.trim(),
      evidenceUrl: evidenceUrl.trim() || undefined,
      confidence,
    });
    setEditing(false);
  }

  function revert() {
    revertFieldValue(raw.id, def.path, originalValue, originalSource);
    setEditing(false);
  }

  return (
    <div className="border border-[var(--border)] rounded-md p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-[var(--text-h)]">{def.label}</span>
        {field.isOverridden && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide font-medium"
            style={{ color: 'var(--accent-ink)', borderColor: 'var(--accent-border, var(--accent))', background: 'var(--accent-dim)' }}
          >
            Investor Judgment
          </span>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-dim)]">{def.hint}</p>

      <div className="flex items-center gap-4 text-xs">
        <div>
          <span className="text-[var(--text-dim)]">Automated: </span>
          <span className="text-[var(--text-h)] font-medium">{originalValue ? 'Yes' : 'No'}</span>
        </div>
        {field.isOverridden && (
          <div>
            <span className="text-[var(--text-dim)]">Investor judgment: </span>
            <span style={{ color: current ? 'var(--strong)' : 'var(--weak)' }} className="font-medium">
              {current ? 'Yes' : 'No'}
            </span>
          </div>
        )}
      </div>

      {!editing ? (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-dim)]">
            {field.isOverridden
              ? `${lastEntry?.source ?? originalSource} · ${lastEntry ? formatDate(lastEntry.timestamp) : ''} · ${lastEntry?.user ?? ''}`
              : `${originalSource} · Last verified ${DATA_BUILD_DATE}`}
          </span>
          <button onClick={openEditor} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            Edit / Override
          </button>
        </div>
      ) : (
        <div className="mt-1 space-y-2 border-t border-[var(--border)] pt-2">
          <div className="flex gap-2">
            <button
              onClick={() => setDraft(true)}
              className={`text-xs px-3 py-1 rounded-md border ${draft ? 'border-[var(--strong)] text-[var(--strong)]' : 'border-[var(--border)] text-[var(--text-dim)]'}`}
            >
              Yes
            </button>
            <button
              onClick={() => setDraft(false)}
              className={`text-xs px-3 py-1 rounded-md border ${!draft ? 'border-[var(--weak)] text-[var(--weak)]' : 'border-[var(--border)] text-[var(--text-dim)]'}`}
            >
              No
            </button>
          </div>
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
              placeholder="Evidence/source (required) — e.g. founder meeting"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <select
              className="text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as EditConfidence)}
            >
              <option value="High">High confidence</option>
              <option value="Medium">Medium confidence</option>
              <option value="Low">Low confidence</option>
            </select>
          </div>
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="Evidence / supporting URL (optional)"
            value={evidenceUrl}
            onChange={(e) => setEvidenceUrl(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={!reason.trim() || !source.trim()}
              className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40"
            >
              Save judgment
            </button>
            {field.isOverridden && (
              <button onClick={revert} className="text-xs px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text)]">
                Revert to original
              </button>
            )}
            <button onClick={() => setEditing(false)} className="text-xs px-3 py-1.5 rounded-md text-[var(--text-dim)]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
