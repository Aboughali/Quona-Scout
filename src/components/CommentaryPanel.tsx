import { useState } from 'react';
import type { CommentaryNote } from '../types';
import { useEditor } from '../context/EditorContext';

const NOTE_TYPES: CommentaryNote['type'][] = [
  'Meeting notes', 'Founder comment', 'Investor comment', 'Email note',
  'Research note', 'Internal thought', 'Follow-up', 'Question to investigate',
];

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function CommentaryPanel({ companyId }: { companyId: string }) {
  const { getNotes, addNote, userName } = useEditor();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CommentaryNote['type']>('Meeting notes');
  const [text, setText] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [source, setSource] = useState('');

  const notes = [...getNotes(companyId)].sort((a, b) => (a.date < b.date ? 1 : -1));

  function submit() {
    if (!text.trim()) return;
    addNote(companyId, {
      type,
      text: text.trim(),
      nextAction: nextAction.trim() || undefined,
      source: source.trim() || undefined,
    });
    setText('');
    setNextAction('');
    setSource('');
    setOpen(false);
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--text-h)]">Commentary</h3>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-xs px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent-ink)]"
        >
          {open ? 'Cancel' : '+ Add Commentary'}
        </button>
      </div>

      {open && (
        <div className="border border-[var(--border)] rounded-md p-3 space-y-2 mb-3">
          <div className="flex gap-2 items-center text-xs text-[var(--text-dim)]">
            <select
              className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
              value={type}
              onChange={(e) => setType(e.target.value as CommentaryNote['type'])}
            >
              {NOTE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span>by {userName} · now</span>
          </div>
          <textarea
            className="w-full text-sm bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            rows={3}
            placeholder="Commentary..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="Next action (optional)"
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
          />
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
            placeholder="Source (optional)"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40"
          >
            Save note
          </button>
        </div>
      )}

      <div className="space-y-2">
        {notes.length === 0 && <p className="text-xs text-[var(--text-dim)]">No commentary yet.</p>}
        {notes.map((n) => (
          <div key={n.id} className="text-xs border border-[var(--border)] rounded-md p-2.5 space-y-1">
            <div className="flex items-center justify-between text-[var(--text-dim)]">
              <span className="font-medium text-[var(--text-h)]">{n.type}</span>
              <span>
                {formatDateTime(n.date)} · {n.author}
              </span>
            </div>
            <p className="text-[var(--text)]">{n.text}</p>
            {n.nextAction && (
              <p className="text-[var(--accent-ink)]">
                <span className="text-[var(--text-dim)]">Next action: </span>
                {n.nextAction}
              </p>
            )}
            {n.source && <p className="text-[var(--text-dim)]">Source: {n.source}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
