import { useRef, useState } from 'react';
import { useEditor } from '../context/EditorContext';
import {
  ACCEPTED_UPLOAD_TYPES,
  KIND_LABEL,
  bulletsFromMetrics,
  formatBytes,
  tractionFileUrl,
  uploadTractionDocument,
  type TractionEntry,
  type TractionKind,
  type TractionMetric,
} from '../lib/traction';

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

const STATUS_META: Record<TractionEntry['aiStatus'], { label: string; color: string }> = {
  summarised: { label: 'AI summary', color: 'var(--accent-ink)' },
  'no-traction-found': { label: 'No traction data found', color: 'var(--moderate)' },
  unavailable: { label: 'Summary unavailable', color: 'var(--weak)' },
  manual: { label: 'Entered manually', color: 'var(--text-dim)' },
};

const EMPTY_METRICS: TractionMetric[] = [
  { label: '', value: '' },
  { label: '', value: '' },
  { label: '', value: '' },
];

/**
 * Traction: what the investor knows about whether the business is actually working.
 *
 * Anyone can add evidence three ways -- upload a pitch deck, upload financials, or type the
 * numbers in. Uploads are read by the AI agent, which returns 2-3 bulleted updates; manual
 * entries are already structured, so no model touches them.
 *
 * Every card states its own provenance (AI summary vs. entered manually, by whom, when) because
 * these bullets sit beside gold-sheet data and must never be mistaken for verified research.
 * A failed summary is shown as a card with the reason on it rather than being swallowed -- the
 * document is on file either way.
 */
