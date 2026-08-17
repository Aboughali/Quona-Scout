import type { Company, Fund } from '../types';
import { useEditor } from '../context/EditorContext';
import { computeSyndicateGate, scoreCompanySyndicate, passedContentGates, type MetricsIndex } from '../lib/funnel';
import { CLASSIFICATION_REGISTRY, FIELD_REGISTRY } from '../lib/fields';
import { ClassificationField } from './ClassificationField';
import { EditableField } from './EditableField';

const FINTECH_DEF = CLASSIFICATION_REGISTRY.find((d) => d.path === 'classifications.fintech')!;
const MULTI_MARKET_DEF = CLASSIFICATION_REGISTRY.find((d) => d.path === 'classifications.multiMarket')!;
const SYNDICATE_DEF = CLASSIFICATION_REGISTRY.find((d) => d.path === 'classifications.strongSyndicate')!;
const FOUNDING_YEAR_DEF = FIELD_REGISTRY.find((d) => d.path === 'foundingYear')!;
const FOUNDERS_DEF = FIELD_REGISTRY.find((d) => d.path === 'founders')!;

const NO_REAL_INVESTOR = new Set(['n.a.', 'n.a', 'angel investors', 'angel investor', '']);

function hasNoNamedInvestor(company: Company): boolean {
  const real = company.investors.filter((i) => !NO_REAL_INVESTOR.has(i.trim().toLowerCase()));
  return real.length === 0;
}

function ReviewSection({ title, note, count, children }: { title: string; note?: string; count: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-h)]">
          {title} <span className="text-[var(--text-dim)] font-normal">({count})</span>
        </h3>
      </div>
      {note && <p className="text-xs text-[var(--text-dim)]">{note}</p>}
      {count === 0 ? <p className="text-xs text-[var(--text-dim)]">Nothing to review.</p> : <div className="space-y-2">{children}</div>}
    </section>
  );
}

