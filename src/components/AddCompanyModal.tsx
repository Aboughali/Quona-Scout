import { useState } from 'react';
import type { Company, Fund } from '../types';
import { useEditor } from '../context/EditorContext';
import { buildInitialRoundRecord, buildManualCompany, findExistingCompany, type ManualRoundInput } from '../lib/manualCompany';
import { CURRENCY_OPTIONS, ROUND_TYPE_OPTIONS, getRoundDefault } from '../lib/rounds';
import { STATUS_OPTIONS } from '../lib/fields';
import { onboardNewInvestors } from '../lib/investorAutomation';
import { researchingPlaceholder, runCompanyResearch } from '../lib/research';

const inputClass = 'w-full text-sm bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-md px-3 py-1.5 text-[var(--text)]';
const labelClass = 'text-[11px] text-[var(--text-dim)] uppercase tracking-wide';

interface FormState {
  name: string;
  country: string;
  city: string;
  website: string;
  description: string;
  category: string;
  status: string;
  founders: string;
  notes: string;
  addRound: boolean;
  roundType: string;
  amount: string;
  currency: string;
  date: string;
  investors: string;
  leadInvestor: string;
  sourceUrl: string;
  roundNotes: string;
}

const BLANK: FormState = {
  name: '', country: '', city: '', website: '', description: '', category: '', status: 'Active', founders: '', notes: '',
  addRound: false, roundType: 'Seed', amount: '', currency: 'USD', date: '', investors: '', leadInvestor: '', sourceUrl: '', roundNotes: '',
};

interface AddCompanyModalProps {
  existingCompanies: Company[];
  fundIndex: Map<string, Fund>;
  onClose: () => void;
  onCreated: (company: Company) => void;
  onOpenExisting: (companyId: string) => void;
}