export function TractionSection({ companyId, companyName }: { companyId: string; companyName: string }) {
  const { getTractionEntries, addTractionEntry, removeTractionEntry, userName } = useEditor();
  const entries = [...getTractionEntries(companyId)].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));

  const [menuOpen, setMenuOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Manual-entry form state
  const [title, setTitle] = useState('');
  const [metrics, setMetrics] = useState<TractionMetric[]>(EMPTY_METRICS);
  const [asOf, setAsOf] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [note, setNote] = useState('');

  const fileInput = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<TractionKind>('other');

  function pickFile(kind: TractionKind) {
    pendingKind.current = kind;
    setMenuOpen(false);
    setError(null);
    fileInput.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset immediately so choosing the same file twice still fires a change event.
    e.target.value = '';
    if (!file) return;

    const kind = pendingKind.current;
    setBusy(`Reading ${file.name} — the agent is scanning it for traction…`);
    setError(null);
    const result = await uploadTractionDocument({ file, companyId, companyName, kind });
    setBusy(null);

    if (!result.ok || !result.entry) {
      setError(result.error ?? 'Upload failed.');
      return;
    }
    const { uploadedAt, ...entry } = result.entry;
    addTractionEntry({ ...entry, kind, companyId, addedAt: uploadedAt });
  }

  function saveManual() {
    const bullets = bulletsFromMetrics(metrics, note);
    if (!bullets.length) return;
    addTractionEntry({
      id: `manual-${Math.random().toString(36).slice(2, 10)}`,
      companyId,
      kind: 'manual',
      title: title.trim() || 'Traction update',
      metrics: metrics.filter((m) => m.label.trim() && m.value.trim()),
      asOf: asOf.trim() || undefined,
      sourceLabel: sourceLabel.trim() || undefined,
      note: note.trim() || undefined,
      bullets,
      aiStatus: 'manual',
    });
    setTitle('');
    setMetrics(EMPTY_METRICS);
    setAsOf('');
    setSourceLabel('');
    setNote('');
    setManualOpen(false);
  }

  const canSaveManual = metrics.some((m) => m.label.trim() && m.value.trim());

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-h)]">Traction</h3>
          <p className="text-[10px] text-[var(--text-dim)]">
            Evidence the business is working — decks, financials, or numbers you add yourself.
          </p>
        </div>

        <div className="relative">
          <button
            onClick={() => { setMenuOpen((o) => !o); setManualOpen(false); }}
            aria-label="Add traction evidence"
            title="Add traction evidence"
            className="w-7 h-7 rounded-full bg-[var(--accent)] text-[#0b0c10] text-base leading-none font-semibold hover:bg-[var(--accent-hover)]"
          >
            +
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-1 z-10 w-56 bg-[var(--bg-panel)] border border-[var(--border)] rounded-md shadow-[var(--shadow-md)] overflow-hidden">
              {([
                ['pitch-deck', 'Upload pitch deck', 'PDF or PowerPoint'],
                ['financials', 'Upload financials', 'Excel, CSV or PDF'],
              ] as const).map(([kind, label, hint]) => (
                <button
                  key={kind}
                  onClick={() => pickFile(kind)}
                  className="block w-full text-left px-3 py-2 hover:bg-[var(--bg-panel-2)]"
                >
                  <span className="block text-xs text-[var(--text-h)]">{label}</span>
                  <span className="block text-[10px] text-[var(--text-dim)]">{hint}</span>
                </button>
              ))}
              <button
                onClick={() => { setMenuOpen(false); setManualOpen(true); }}
                className="block w-full text-left px-3 py-2 hover:bg-[var(--bg-panel-2)] border-t border-[var(--border)]"
              >
                <span className="block text-xs text-[var(--text-h)]">Add data manually</span>
                <span className="block text-[10px] text-[var(--text-dim)]">Type in the metrics yourself</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_UPLOAD_TYPES}
        onChange={onFileChosen}
        className="hidden"
      />

      {busy && (
        <div className="border border-[var(--border)] rounded-md p-3 mb-2 text-xs text-[var(--text-dim)] flex items-center gap-2">
          <span className="w-3 h-3 rounded-full border-2 border-[var(--accent-ink)] border-t-transparent animate-spin" />
          {busy}
        </div>
      )}

      {error && (
        <div className="border rounded-md p-2.5 mb-2 text-xs" style={{ borderColor: 'var(--weak)', color: 'var(--weak)' }}>
          {error}
        </div>
      )}

      {manualOpen && (
        <div className="border border-[var(--border)] rounded-md p-3 space-y-2 mb-3">
          <input
            className="w-full text-sm bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="Title (e.g. Q2 2026 metrics from founder call)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="space-y-1.5">
            {metrics.map((m, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
                  placeholder={i === 0 ? 'Metric (e.g. Monthly revenue)' : 'Metric'}
                  value={m.label}
                  onChange={(e) => setMetrics((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                />
                <input
                  className="w-36 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
                  placeholder={i === 0 ? '$562k' : 'Value'}
                  value={m.value}
                  onChange={(e) => setMetrics((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              placeholder="As of (e.g. Q2 2026)"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
            <input
              className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
              placeholder="Source (e.g. founder call)"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
            />
          </div>
          <textarea
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            rows={2}
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              onClick={saveManual}
              disabled={!canSaveManual}
              className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40"
            >
              Save traction
            </button>
            <button
              onClick={() => setManualOpen(false)}
              className="text-xs px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text-dim)]"
            >
              Cancel
            </button>
          </div>
          <p className="text-[10px] text-[var(--text-dim)]">Saved as {userName}. No AI is used for manual entries.</p>
        </div>
      )}

      {entries.length === 0 && !busy ? (
        <p className="text-xs text-[var(--text-dim)]">
          No traction on file yet. Use <span className="text-[var(--text-h)]">+</span> to upload a pitch deck or
          financials — the agent reads the document and pulls out 2-3 traction updates — or to type metrics in yourself.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const status = STATUS_META[entry.aiStatus];
            return (
              <div key={entry.id} className="border border-[var(--border)] rounded-md p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <span className="text-sm font-medium text-[var(--text-h)]">
                    {entry.kind === 'manual' ? entry.title : entry.fileName}
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {/* A manual entry's kind and its provenance are the same fact, so it carries
                        one badge; an upload carries both (what it is, and where the bullets came from). */}
                    {entry.kind !== 'manual' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-dim)] uppercase tracking-wide">
                        {KIND_LABEL[entry.kind]}
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide" style={{ color: status.color, borderColor: status.color }}>
                      {status.label}
                    </span>
                  </span>
                </div>

                <p className="text-[11px] text-[var(--text-dim)]">
                  {[
                    entry.docKind,
                    entry.period ? `covers ${entry.period}` : null,
                    entry.fileSizeBytes ? formatBytes(entry.fileSizeBytes) : null,
                    entry.asOf ? `as of ${entry.asOf}` : null,
                    entry.sourceLabel,
                    `added by ${entry.addedBy} on ${fmtDate(entry.addedAt)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>

                {entry.bullets.length > 0 && (
                  <ul className="space-y-1 pt-0.5">
                    {entry.bullets.map((b, i) => (
                      <li key={i} className="text-xs text-[var(--text)] flex gap-1.5">
                        <span style={{ color: 'var(--accent-ink)' }}>•</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {entry.aiNote && <p className="text-[11px]" style={{ color: status.color }}>{entry.aiNote}</p>}

                {entry.truncated && (
                  <p className="text-[10px] text-[var(--text-dim)]">
                    Document was long — the agent read the first portion only.
                  </p>
                )}

                <div className="flex items-center gap-3 text-[11px] pt-0.5">
                  {entry.filePath && (
                    <a href={tractionFileUrl(entry.filePath)} target="_blank" rel="noreferrer" className="text-[var(--accent-ink)]">
                      Open original
                    </a>
                  )}
                  {entry.model && (
                    <span className="text-[var(--text-dim)]" title={entry.estimatedCostUsd ? `~$${entry.estimatedCostUsd} at list price` : undefined}>
                      {entry.model}
                    </span>
                  )}
                  <button
                    onClick={() => removeTractionEntry(companyId, entry.id)}
                    className="text-[var(--text-dim)] hover:text-[var(--weak)] ml-auto"
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