export function ReviewQueue({
  companies,
  rawById,
  fundIndex,
  metricsIndex,
  onSelect,
}: {
  companies: Company[];
  rawById: Map<string, Company>;
  fundIndex: Map<string, Fund>;
  metricsIndex?: MetricsIndex;
  onSelect: (c: Company) => void;
}) {
  const { edits } = useEditor();

  const lowConfidence = companies.filter((c) => passedContentGates(c) && c.sourceConfidence !== 'High');

  const fintechPivots = companies.filter((c) => c.stage2.adjacentCandidate && !edits[c.id]?.['classifications.fintech']?.isOverridden);

  const geoAmbiguous = companies.filter(
    (c) => c.stage4.multiMarketSignal && !c.stage4.autoPass && !edits[c.id]?.['classifications.multiMarket']?.isOverridden
  );

  const missingData = companies.filter((c) => passedContentGates(c) && (c.founders.length === 0 || !c.foundingYear));

  const investorAmbiguous = companies.filter((c) => passedContentGates(c) && hasNoNamedInvestor(c));

  const borderlineSyndicate = companies.filter((c) => {
    if (!passedContentGates(c)) return false;
    if (edits[c.id]?.['classifications.strongSyndicate']?.isOverridden) return false;
    const best = scoreCompanySyndicate(c, fundIndex, metricsIndex);
    return best !== null && best.score >= 55 && best.score < 70;
  });

  const noProfileInvestors = companies.filter((c) => {
    if (!passedContentGates(c)) return false;
    const gate = computeSyndicateGate(c, fundIndex, metricsIndex);
    return !gate.pass && c.investors.some((i) => !gate.perInvestor.find((p) => p.investor === i)?.hasFundProfile);
  });

  return (
    <div className="space-y-8">
      <p className="text-xs text-[var(--text-dim)]">
        Surfaces ambiguous, low-confidence, or unresolved signals across the funnel. Resolve directly here — every
        change is captured with a reason and source, same as editing from a company profile.
      </p>

      <ReviewSection title="Low-confidence data" count={lowConfidence.length} note="Undisclosed amounts or single-source records on active companies.">
        {lowConfidence.slice(0, 12).map((c) => {
          return (
            <div key={c.id} className="border border-[var(--border)] rounded-md p-2.5 flex items-center justify-between gap-3">
              <div>
                <button onClick={() => onSelect(c)} className="text-sm font-medium text-[var(--text-h)] hover:text-[var(--accent-ink)]">
                  {c.name}
                </button>
                <span className="text-xs text-[var(--text-dim)] ml-2">confidence: {c.sourceConfidence}</span>
              </div>
              <button onClick={() => onSelect(c)} className="text-xs text-[var(--accent-ink)] whitespace-nowrap">
                Open profile to add a source →
              </button>
            </div>
          );
        })}
        {moreNotice(lowConfidence.length)}
      </ReviewSection>

      <ReviewSection title="Possible fintech pivots" count={fintechPivots.length} note="Sector isn't Fintech but the description matches fintech-adjacent keywords.">
        {fintechPivots.slice(0, 8).map((c) => (
          <div key={c.id} className="border border-[var(--border)] rounded-md p-2.5 space-y-2">
            <button onClick={() => onSelect(c)} className="text-sm font-medium text-[var(--text-h)] hover:text-[var(--accent-ink)]">
              {c.name}
            </button>
            <p className="text-xs text-[var(--text-dim)]">{c.description}</p>
            <ClassificationField raw={rawById.get(c.id) ?? c} def={FINTECH_DEF} />
          </div>
        ))}
      </ReviewSection>

      <ReviewSection title="Geography ambiguity" count={geoAmbiguous.length} note="Description hints at multi-market operations, outside Egypt/South Africa.">
        {geoAmbiguous.slice(0, 8).map((c) => (
          <div key={c.id} className="border border-[var(--border)] rounded-md p-2.5 space-y-2">
            <button onClick={() => onSelect(c)} className="text-sm font-medium text-[var(--text-h)] hover:text-[var(--accent-ink)]">
              {c.name} <span className="text-[var(--text-dim)] font-normal">— {c.country}</span>
            </button>
            <p className="text-xs text-[var(--text-dim)]">{c.description}</p>
            <ClassificationField raw={rawById.get(c.id) ?? c} def={MULTI_MARKET_DEF} />
          </div>
        ))}
      </ReviewSection>

      <ReviewSection title="Missing data" count={missingData.length} note="Active companies with no founder name or founding year on record.">
        {missingData.slice(0, 8).map((c) => (
          <div key={c.id} className="border border-[var(--border)] rounded-md p-2.5 space-y-2">
            <button onClick={() => onSelect(c)} className="text-sm font-medium text-[var(--text-h)] hover:text-[var(--accent-ink)]">
              {c.name}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <EditableField raw={rawById.get(c.id) ?? c} def={FOUNDERS_DEF} />
              <EditableField raw={rawById.get(c.id) ?? c} def={FOUNDING_YEAR_DEF} />
            </div>
          </div>
        ))}
      </ReviewSection>

      <ReviewSection title="Investor ambiguity" count={investorAmbiguous.length} note="No named fund or investor on record — only angels or undisclosed.">
        {investorAmbiguous.slice(0, 8).map((c) => (
          <div key={c.id} className="border border-[var(--border)] rounded-md p-2.5 space-y-2">
            <button onClick={() => onSelect(c)} className="text-sm font-medium text-[var(--text-h)] hover:text-[var(--accent-ink)]">
              {c.name}
            </button>
            <EditableField raw={rawById.get(c.id) ?? c} def={FIELD_REGISTRY.find((f) => f.path === 'investors')!} />
          </div>
        ))}
      </ReviewSection>

      <ReviewSection
        title="Syndicate scores near the Strong/Moderate boundary"
        count={borderlineSyndicate.length}
        note="0-100 score between 55-69 — AI classification that likely needs human confirmation before anchoring a conviction call."
      >
        {borderlineSyndicate.slice(0, 8).map((c) => {
          const gate = computeSyndicateGate(c, fundIndex, metricsIndex);
          return (
            <div key={c.id} className="border border-[var(--border)] rounded-md p-2.5 space-y-2">
              <button onClick={() => onSelect(c)} className="text-sm font-medium text-[var(--text-h)] hover:text-[var(--accent-ink)]">
                {c.name}
              </button>
              <ClassificationField
                raw={rawById.get(c.id) ?? c}
                def={SYNDICATE_DEF}
                liveAutomatedValue={gate.pass}
                liveAutomatedSource={gate.pass ? `Automated: qualifying anchor ${gate.qualifyingInvestor}` : 'Automated: no investor met the binary rubric'}
              />
            </div>
          );
        })}
      </ReviewSection>

      <ReviewSection
        title="Investors without a researched fund profile"
        count={noProfileInvestors.length}
        note="Companies through Stage 4 whose Stage 5 syndicate gate failed at least partly because a named investor has no fund profile yet — research the fund, or override the syndicate judgment directly if you know it's strong."
      >
        {noProfileInvestors.slice(0, 8).map((c) => {
          const gate = computeSyndicateGate(c, fundIndex, metricsIndex);
          const unresearched = c.investors.filter((i) => !gate.perInvestor.find((p) => p.investor === i)?.hasFundProfile);
          return (
            <div key={c.id} className="border border-[var(--border)] rounded-md p-2.5 space-y-1">
              <button onClick={() => onSelect(c)} className="text-sm font-medium text-[var(--text-h)] hover:text-[var(--accent-ink)]">
                {c.name}
              </button>
              <p className="text-xs text-[var(--text-dim)]">Unresearched: {unresearched.join(', ')}</p>
            </div>
          );
        })}
      </ReviewSection>

      <ReviewSection
        title="New funding announcements"
        count={0}
        note="Not available without a live data feed — this build runs against a point-in-time gold sheet export. Re-run the ETL pipeline against a refreshed export to surface new rounds."
      >
        {null}
      </ReviewSection>
    </div>
  );
}

function moreNotice(total: number) {
  return total > 12 ? <p className="text-xs text-[var(--text-dim)]">+{total - 12} more — refine with search on the main funnel view.</p> : null;
}
