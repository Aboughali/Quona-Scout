import { useMemo, useRef, useState } from 'react';
import companiesData from './data/companies.json';
import fundsData from './data/funds.json';
import type { Company, Fund } from './types';
import { STAGES, SYNDICATE_STAGE, isActiveAtStage, stageCounts } from './lib/funnel';
import { resolveCompany } from './lib/resolve';
import { resolveFundIndex } from './lib/funds';
import { buildInvestorMetricsIndex } from './lib/investorMetrics';
import { REFERENCE_SET } from './lib/investorFramework';
import { isValidBackup, summarizeBackup, type BackupFile } from './lib/editStore';
import { StageStepper } from './components/StageStepper';
import { StageCharts } from './components/StageCharts';
import { QuonaLogo } from './components/QuonaLogo';
import { CompanyTable } from './components/CompanyTable';
import { CompanyDrawer } from './components/CompanyDrawer';
import { MethodologyModal } from './components/MethodologyModal';
import { AddCompanyModal } from './components/AddCompanyModal';
import { ReviewQueue } from './components/ReviewQueue';
import { DataQualityView } from './components/DataQualityView';
import { NewsIntelligenceView } from './components/NewsIntelligenceView';
import { EditorProvider, useEditor } from './context/EditorContext';

const ETL_COMPANIES = companiesData as unknown as Company[];
const FUNDS = fundsData as unknown as Fund[];

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type View = 'funnel' | 'review' | 'quality' | 'news';