export function AddCompanyModal({ existingCompanies, fundIndex, onClose, onCreated, onOpenExisting }: AddCompanyModalProps) {
  const { userName, addManualCompany, overrideField, addNote } = useEditor();
  const [f, setF] = useState<FormState>(BLANK);
  const [duplicate, setDuplicate] = useState<Company | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, val: FormState[K]) {
    setF((prev) => ({ ...prev, [key]: val }));
    if (key === 'name') setDuplicate(null);
  }

  function checkDuplicate(name: string) {
    if (!name.trim()) return;
    const match = findExistingCompany(name, existingCompanies);
    setDuplicate(match);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const name = f.name.trim();
    if (!name) {
      setError('Company name is required.');
      return;
    }
    const match = findExistingCompany(name, existingCompanies);
    if (match) {
      setDuplicate(match);
      return;
    }

    const founders = f.founders.split(',').map((s) => s.trim()).filter(Boolean);
    const round: ManualRoundInput | null = f.addRound
      ? {
          type: f.roundType,
          amount: f.amount.trim() ? Number(f.amount) : null,
          currency: f.currency || 'USD',
          date: f.date.trim(),
          investors: f.investors.split(',').map((s) => s.trim()).filter(Boolean),
          leadInvestor: f.leadInvestor.trim(),
          sourceUrl: f.sourceUrl.trim(),
          notes: f.roundNotes.trim(),
        }
      : null;

    const company = buildManualCompany(
      {
        name,
        country: f.country.trim(),
        city: f.city.trim(),
        website: f.website.trim(),
        description: f.description.trim(),
        category: f.category.trim(),
        status: f.status,
        founders,
        round,
      },
      userName
    );

    addManualCompany(company);

    if (round) {
      const { id, record } = buildInitialRoundRecord(round);
      const def = getRoundDefault(company, id);
      overrideField(company.id, `round:${id}`, def.value, def.source, {
        newValue: record,
        reason: 'Added at company creation',
        source: round.sourceUrl || 'Investor-provided, entered at company creation',
        evidenceUrl: round.sourceUrl || undefined,
        confidence: round.sourceUrl ? 'High' : 'Medium',
      });
      // Part 16/23: investors entered with the round are auto-linked and auto-researched --
      // never a separate "go create the syndicate" step.
      onboardNewInvestors(record.investors, fundIndex, overrideField);
    }

    if (f.notes.trim()) {
      addNote(company.id, {
        type: 'Research note',
        text: f.notes.trim(),
        source: 'Added at company creation',
      });
    }

    // Part 5/22: saving a new company automatically starts web research and, once it settles,
    // the existing funnel/scoring pipeline just recomputes on the next render -- no separate
    // "Research Company" button. Persisted through the same field-edit engine as everything
    // else so it's visible (and its own history) in the drawer.
    overrideField(company.id, 'research.company', null, 'Not yet researched', {
      newValue: researchingPlaceholder(),
      reason: 'Automatic research started at company creation',
      source: 'System — automatic research',
    });
    runCompanyResearch(company.name).then((result) => {
      overrideField(company.id, 'research.company', null, 'Not yet researched', {
        newValue: result,
        reason: 'Automatic research completed',
        source: 'System — automatic research',
      });
    });

    onCreated(company);
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-6" onClick={onClose}>
      <div
        className="max-w-2xl w-full max-h-[90vh] overflow-y-auto bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg p-6 space-y-4 text-sm text-[var(--text)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-h)]">Add New Company</h2>
          <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text-h)]">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-[var(--text-h)] uppercase tracking-wide">Company Information</h3>
            <div>
              <label className={labelClass}>Company name *</label>
              <input
                className={inputClass}
                value={f.name}
                onChange={(e) => update('name', e.target.value)}
                onBlur={(e) => checkDuplicate(e.target.value)}
                required
              />
              {duplicate && (
                <div className="mt-1.5 text-xs px-3 py-2 rounded-md border" style={{ color: 'var(--weak)', borderColor: 'var(--weak)', background: 'rgba(248, 113, 113, 0.08)' }}>
                  Company already exists: <b>{duplicate.name}</b>.{' '}
                  <button type="button" onClick={() => onOpenExisting(duplicate.id)} className="underline font-medium">
                    Open existing company
                  </button>{' '}
                  instead, or change the name above.
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Country</label>
                <input className={inputClass} value={f.country} onChange={(e) => update('country', e.target.value)} placeholder="e.g. Nigeria" />
              </div>
              <div>
                <label className={labelClass}>City</label>
                <input className={inputClass} value={f.city} onChange={(e) => update('city', e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelClass}>Website</label>
              <input className={inputClass} value={f.website} onChange={(e) => update('website', e.target.value)} placeholder="https://" />
            </div>
            <div>
              <label className={labelClass}>Description</label>
              <textarea className={inputClass} rows={2} value={f.description} onChange={(e) => update('description', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Fintech / financial-services category</label>
                <input className={inputClass} value={f.category} onChange={(e) => update('category', e.target.value)} placeholder="e.g. embedded lending" />
              </div>
              <div>
                <label className={labelClass}>Company status</label>
                <select className={inputClass} value={f.status} onChange={(e) => update('status', e.target.value)}>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelClass}>Founder(s)</label>
              <input className={inputClass} value={f.founders} onChange={(e) => update('founders', e.target.value)} placeholder="Comma-separated" />
            </div>
            <div>
              <label className={labelClass}>Notes / commentary</label>
              <textarea className={inputClass} rows={2} value={f.notes} onChange={(e) => update('notes', e.target.value)} placeholder="Optional -- saved as a commentary note on the new company" />
            </div>
          </section>

          <section className="space-y-3 border-t border-[var(--border)] pt-4">
            <label className="flex items-center gap-2 text-xs font-semibold text-[var(--text-h)] uppercase tracking-wide">
              <input type="checkbox" checked={f.addRound} onChange={(e) => update('addRound', e.target.checked)} />
              Funding Information (optional)
            </label>
            {f.addRound && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Round type</label>
                    <select className={inputClass} value={f.roundType} onChange={(e) => update('roundType', e.target.value)}>
                      {ROUND_TYPE_OPTIONS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Date</label>
                    <input className={inputClass} value={f.date} onChange={(e) => update('date', e.target.value)} placeholder="YYYY-MM-DD" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Amount (USD millions)</label>
                    <input className={inputClass} type="number" step="0.01" value={f.amount} onChange={(e) => update('amount', e.target.value)} />
                  </div>
                  <div>
                    <label className={labelClass}>Currency</label>
                    <select className={inputClass} value={f.currency} onChange={(e) => update('currency', e.target.value)}>
                      {CURRENCY_OPTIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className={labelClass}>Investors</label>
                  <input className={inputClass} value={f.investors} onChange={(e) => update('investors', e.target.value)} placeholder="Comma-separated fund/investor names" />
                </div>
                <div>
                  <label className={labelClass}>Lead investor</label>
                  <input className={inputClass} value={f.leadInvestor} onChange={(e) => update('leadInvestor', e.target.value)} />
                </div>
                <div>
                  <label className={labelClass}>Source / URL</label>
                  <input className={inputClass} value={f.sourceUrl} onChange={(e) => update('sourceUrl', e.target.value)} placeholder="https://" />
                </div>
                <div>
                  <label className={labelClass}>Round notes</label>
                  <textarea className={inputClass} rows={2} value={f.roundNotes} onChange={(e) => update('roundNotes', e.target.value)} />
                </div>
              </div>
            )}
          </section>

          {error && <p className="text-xs" style={{ color: 'var(--weak)' }}>{error}</p>}

          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-[var(--border)] text-[var(--text)]">
              Cancel
            </button>
            <button type="submit" className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium">
              Add Company
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
