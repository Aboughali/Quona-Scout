import type { Company, Fund } from '../types';
import { effectiveCutStage, scoreCompanySyndicate, computeSyndicateGate, SYNDICATE_STAGE, type MetricsIndex } from '../lib/funnel';
import { TIER_COLOR } from '../lib/colors';
import { EditableCell } from './EditableCell';
import { CLASSIFICATION_REGISTRY, FIELD_REGISTRY } from '../lib/fields';

const FINTECH_DEF = CLASSIFICATION_REGISTRY.find((d) => d.path === 'classifications.fintech')!;
const MULTI_MARKET_DEF = CLASSIFICATION_REGISTRY.find((d) => d.path === 'classifications.multiMarket')!;
const SYNDICATE_DEF = CLASSIFICATION_REGISTRY.find((d) => d.path === 'classifications.strongSyndicate')!;
const STATUS_DEF = FIELD_REGISTRY.find((d) => d.path === 'status')!;

export function CompanyTable({
  companies,
  rawById,
  stageN,
  fundIndex,
  metricsIndex,
  showCut,
  onSelect,
}: {
  companies: Company[];
  rawById: Map<string, Company>;
  stageN: number;
  fundIndex: Map<string, Fund>;
  metricsIndex?: MetricsIndex;
  showCut: boolean;
  onSelect: (c: Company) => void;
}) {
  const rows = companies
    .map((c) => ({ c, cut: effectiveCutStage(c) }))
    .filter(({ cut }) => showCut || cut.stage === null || cut.stage > stageN);

  return (
    <div className="q-card overflow-visible">
      <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[var(--bg-soft)] text-left text-[var(--text-dim)] text-[10px] uppercase tracking-[0.08em]">
            <th className="px-3 py-2.5 font-bold">Company</th>
            <th className="px-3 py-2.5 font-bold">Country</th>
            <th className="px-3 py-2.5 font-bold">Fintech</th>
            <th className="px-3 py-2.5 font-bold">Latest Round</th>
            <th className="px-3 py-2.5 font-bold">Geography</th>
            <th className="px-3 py-2.5 font-bold">Investors</th>
            <th className="px-3 py-2.5 font-bold">Status</th>
            {stageN >= SYNDICATE_STAGE && <th className="px-3 py-2.5 font-bold">Syndicate</th>}
            <th className="px-3 py-2.5 font-bold">Funnel</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, cut }) => {
            const isCutByHere = cut.stage !== null && cut.stage <= stageN;
            const best = stageN >= SYNDICATE_STAGE ? scoreCompanySyndicate(c, fundIndex, metricsIndex) : null;
            const raw = rawById.get(c.id) ?? c;
            const autoGate = computeSyndicateGate(c, fundIndex, metricsIndex);
            return (
              <tr
                key={c.id}
                className={`border-t border-[var(--border)] cursor-pointer hover:bg-[var(--accent-dim)] ${isCutByHere ? 'opacity-45' : ''}`}
              >
                <td className="px-3 py-2 font-medium text-[var(--text-h)] whitespace-nowrap cursor-pointer" onClick={() => onSelect(c)}>
                  {c.name}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{c.country}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <EditableCell
                    raw={raw}
                    classificationDef={FINTECH_DEF}
                    display={
                      <span style={{ color: c.stage2.pass ? 'var(--strong)' : 'var(--weak)' }}>{c.stage2.pass ? 'Yes' : 'No'}</span>
                    }
                  />
                </td>
                <td className="px-3 py-2 whitespace-nowrap cursor-pointer" onClick={() => onSelect(c)} title="Click to view/edit rounds on record">
                  {c.latestRoundType ?? '—'}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <EditableCell
                    raw={raw}
                    classificationDef={MULTI_MARKET_DEF}
                    display={
                      <span style={{ color: c.stage4.pass ? 'var(--strong)' : 'var(--weak)' }}>
                        {c.stage4.autoPass ? c.country : c.stage4.pass ? '3+ Africa' : 'No'}
                      </span>
                    }
                  />
                </td>
                <td className="px-3 py-2 max-w-[220px] truncate" title={c.investors.join(', ')}>
                  {c.investors.join(', ')}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <EditableCell raw={raw} fieldDef={STATUS_DEF} display={<span>{c.status}</span>} />
                </td>
                {stageN >= SYNDICATE_STAGE && (
                  <td className="px-3 py-2 whitespace-nowrap">
                    <EditableCell
                      raw={raw}
                      classificationDef={SYNDICATE_DEF}
                      liveAutomatedValue={autoGate.pass}
                      liveAutomatedSource={autoGate.pass ? `Automated: qualifying anchor ${autoGate.qualifyingInvestor}` : 'Automated: no investor met the binary rubric'}
                      display={
                        best ? (
                          <span
                            className="text-xs px-2 py-0.5 rounded-full border"
                            style={{ color: TIER_COLOR[best.tier], borderColor: TIER_COLOR[best.tier] }}
                          >
                            {best.score.toFixed(0)} · {best.tier} · {best.completeness}
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full border" style={{ color: TIER_COLOR.Unscored, borderColor: TIER_COLOR.Unscored }}>
                            {c.stage5.pass ? 'Overridden — Yes' : 'Unscored'}
                          </span>
                        )
                      }
                    />
                  </td>
                )}
                <td className="px-3 py-2 whitespace-nowrap text-xs cursor-pointer" onClick={() => onSelect(c)}>
                  {isCutByHere ? (
                    <span title={cut.reason ?? ''} style={{ color: 'var(--weak)' }}>
                      Cut · Stage {cut.stage}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--strong)' }}>Active</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {rows.length === 0 && <div className="p-6 text-center text-[var(--text-dim)]">No companies to show.</div>}
    </div>
  );
}