function AppInner() {
  const [view, setView] = useState<View>('funnel');
  const [stageN, setStageN] = useState(SYNDICATE_STAGE);
  const [showCut, setShowCut] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const [addCompanyOpen, setAddCompanyOpen] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [editingUserName, setEditingUserName] = useState(false);

  const { edits, userName, setUserName, manualCompanies, exportBackup, importBackup } = useEditor();
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Manually-added companies are concatenated onto the ETL output here, then flow through the
  // exact same resolveCompany/funnel/table/drawer pipeline as every gold-sheet company below --
  // no branch anywhere downstream needs to know a company came from "+ Add Company".
  const RAW_COMPANIES = useMemo(() => [...ETL_COMPANIES, ...manualCompanies], [manualCompanies]);
  const RAW_BY_ID = useMemo(() => new Map(RAW_COMPANIES.map((c) => [c.id, c])), [RAW_COMPANIES]);

  // Every investor named anywhere in the database, so an investor that is in neither the
  // scoring workbook nor funds.json still gets a fund profile (and can therefore be scored)
  // rather than silently rendering blank.
  const allInvestorNames = useMemo(() => {
    const names = new Set<string>();
    for (const c of RAW_COMPANIES) {
      for (const i of c.investors) names.add(i);
      for (const r of c.rounds) for (const i of r.investors) names.add(i);
    }
    return names;
  }, [RAW_COMPANIES]);

  const fundIndex = useMemo(() => resolveFundIndex(FUNDS, edits, allInvestorNames), [edits, allInvestorNames]);

  // Deal-derived investor metrics, recomputed whenever the company set or any round edit
  // changes -- this is what makes an added round immediately move its investors' scores.
  const metricsIndex = useMemo(
    () => buildInvestorMetricsIndex(RAW_COMPANIES, edits, REFERENCE_SET),
    [RAW_COMPANIES, edits]
  );

  const companies = useMemo(
    () => RAW_COMPANIES.map((c) => resolveCompany(c, edits, fundIndex, metricsIndex)),
    [RAW_COMPANIES, edits, fundIndex, metricsIndex]
  );

  const counts = useMemo(() => stageCounts(companies), [companies]);

  // Everything still standing at the selected stage, ignoring the search box -- this is the
  // population the charts describe, and it matches the stage card's count exactly.
  const stageActiveCompanies = useMemo(
    () => companies.filter((c) => isActiveAtStage(c, stageN)),
    [companies, stageN]
  );

  const stageCompanies = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(
      (c) => c.name.toLowerCase().includes(q) || c.investors.some((i) => i.toLowerCase().includes(q))
    );
  }, [companies, search]);

  const selectedCompany = companies.find((c) => c.id === selectedId) ?? null;
  const selectedRaw = selectedId ? RAW_BY_ID.get(selectedId) ?? null : null;

  function exportStage(n: number) {
    const active = companies.filter((c) => isActiveAtStage(c, n));
    const label = n === SYNDICATE_STAGE ? 'final-watchlist' : `stage${n}`;
    downloadJson(`quona-case-a-${label}.json`, active);
  }

  function handleExportBackup() {
    const backup = exportBackup();
    const stamp = backup.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
    downloadJson(`quona-scout-backup-${stamp}.json`, backup);
  }

  function handleImportFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setImportError(null);

    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setImportError('That file is not valid JSON.');
        return;
      }
      if (!isValidBackup(parsed)) {
        setImportError('That file does not look like a Quona Scout backup.');
        return;
      }
      const backup = parsed as BackupFile;
      const { entityCount, fieldCount, noteCount } = summarizeBackup(backup);
      const confirmed = window.confirm(
        `Import this backup?\n\n${fieldCount} field edit${fieldCount === 1 ? '' : 's'} across ${entityCount} ` +
          `compan${entityCount === 1 ? 'y' : 'ies'}/fund${entityCount === 1 ? '' : 's'}, ${noteCount} commentary note${noteCount === 1 ? '' : 's'}.\n` +
          `Exported: ${new Date(backup.exportedAt).toLocaleString()}\n\n` +
          `This REPLACES all current manual edits and commentary in this browser. This cannot be undone.`
      );
      if (!confirmed) return;
      importBackup(backup);
    };
    reader.readAsText(file);
  }

  const stageMeta = STAGES.find((s) => s.n === stageN)!;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 backdrop-blur bg-[rgba(255,255,255,0.86)] border-b border-[var(--border)]">
        <div className="px-6 py-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3.5">
            <QuonaLogo height={20} />
            <div className="w-px h-8 bg-[var(--border)]" />
            <div>
              <h1 className="text-[15px] font-extrabold text-[var(--text-h)] leading-tight">Scout</h1>
              <p className="text-[11px] text-[var(--text-dim)] leading-tight">Africa Fintech Sourcing · Aug 2023 – Aug 2026</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setAddCompanyOpen(true)}
              title="Manually add a company not in the gold-sheet dataset"
              className="q-lift text-xs px-3.5 py-2 rounded-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--text-h)] font-bold shadow-[var(--shadow-sm)]"
            >
              + Add Company
            </button>
            <button
              onClick={() => exportStage(SYNDICATE_STAGE)}
              className="q-lift text-xs px-3.5 py-2 rounded-full bg-[var(--text-h)] text-white font-bold"
            >
              Export Watchlist
            </button>

            <div className="w-px h-6 bg-[var(--border)] mx-1" />

            <button onClick={() => setMethodologyOpen(true)} className="text-xs px-3 py-2 rounded-full border border-[var(--border)] hover:border-[var(--text-dim)] hover:bg-[var(--bg-soft)] text-[var(--text)] font-medium">
              Methodology
            </button>
            <button
              onClick={() => exportStage(4)}
              title="Companies through Stage 4 (fintech + stage + geography), before the syndicate gate"
              className="text-xs px-3 py-2 rounded-full border border-[var(--border)] hover:border-[var(--text-dim)] hover:bg-[var(--bg-soft)] text-[var(--text)] font-medium"
            >
              Stage 4 shortlist
            </button>
            <button onClick={handleExportBackup} title="Download all your manual edits, overrides, and commentary as a JSON file"
              className="text-xs px-3 py-2 rounded-full border border-[var(--border)] hover:border-[var(--text-dim)] hover:bg-[var(--bg-soft)] text-[var(--text)] font-medium">
              Export Backup
            </button>
            <button onClick={() => importInputRef.current?.click()} title="Restore manual edits, overrides, and commentary from a previously exported backup file"
              className="text-xs px-3 py-2 rounded-full border border-[var(--border)] hover:border-[var(--text-dim)] hover:bg-[var(--bg-soft)] text-[var(--text)] font-medium">
              Import Backup
            </button>
            <input ref={importInputRef} type="file" accept="application/json,.json" onChange={handleImportFileChosen} className="hidden" />

            <div className="w-px h-6 bg-[var(--border)] mx-1" />

            <div className="text-xs text-[var(--text-dim)]">
              {editingUserName ? (
                <input
                  autoFocus
                  defaultValue={userName}
                  onBlur={(e) => { setUserName(e.target.value.trim() || 'Investor'); setEditingUserName(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  className="bg-[var(--bg-panel-2)] border border-[var(--border)] rounded-full px-2.5 py-1 text-[var(--text)] w-32"
                />
              ) : (
                <button
                  onClick={() => setEditingUserName(true)}
                  title="Change who edits are attributed to"
                  className="flex items-center gap-1.5 px-2 py-1 rounded-full hover:bg-[var(--bg-soft)]"
                >
                  <span className="w-6 h-6 rounded-full bg-[var(--accent)] text-[var(--text-h)] font-bold grid place-items-center text-[10px]">
                    {userName.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="text-[var(--text)] font-medium">{userName}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>
      {importError && (
        <div className="mx-6 mt-3 px-4 py-2.5 text-xs rounded-xl q-pop font-medium" style={{ color: 'var(--weak)', background: 'rgba(198, 40, 40, 0.10)' }}>
          {importError}{' '}
          <button onClick={() => setImportError(null)} className="underline">
            Dismiss
          </button>
        </div>
      )}
      {justAdded && (
        <div className="mx-6 mt-3 px-4 py-2.5 text-xs rounded-xl q-pop font-medium" style={{ color: 'var(--strong)', background: 'rgba(47, 125, 50, 0.10)' }}>
          "{justAdded}" added successfully.
        </div>
      )}

      <nav className="px-6 pt-5 flex gap-1 items-center">
        <button
          onClick={() => setView('funnel')}
          className={`text-[13px] font-semibold px-4 py-2 rounded-full transition ${view === 'funnel' ? 'bg-[var(--text-h)] text-white shadow-[var(--shadow-sm)]' : 'text-[var(--text-dim)] hover:text-[var(--text-h)] hover:bg-[var(--bg-soft)]'}`}
        >
          Funnel
        </button>
        <button
          onClick={() => setView('review')}
          className={`text-[13px] font-semibold px-4 py-2 rounded-full transition ${view === 'review' ? 'bg-[var(--text-h)] text-white shadow-[var(--shadow-sm)]' : 'text-[var(--text-dim)] hover:text-[var(--text-h)] hover:bg-[var(--bg-soft)]'}`}
        >
          Needs Review
        </button>
        <button
          onClick={() => setView('quality')}
          className={`text-[13px] font-semibold px-4 py-2 rounded-full transition ${view === 'quality' ? 'bg-[var(--text-h)] text-white shadow-[var(--shadow-sm)]' : 'text-[var(--text-dim)] hover:text-[var(--text-h)] hover:bg-[var(--bg-soft)]'}`}
        >
          Data Quality
        </button>
        <button
          onClick={() => setView('news')}
          className={`text-[13px] font-semibold px-4 py-2 rounded-full transition ${view === 'news' ? 'bg-[var(--text-h)] text-white shadow-[var(--shadow-sm)]' : 'text-[var(--text-dim)] hover:text-[var(--text-h)] hover:bg-[var(--bg-soft)]'}`}
        >
          News &amp; Intelligence
        </button>
      </nav>

      <main className="p-6 space-y-5">
        {view === 'funnel' ? (
          <>
            <StageStepper counts={counts} selected={stageN} onSelect={setStageN} />

            {/* Breakdowns of the population currently standing at the selected stage. Uses the
                stage-active set (not the search-filtered rows), so the totals always agree with
                the count on the stage card above. */}
            <StageCharts companies={stageActiveCompanies} stageLabel={`${stageMeta.short} — ${stageMeta.label}`} />

            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-base font-semibold text-[var(--text-h)]">
                  {stageMeta.short} — {stageMeta.label}
                </h2>
                <p className="text-xs text-[var(--text-dim)]">{counts[stageN]} active companies at this width</p>
              </div>
              <div className="flex items-center gap-3">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search company or investor..."
                  className="text-sm bg-[var(--bg-panel)] border border-[var(--border)] rounded-full px-4 py-2 text-[var(--text)] w-64 shadow-[var(--shadow-sm)] focus:border-[var(--text-dim)]"
                />
                <label className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
                  <input type="checkbox" checked={showCut} onChange={(e) => setShowCut(e.target.checked)} />
                  Show cut companies
                </label>
              </div>
            </div>

            <CompanyTable
              companies={stageCompanies}
              rawById={RAW_BY_ID}
              stageN={stageN}
              fundIndex={fundIndex}
              metricsIndex={metricsIndex}
              showCut={showCut}
              onSelect={(c) => setSelectedId(c.id)}
            />
          </>
        ) : view === 'review' ? (
          <ReviewQueue companies={companies} rawById={RAW_BY_ID} fundIndex={fundIndex} metricsIndex={metricsIndex} onSelect={(c) => setSelectedId(c.id)} />
        ) : view === 'quality' ? (
          <DataQualityView rawCompanies={RAW_COMPANIES} edits={edits} onOpenCompany={(id) => { setView('funnel'); setSelectedId(id); }} />
        ) : (
          <NewsIntelligenceView />
        )}
      </main>

      {selectedCompany && selectedRaw && (
        <CompanyDrawer company={selectedCompany} raw={selectedRaw} fundIndex={fundIndex} metricsIndex={metricsIndex} onClose={() => setSelectedId(null)} />
      )}

      {methodologyOpen && <MethodologyModal onClose={() => setMethodologyOpen(false)} />}

      {addCompanyOpen && (
        <AddCompanyModal
          existingCompanies={RAW_COMPANIES}
          fundIndex={fundIndex}
          onClose={() => setAddCompanyOpen(false)}
          onOpenExisting={(id) => {
            setAddCompanyOpen(false);
            setSelectedId(id);
          }}
          onCreated={(created) => {
            setAddCompanyOpen(false);
            setSelectedId(created.id);
            setJustAdded(created.name);
            window.setTimeout(() => setJustAdded(null), 5000);
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <EditorProvider>
      <AppInner />
    </EditorProvider>
  );
}
