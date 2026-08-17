import type { Company, Fund } from '../types';
import { computeSyndicateGate, passedContentGates, type MetricsIndex } from '../lib/funnel';
import { resolveCompany } from '../lib/resolve';
import { CLASSIFICATION_REGISTRY, FIELD_REGISTRY } from '../lib/fields';
import { EditableField } from './EditableField';
import { ClassificationField } from './ClassificationField';
import { CommentaryPanel } from './CommentaryPanel';
import { ChangeHistoryPanel } from './ChangeHistoryPanel';
import { RoundsSection } from './RoundsSection';
import { InvestorSyndicateSection } from './InvestorSyndicateSection';
import { CompanyNewsSection } from './CompanyNewsSection';
import { TractionSection } from './TractionSection';
import { useEditor } from '../context/EditorContext';
import type { ResearchResult } from '../lib/research';

const RESEARCH_STATUS_META: Record<ResearchResult['status'], { icon: string; label: string; color: string }> = {
  researching: { icon: '🔄', label: 'Researching…', color: 'var(--text-dim)' },
  complete: { icon: '✓', label: 'Research complete', color: 'var(--strong)' },
  'insufficient-evidence': { icon: '⚠', label: 'Insufficient Evidence', color: 'var(--moderate)' },
  error: { icon: '⚠', label: 'Research error', color: 'var(--weak)' },
};

/** Case brief Part 5/16/22: shows the outcome of the automatic research kicked off the moment
 *  a manually-added company was saved (AddCompanyModal) -- no separate "Research Company"
 *  button exists anywhere in the app. Only rendered for manually-added companies: every
 *  ETL-sourced company was already researched by construction (the gold sheet itself). */
function ResearchStatusBanner({ companyId }: { companyId: string }) {
  const { getField } = useEditor();
  const field = getField(companyId, 'research.company', null, 'Not yet researched');
  const result = field.currentValue as ResearchResult | null;
  if (!result) return null;
  const meta = RESEARCH_STATUS_META[result.status];
  return (
    <div className="border rounded-md p-2.5 text-xs space-y-1" style={{ borderColor: meta.color }}>
      <p className="font-medium" style={{ color: meta.color }}>
        {meta.icon} Research Status: {meta.label}
      </p>
      <p className="text-[var(--text-dim)]">{result.message}</p>
    </div>
  );
}

function stageLabel(n: number | null): string {
  if (n === null) return 'Active through Stage 5 (on the final watchlist)';
  const names: Record<number, string> = { 2: 'Stage 2 (Fintech)', 3: 'Stage 3 (Series A check)', 4: 'Stage 4 (Geography)', 5: 'Stage 5 (Syndicate)' };
  return `Cut at ${names[n] ?? `Stage ${n}`}`;
}

/** Persistent comparison of what the automated pipeline alone would say vs. the company's
 *  current state with all active investor edits applied -- satisfies "clearly tell the user
 *  when a manual change has caused a company to enter/leave a stage or watchlist." */
function FunnelImpactBanner({ raw, resolved, fundIndex, metricsIndex }: { raw: Company; resolved: Company; fundIndex: Map<string, Fund>; metricsIndex?: MetricsIndex }) {
  // The baseline must be computed with the SAME deal metrics as the current state, so the
  // only difference being compared is the user's edits. Omitting metricsIndex here made every
  // company whose score shifted under the new scoring framework look as though the user had
  // edited it.
  const original = resolveCompany(raw, {}, fundIndex, metricsIndex);
  const originalLabel = stageLabel(original.cutStage ?? (!original.stage5.pass && passedContentGates(original) ? 5 : null));
  const currentLabel = stageLabel(resolved.cutStage ?? (!resolved.stage5.pass && passedContentGates(resolved) ? 5 : null));
  const changed = originalLabel !== currentLabel;

  if (!changed) {
    return (
      <p className="text-[11px] text-[var(--text-dim)]">
        Original automated eligibility matches current: <span className="text-[var(--text-h)]">{currentLabel}</span>
      </p>
    );
  }

  return (
    <div className="border rounded-md p-2.5 text-xs space-y-1" style={{ borderColor: 'var(--accent-ink)', background: 'var(--accent-dim)' }}>
      <p className="font-medium text-[var(--text-h)]">Your edits moved this company's funnel eligibility</p>
      <p>
        <span className="text-[var(--text-dim)]">Original automated status: </span>
        {originalLabel}
      </p>
      <p>
        <span className="text-[var(--text-dim)]">Current status (with your edits): </span>
        <span style={{ color: 'var(--accent-ink)' }} className="font-medium">
          {currentLabel}
        </span>
      </p>
      <p className="text-[var(--text-dim)]">See Change History below for the specific edits driving this.</p>
    </div>
  );
}

