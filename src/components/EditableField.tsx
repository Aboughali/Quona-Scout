import { useState } from 'react';
import type { Company, EditConfidence } from '../types';
import type { FieldDef } from '../lib/fields';
import { getFieldDefault } from '../lib/fields';
import { useEditor } from '../context/EditorContext';
import { DATA_BUILD_DATE } from '../lib/colors';

function formatValue(_type: FieldDef['type'], value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'research' | 'judgment' }) {
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide font-medium"
      style={
        tone === 'judgment'
          ? { color: 'var(--accent-ink)', borderColor: 'var(--accent-border, var(--accent))', background: 'var(--accent-dim)' }
          : { color: 'var(--text-dim)', borderColor: 'var(--border)' }
      }
    >
      {children}
    </span>
  );
}

export function EditableField({ raw, def }: { raw: Company; def: FieldDef }) {
  const { getField, overrideField, revertFieldValue, addFieldSource, edits } = useEditor();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<'override' | 'addSource'>('override');
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [confidence, setConfidence] = useState<EditConfidence>('Medium');

  const original = getFieldDefault(raw, def.path, edits);
  const field = getField(raw.id, def.path, original.value, original.source);
  const lastEntry = field.history.at(-1);

  function openEditor(startMode: 'override' | 'addSource') {
    setMode(startMode);
    setDraft(Array.isArray(field.currentValue) ? (field.currentValue as string[]).join(', ') : formatValue(def.type, field.currentValue) === '—' ? '' : String(field.currentValue));
    setReason('');
    setSource('');
    setEvidenceUrl('');
    setConfidence('Medium');
    setEditing(true);
  }

  function saveSource() {
    if (!source.trim()) return;
    addFieldSource(raw.id, def.path, original.value, original.source, {
      label: source.trim(),
      url: evidenceUrl.trim() || undefined,
      confidence,
    });
    setEditing(false);
  }

  function parseDraft(): unknown {
    if (def.type === 'list') return draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (def.type === 'number') return draft.trim() ? Number(draft) : null;
    return draft.trim() ? draft : null;
  }

  function save() {
    if (!reason.trim() || !source.trim()) return;
    overrideField(raw.id, def.path, original.value, original.source, {
      newValue: parseDraft(),
      reason: reason.trim(),
      source: source.trim(),
      evidenceUrl: evidenceUrl.trim() || undefined,
      confidence,
    });
    setEditing(false);
  }

  function revert() {
    revertFieldValue(raw.id, def.path, original.value, original.source);
    setEditing(false);
  }

  return (
    <div className="border border-[var(--border)] rounded-md p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--text-dim)] uppercase tracking-wide">{def.label}</span>
        <div className="flex items-center gap-1.5">
          {field.isOverridden && <Badge tone="judgment">Investor Judgment</Badge>}
          {field.sources.length > 0 && (
            <span className="text-[10px] text-[var(--text-dim)]">+{field.sources.length} source{field.sources.length > 1 ? 's' : ''}</span>
          )}
          <button onClick={() => openEditor('addSource')} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            + Source
          </button>
          <button onClick={editing ? () => setEditing(false) : () => openEditor('override')} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            {editing ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>

      <div className="text-sm text-[var(--text-h)]">{formatValue(def.type, field.currentValue)}</div>

      {!editing && (
        <div className="text-[11px] text-[var(--text-dim)]">
          {field.isOverridden
            ? `Source: ${lastEntry?.source ?? field.originalSource} · ${lastEntry ? formatDate(lastEntry.timestamp) : ''} · ${lastEntry?.user ?? ''}`
            : `Source: ${field.originalSource} · Last verified ${DATA_BUILD_DATE}`}
        </div>
      )}

      {editing && mode === 'addSource' && (
        <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
          {field.sources.length > 0 && (
            <div className="text-[11px] space-y-1">
              {field.sources.map((s) => (
                <div key={s.id} className="bg-[var(--bg-panel-2)] rounded p-1.5">
                  {s.label} · {s.confidence} confidence
                  {s.url && (
                    <>
                      {' · '}
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-[var(--accent-ink)]">
                        link
                      </a>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="New corroborating source (required) — e.g. LinkedIn, founder meeting"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              placeholder="URL (optional)"
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
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
          <button
            onClick={saveSource}
            disabled={!source.trim()}
            className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40"
          >
            Add source
          </button>
        </div>
      )}

      {editing && mode === 'override' && (
        <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2">
          <div className="text-[11px] bg-[var(--bg-panel-2)] rounded p-2 space-y-0.5">
            <div className="text-[var(--text-dim)] uppercase tracking-wide">Automated / research value</div>
            <div className="text-[var(--text-h)]">{formatValue(def.type, field.originalValue)}</div>
            <div className="text-[var(--text-dim)]">{field.originalSource}</div>
          </div>

          {def.type === 'textarea' ? (
            <textarea
              className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              rows={3}
              placeholder={def.placeholder ?? 'New value'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : def.type === 'select' ? (
            <select
              className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            >
              <option value="">— select —</option>
              {def.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
              placeholder={def.placeholder ?? (def.type === 'list' ? 'Comma-separated values' : 'New value')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}

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
              placeholder="Source (required) — e.g. founder meeting, LinkedIn"
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

          <div className="flex gap-2 pt-1">
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
          </div>
        </div>
      )}
    </div>
  );
}