export function CompanyDrawer({
  company,
  raw,
  fundIndex,
  metricsIndex,
  onClose,
}: {
  /** Resolved company -- original data merged with any active investor edits. */
  company: Company;
  /** Untouched original company straight from the ETL output, used to show "Automated" baselines. */
  raw: Company;
  fundIndex: Map<string, Fund>;
  metricsIndex?: MetricsIndex;
  onClose: () => void;
}) {
  const { edits } = useEditor();
  const autoGate = computeSyndicateGate(company, fundIndex, metricsIndex);

  return (
    <div className="fixed inset-0 bg-black/60 flex justify-end z-50" onClick={onClose}>
      <div
        className="w-full max-w-2xl h-full bg-[var(--bg-panel)] border-l border-[var(--border)] overflow-y-auto p-6 space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold text-[var(--text-h)]">{company.name}</h2>
            <p className="text-sm text-[var(--text-dim)]">
              {company.country} · {company.sector} · {company.latestRoundType} · {company.status}
              {company.website && (
                <>
                  {' · '}
                  <a href={company.website} target="_blank" rel="noreferrer" className="text-[var(--accent-ink)]">
                    {company.website}
                  </a>
                </>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text-h)] text-lg leading-none">
            ✕
          </button>
        </div>

        <p className="text-sm text-[var(--text)]">{company.description}</p>

        {raw.isManuallyAdded && <ResearchStatusBanner companyId={company.id} />}

        {/* ---- COMPANY OVERVIEW ---- */}
        <section>
          <h3 className="text-sm font-semibold text-[var(--text-h)] mb-2">Company Overview</h3>
          <div className="space-y-2">
            {FIELD_REGISTRY.filter((f) => f.section === 'Profile' || f.section === 'Classification' || f.section === 'Investors').map((f) => (
              <EditableField key={f.path} raw={raw} def={f} />
            ))}
          </div>
        </section>

        {/* ---- ROUNDS ON RECORD ---- */}
        <RoundsSection raw={raw} edits={edits} fundIndex={fundIndex} />

        {/* ---- INVESTOR SYNDICATE ---- */}
        <InvestorSyndicateSection company={company} raw={raw} fundIndex={fundIndex} metricsIndex={metricsIndex} />

        {/* ---- QUONA FUNNEL ---- */}
        <section>
          <h3 className="text-sm font-semibold text-[var(--text-h)] mb-2">Quona Funnel</h3>
          <div className="mb-2">
            <FunnelImpactBanner raw={raw} resolved={company} fundIndex={fundIndex} metricsIndex={metricsIndex} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs mb-3">
            {[
              ['Stage 2 · Fintech', company.stage2],
              ['Stage 3 · No Series A', company.stage3],
              ['Stage 4 · Geography', company.stage4],
            ].map(([label, res]: any) => (
              <div key={label} className="border border-[var(--border)] rounded p-2">
                <div className="font-medium text-[var(--text-h)]">{label}</div>
                <div style={{ color: res.pass ? 'var(--strong)' : 'var(--weak)' }}>{res.pass ? 'Pass' : 'Fail'}</div>
                <div className="text-[var(--text-dim)] mt-1">{res.reason}</div>
              </div>
            ))}
            <div className="border border-[var(--border)] rounded p-2">
              <div className="font-medium text-[var(--text-h)]">Stage 5 · Syndicate (binary)</div>
              <div style={{ color: company.stage5.pass ? 'var(--strong)' : 'var(--weak)' }}>{company.stage5.pass ? 'Pass' : 'Fail'}</div>
              <div className="text-[var(--text-dim)] mt-1">{company.stage5.reason}</div>
            </div>
          </div>

          <h4 className="text-xs font-semibold text-[var(--text-h)] mb-2">Investor Classifications (override where already supported)</h4>
          <div className="space-y-2">
            {CLASSIFICATION_REGISTRY.map((def) =>
              def.path === 'classifications.strongSyndicate' ? (
                <ClassificationField
                  key={def.path}
                  raw={raw}
                  def={def}
                  liveAutomatedValue={autoGate.pass}
                  liveAutomatedSource={
                    autoGate.pass ? `Automated: qualifying anchor ${autoGate.qualifyingInvestor}` : 'Automated: no investor met the binary rubric'
                  }
                />
              ) : (
                <ClassificationField key={def.path} raw={raw} def={def} />
              )
            )}
          </div>
        </section>

        {/* ---- NEWS & INTELLIGENCE (weekly web scan) ---- */}
        <CompanyNewsSection companyId={company.id} />

        {/* ---- TRACTION (investor-supplied evidence, read by the AI agent) ---- */}
        <TractionSection companyId={company.id} companyName={company.name} />

        <CommentaryPanel companyId={company.id} />

        <ChangeHistoryPanel company={company} fundIndex={fundIndex} />
      </div>
    </div>
  );
}
