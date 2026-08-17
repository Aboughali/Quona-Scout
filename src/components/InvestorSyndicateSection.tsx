import { useState } from 'react';
import type { Company, EditConfidence, Fund } from '../types';
import { useEditor } from '../context/EditorContext';
import { normalizeInvestorName } from '../lib/funnel';
import { scoreFundForCompany, DIMENSION_META, type DimensionKey, type FundCompanyScore } from '../lib/scoring';
import type { MetricsIndex } from '../lib/funnel';
import type { LiveInvestorMetrics } from '../lib/investorMetrics';
import { fundEntityId, getFundFieldDefault, FUND_META_REGISTRY, FUND_TYPE_OPTIONS } from '../lib/funds';
import { resolveRounds, splitCurrentVsHistoricalInvestors } from '../lib/rounds';
import { TIER_COLOR } from '../lib/colors';
import type { ResearchResult } from '../lib/research';
import rawFundsData from '../data/funds.json';

const RESEARCH_STATUS_META: Record<ResearchResult['status'], { icon: string; label: string; color: string }> = {
  researching: { icon: '🔄', label: 'Researching…', color: 'var(--text-dim)' },
  complete: { icon: '✓', label: 'Scored', color: 'var(--strong)' },
  'insufficient-evidence': { icon: '⚠', label: 'Insufficient Evidence', color: 'var(--moderate)' },
  error: { icon: '⚠', label: 'Research error', color: 'var(--weak)' },
};

// True static/original funds, untouched by any edit -- distinct from the RESOLVED fundIndex
// (which bakes overrides directly into fund.dimensions). DimensionEditor/FundMetaEditor need
// this to show a correct "Automated" baseline; using the resolved fund there would make an
// override look like it was always the researched value, the same bug class raw vs. resolved
// company guards against.
const RAW_FUNDS = rawFundsData as unknown as Fund[];
const RAW_FUND_BY_NORMALIZED = new Map(RAW_FUNDS.map((f) => [normalizeInvestorName(f.name), f]));

const ROLE_OPTIONS = ['Lead', 'Co-investor', 'Other', 'Unknown'];
const TIER_OPTIONS = ['Strong', 'Moderate', 'Weak'];

/** Shows the score exactly as the source states it -- an Excel score of 89.06 must not be
 *  rounded to 89, since the user validates against the workbook figure. */
function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

/** Names where the displayed fund-level score came from, so an Excel score from the analyst's
 *  own workbook is never presented as an AI/research-derived one (or vice versa). */
function OriginBadge({ score, dimensionOverrides }: { score: FundCompanyScore; dimensionOverrides: number }) {
  const meta: Record<string, { label: string; color: string; title: string }> = {
    'manual-override': {
      label: 'Manual Override',
      color: 'var(--accent-ink)',
      title: 'You set this fund-level score by hand. It outranks the Excel workbook and every computed value, and survives imports, refreshes and rebuilds.',
    },
    'excel-workbook': {
      label: 'Excel Score',
      color: 'var(--strong)',
      title: 'Fund-level score taken verbatim from your investor scoring workbook (FUND-LEVEL SCORE column). Not recalculated by the app.',
    },
    'research-derived': {
      label: 'AI / Research-Derived',
      color: 'var(--moderate)',
      title: 'This investor is not in your scoring workbook, so the score was calculated from deal data under the Quona methodology.',
    },
    unscored: {
      label: 'Unscored',
      color: 'var(--text-dim)',
      title: 'Insufficient verified public evidence found.',
    },
  };
  const m = meta[score.origin];
  const drift =
    score.origin === 'excel-workbook' && score.excelRecomputed != null && score.excelScore != null &&
    Math.abs(score.excelRecomputed - score.excelScore) > 0.01;
  return (
    <span className="flex items-center gap-1">
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide font-medium"
        style={{ color: m.color, borderColor: m.color }}
        title={m.title}
      >
        {m.label}
      </span>
      {dimensionOverrides > 0 && score.origin !== 'manual-override' && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide font-medium"
          style={{ color: 'var(--accent-ink)', borderColor: 'var(--accent-ink)', background: 'var(--accent-dim)' }}
          title={`${dimensionOverrides} individual dimension(s) carry a manual override.`}
        >
          {dimensionOverrides} dim override{dimensionOverrides === 1 ? '' : 's'}
        </span>
      )}
      {drift && (
        <span
          className="text-[10px]"
          style={{ color: 'var(--moderate)' }}
          title={`Your workbook's cached score is ${score.excelScore}, but its own SUMPRODUCT formula applied to its current ratings gives ${score.excelRecomputed}. The cached value is being used, as instructed.`}
        >
          ⚠
        </span>
      )}
    </span>
  );
}

/** Manual override of the whole fund-level score, with an explicit Reset to Automated.
 *  Stored in the persisted edit store (localStorage), NOT in any imported data file, which is
 *  what makes it survive Excel re-imports, scoring refreshes, rebuilds and redeploys: nothing
 *  in the import pipeline can reach it. Both the automated value and the override are kept. */
function FundScoreOverride({ fundName, score }: { fundName: string; score: FundCompanyScore }) {
  const { getField, overrideField, revertFieldValue, userName } = useEditor();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');

  const entity = fundEntityId(fundName);
  // The automated baseline is the Excel score where one exists, else the computed score.
  const automated = score.excelScore ?? score.computedScore;
  const automatedSource = score.excelScore != null ? 'Investor scoring workbook (Excel)' : 'Computed from deal data';
  const field = getField(entity, 'fundLevelScore', automated, automatedSource);
  const isOverridden = field.isOverridden;
  const lastEntry = field.history.at(-1);

  function save() {
    const value = Number(draft);
    if (draft === '' || Number.isNaN(value) || value < 0 || value > 100 || !reason.trim()) return;
    overrideField(entity, 'fundLevelScore', automated, automatedSource, {
      newValue: value,
      reason: reason.trim(),
      source: `${userName} — manual score override`,
    });
    setEditing(false);
  }

  return (
    <div className="border border-[var(--border)] rounded p-2 space-y-1 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-medium text-[var(--text-h)]">Fund-level score</span>
        <span className="flex items-center gap-3">
          <span>
            <span className="text-[var(--text-dim)]">Automated: </span>
            <span className="text-[var(--text-h)]">{automated != null ? automated : '—'}</span>
            {score.excelScore != null && <span className="text-[var(--text-dim)]"> (Excel)</span>}
          </span>
          {isOverridden && (
            <span>
              <span className="text-[var(--text-dim)]">Manual override: </span>
              <span className="font-medium" style={{ color: 'var(--accent-ink)' }}>{String(field.currentValue)}</span>
            </span>
          )}
          <button onClick={() => { setDraft(String(field.currentValue ?? automated ?? '')); setReason(''); setEditing((e) => !e); }}
                  className="text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            {editing ? 'Close' : isOverridden ? 'Change' : 'Override score'}
          </button>
          {isOverridden && (
            <button
              onClick={() => revertFieldValue(entity, 'fundLevelScore', automated, automatedSource)}
              className="text-[var(--text-dim)] hover:text-[var(--strong)]"
              title="Discard the manual override and go back to the automated (Excel or computed) value."
            >
              Reset to Automated
            </button>
          )}
        </span>
      </div>
      {isOverridden && lastEntry && (
        <p className="text-[10px] text-[var(--text-dim)]">
          {lastEntry.reason} · {formatDate(lastEntry.timestamp)} · {lastEntry.user}
        </p>
      )}
      {editing && (
        <div className="space-y-1.5 border-t border-[var(--border)] pt-1.5">
          <input
            type="number" min={0} max={100} step="0.01"
            className="w-full bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
            placeholder="Score 0-100"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <textarea
            className="w-full bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
            rows={2}
            placeholder="Rationale (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button onClick={save} disabled={!draft.trim() || !reason.trim()}
                  className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40">
            Save override
          </button>
        </div>
      )}
    </div>
  );
}

function JudgmentBadge() {
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-full border uppercase tracking-wide font-medium"
      style={{ color: 'var(--accent-ink)', borderColor: 'var(--accent-ink)', background: 'var(--accent-dim)' }}
    >
      Investor Judgment
    </span>
  );
}

/** Rating editor for a single dimension of a single fund. Reuses the exact same field-edit
 *  primitives as everything else, just entity-scoped to `fund:<name>` instead of a company id
 *  -- per the syndicate spec, every dimension but Local Presence is fund-level and reused
 *  across companies, so an edit made here legitimately applies wherever this fund appears. */
function DimensionEditor({ fundName, staticFund, dimKey, label, tier, weight, companyCountry, liveMetrics }: {
  fundName: string;
  staticFund: Fund | undefined;
  dimKey: DimensionKey;
  label: string;
  tier: string;
  weight: number;
  companyCountry: string | null;
  liveMetrics?: LiveInvestorMetrics;
}) {
  const { getField, overrideField, revertFieldValue } = useEditor();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [confidence, setConfidence] = useState<EditConfidence>('Medium');

  const entity = fundEntityId(fundName);
  const def = getFundFieldDefault(staticFund, fundName, dimKey, companyCountry, liveMetrics);
  const field = getField(entity, dimKey, def.value, def.source);
  const current = field.currentValue as number | null;
  const lastEntry = field.history.at(-1);

  function openEditor() {
    setDraft(current ?? '');
    setReason('');
    setSource('');
    setEvidenceUrl('');
    setConfidence('Medium');
    setEditing(true);
  }

  function save() {
    if (draft === '' || !reason.trim() || !source.trim()) return;
    overrideField(entity, dimKey, def.value, def.source, {
      newValue: Number(draft),
      reason: reason.trim(),
      source: source.trim(),
      evidenceUrl: evidenceUrl.trim() || undefined,
      confidence,
    });
    setEditing(false);
  }

  function revert() {
    revertFieldValue(entity, dimKey, def.value, def.source);
    setEditing(false);
  }

  return (
    <div className="border border-[var(--border)] rounded p-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-h)]">
          {label} <span className="text-[var(--text-dim)] font-normal">({tier}, weight {weight})</span>
        </span>
        {field.isOverridden && <JudgmentBadge />}
      </div>
      <div className="flex items-center gap-4 text-xs">
        <div>
          <span className="text-[var(--text-dim)]">Automated: </span>
          <span className="text-[var(--text-h)]">{def.value != null ? `${def.value}/5` : 'Unscored'}</span>
        </div>
        {field.isOverridden && (
          <div>
            <span className="text-[var(--text-dim)]">Investor judgment: </span>
            <span className="text-[var(--accent-ink)] font-medium">{current}/5</span>
          </div>
        )}
      </div>
      {!editing ? (
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--text-dim)]">
            {field.isOverridden ? `${lastEntry?.reason} · ${lastEntry ? formatDate(lastEntry.timestamp) : ''}` : def.source}
          </span>
          <button onClick={openEditor} className="text-[11px] text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            Edit
          </button>
        </div>
      ) : (
        <div className="space-y-1.5 border-t border-[var(--border)] pt-1.5">
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                onClick={() => setDraft(n)}
                className="w-7 h-7 text-xs rounded border"
                style={
                  draft === n
                    ? { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)', background: 'var(--accent-dim)' }
                    : { borderColor: 'var(--border)', color: 'var(--text-dim)' }
                }
              >
                {n}
              </button>
            ))}
          </div>
          <textarea
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
            rows={2}
            placeholder="Reason / evidence for this rating (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-1.5">
            <input
              className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
              placeholder="Source (required)"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <select
              className="text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as EditConfidence)}
            >
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
          </div>
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
            placeholder="Evidence URL (optional)"
            value={evidenceUrl}
            onChange={(e) => setEvidenceUrl(e.target.value)}
          />
          <div className="flex gap-1.5">
            <button
              onClick={save}
              disabled={draft === '' || !reason.trim() || !source.trim()}
              className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40"
            >
              Save
            </button>
            {field.isOverridden && (
              <button onClick={revert} className="text-[11px] px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text)]">
                Revert
              </button>
            )}
            <button onClick={() => setEditing(false)} className="text-[11px] px-2.5 py-1 text-[var(--text-dim)]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TierOverride({ companyId, fundName, calculatedScore, calculatedTier }: {
  companyId: string;
  fundName: string;
  calculatedScore: number | null;
  calculatedTier: string;
}) {
  const { getField, overrideField, revertFieldValue } = useEditor();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('Strong');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');

  const path = `syndicateTierOverride.${normalizeInvestorName(fundName)}`;
  const field = getField(companyId, path, calculatedTier, `Calculated: ${calculatedScore ?? '—'} — ${calculatedTier}`);
  const current = field.currentValue as string;

  function save() {
    if (!reason.trim()) return;
    overrideField(companyId, path, calculatedTier, `Calculated: ${calculatedScore ?? '—'} — ${calculatedTier}`, {
      newValue: draft,
      reason: reason.trim(),
      source: source.trim() || 'Investor private knowledge',
    });
    setEditing(false);
  }

  return (
    <div className="text-xs">
      <div className="flex items-center gap-3">
        <span>
          <span className="text-[var(--text-dim)]">Calculated score: </span>
          <span className="text-[var(--text-h)] font-medium">{calculatedScore ?? '—'} — {calculatedTier}</span>
        </span>
        {field.isOverridden && (
          <span>
            <span className="text-[var(--text-dim)]">Active assessment: </span>
            <span className="text-[var(--accent-ink)] font-medium">{current}</span>
          </span>
        )}
        <button onClick={() => setEditing((e) => !e)} className="text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
          {editing ? 'Close' : field.isOverridden ? 'Change' : 'Override assessment'}
        </button>
      </div>
      {editing && (
        <div className="mt-1.5 space-y-1.5 border-t border-[var(--border)] pt-1.5">
          <p className="text-[10px] text-[var(--text-dim)]">
            The calculated score stays {calculatedScore ?? '—'} ({calculatedTier}) — this only overrides the active qualitative label,
            e.g. from private knowledge the number doesn't capture.
          </p>
          <div className="flex gap-1.5">
            {TIER_OPTIONS.map((t) => (
              <button
                key={t}
                onClick={() => setDraft(t)}
                className="text-[11px] px-2 py-1 rounded border"
                style={draft === t ? { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' } : { borderColor: 'var(--border)', color: 'var(--text-dim)' }}
              >
                {t}
              </button>
            ))}
          </div>
          <textarea
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
            rows={2}
            placeholder="Reason (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <input
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
            placeholder="Source (optional)"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <div className="flex gap-1.5">
            <button onClick={save} disabled={!reason.trim()} className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40">
              Save
            </button>
            {field.isOverridden && (
              <button
                onClick={() => { revertFieldValue(companyId, path, calculatedTier, `Calculated: ${calculatedScore ?? '—'} — ${calculatedTier}`); setEditing(false); }}
                className="text-[11px] px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text)]"
              >
                Revert
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function InvestorRow({ company, investorName, fundIndex, metricsIndex }: { company: Company; investorName: string; fundIndex: Map<string, Fund>; metricsIndex?: MetricsIndex }) {
  const { getField, overrideField, userName } = useEditor();
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeReason, setRemoveReason] = useState('');

  const fund = fundIndex.get(normalizeInvestorName(investorName));
  const rawFund = RAW_FUND_BY_NORMALIZED.get(normalizeInvestorName(investorName));
  const liveMetrics = metricsIndex?.get(normalizeInvestorName(investorName));
  const score = fund ? scoreFundForCompany(fund, company.country, liveMetrics) : null;
  const overriddenCount = score ? score.dimensions.filter((d) => d.isOverride && d.rating != null).length : 0;

  const researchEntity = fundEntityId(investorName);
  const researchField = getField(researchEntity, 'research.investor', null, 'Not yet researched');
  const researchResult = researchField.currentValue as ResearchResult | null;

  const rolePath = `investorRole.${normalizeInvestorName(investorName)}`;
  const roleField = getField(company.id, rolePath, 'Unknown', 'Not yet recorded');
  const role = roleField.currentValue as string;

  function setRole(newRole: string) {
    overrideField(company.id, rolePath, 'Unknown', 'Not yet recorded', {
      newValue: newRole,
      reason: `Role set to ${newRole}`,
      source: `${userName} — direct knowledge`,
    });
  }

  function removeInvestor() {
    if (!removeReason.trim()) return;
    const nextInvestors = company.investors.filter((i) => i !== investorName);
    overrideField(company.id, 'investors', company.investors, 'Gold sheet — Africa: The Big Deal / deep research export', {
      newValue: nextInvestors,
      reason: removeReason.trim(),
      source: `${userName} — manual removal`,
    });
    setRemoving(false);
  }

  return (
    <div className="border border-[var(--border)] rounded-md p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-h)]">{investorName}</span>
          {fund?.investorCreated && <span className="text-[10px] text-[var(--strong)]">investor-created</span>}
          {researchResult && (
            <span className="text-[10px]" style={{ color: RESEARCH_STATUS_META[researchResult.status].color }} title={researchResult.message}>
              {RESEARCH_STATUS_META[researchResult.status].icon} {RESEARCH_STATUS_META[researchResult.status].label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1 text-[var(--text)]"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {score && (
            <span className="text-xs px-2 py-0.5 rounded-full border" style={{ color: TIER_COLOR[score.tier], borderColor: TIER_COLOR[score.tier] }}>
              {score.score != null ? `${formatScore(score.score)} · ${score.tier}` : 'Unscored'} ({score.completeness})
            </span>
          )}
          {score && <OriginBadge score={score} dimensionOverrides={overriddenCount} />}
          <button onClick={() => setExpanded((e) => !e)} className="text-xs text-[var(--text-dim)] hover:text-[var(--accent-ink)]">
            {expanded ? 'Hide details' : 'Details'}
          </button>
          <button onClick={() => setRemoving((r) => !r)} className="text-xs text-[var(--text-dim)] hover:text-[var(--weak)]">
            Remove
          </button>
        </div>
      </div>

      {removing && (
        <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
          <textarea
            className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1.5 text-[var(--text)]"
            rows={2}
            placeholder="Reason for removing this investor (required)"
            value={removeReason}
            onChange={(e) => setRemoveReason(e.target.value)}
          />
          <div className="flex gap-1.5">
            <button
              onClick={removeInvestor}
              disabled={!removeReason.trim()}
              className="text-[11px] px-2.5 py-1 rounded-md text-white bg-[var(--weak)] font-medium disabled:opacity-40"
            >
              Confirm remove
            </button>
            <button onClick={() => setRemoving(false)} className="text-[11px] px-2.5 py-1 text-[var(--text-dim)]">
              Cancel
            </button>
          </div>
        </div>
      )}

      {expanded && fund && (
        <div className="space-y-2 border-t border-[var(--border)] pt-2">
          {score && <FundScoreOverride fundName={investorName} score={score} />}
          <TierOverride companyId={company.id} fundName={investorName} calculatedScore={score?.score ?? null} calculatedTier={score?.tier ?? 'Unscored'} />

          {/* Country-specific relevance is deliberately shown separately from the fund-level
              framework score: the score answers "how good is this investor", this answers
              "how relevant are they to THIS company's market", and the app derives it itself. */}
          {score && (
            <div className="border border-[var(--border)] rounded p-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-h)]">
                  Country relevance{company.country ? ` — ${company.country}` : ''}
                </span>
                <span className="text-xs text-[var(--text-h)]">
                  {score.countryRelevance.rating != null ? `${score.countryRelevance.rating}/5` : 'Not assessable'}
                </span>
              </div>
              <p className="text-[10px] text-[var(--text-dim)]">{score.countryRelevance.explanation}</p>
              {score.countryRelevance.evidence.map((line, i) => (
                <p key={i} className="text-[10px] text-[var(--text-dim)]">• {line}</p>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            {DIMENSION_META.map((d) => (
              <DimensionEditor key={d.key} fundName={investorName} staticFund={rawFund} dimKey={d.key} label={d.label} tier={d.tier} weight={d.weight} companyCountry={company.country} liveMetrics={liveMetrics} />
            ))}
          </div>
          <FundMetaEditor fundName={investorName} staticFund={rawFund} />
        </div>
      )}
    </div>
  );
}

function FundMetaEditor({ fundName, staticFund }: { fundName: string; staticFund: Fund | undefined }) {
  const { getField, overrideField } = useEditor();
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const entity = fundEntityId(fundName);

  return (
    <div className="border border-[var(--border)] rounded p-2 space-y-1.5">
      <p className="text-[10px] text-[var(--text-dim)] uppercase">Fund details (applies wherever this fund appears)</p>
      {FUND_META_REGISTRY.map((m) => {
        const def = getFundFieldDefault(staticFund, fundName, m.path);
        const field = getField(entity, m.path, def.value, def.source);
        const display = Array.isArray(field.currentValue) ? field.currentValue.join(', ') : field.currentValue ?? '—';
        return (
          <div key={m.path} className="flex items-center justify-between text-xs gap-2">
            <span className="text-[var(--text-dim)] shrink-0">{m.label}:</span>
            {editingPath === m.path ? (
              <div className="flex-1 flex gap-1">
                {m.type === 'select' ? (
                  <select className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1" value={draft} onChange={(e) => setDraft(e.target.value)}>
                    <option value="">—</option>
                    {m.options?.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="flex-1 text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-1" value={draft} onChange={(e) => setDraft(e.target.value)} />
                )}
                <button
                  onClick={() => {
                    const newValue = m.type === 'list' ? draft.split(',').map((s) => s.trim()).filter(Boolean) : m.type === 'number' ? (draft ? Number(draft) : null) : draft || null;
                    overrideField(entity, m.path, def.value, def.source, { newValue, reason: reason || 'Updated by investor', source: source || 'Investor-provided' });
                    setEditingPath(null);
                  }}
                  className="text-[11px] px-2 rounded bg-[var(--accent)] text-[#0b0c10]"
                >
                  ✓
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setEditingPath(m.path);
                  setDraft(Array.isArray(field.currentValue) ? field.currentValue.join(', ') : String(field.currentValue ?? ''));
                  setReason('');
                  setSource('');
                }}
                className="text-[var(--text-h)] hover:text-[var(--accent-ink)] text-right"
              >
                {String(display)}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AddInvestorForm({ company, fundIndex, onDone }: { company: Company; fundIndex: Map<string, Fund>; onDone: () => void }) {
  const { overrideField, userName } = useEditor();
  const [name, setName] = useState('');
  const [type, setType] = useState(FUND_TYPE_OPTIONS[0]);
  const [role, setRole] = useState('Co-investor');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [ratings, setRatings] = useState<Partial<Record<string, number>>>({});

  const alreadyExists = company.investors.some((i) => normalizeInvestorName(i) === normalizeInvestorName(name));
  const existingFund = name ? fundIndex.get(normalizeInvestorName(name)) : undefined;

  function submit() {
    if (!name.trim() || !source.trim() || alreadyExists) return;
    const entity = fundEntityId(name);

    overrideField(company.id, 'investors', company.investors, 'Gold sheet — Africa: The Big Deal / deep research export', {
      newValue: [...company.investors, name.trim()],
      reason: `Added investor: ${name.trim()}`,
      source: source.trim(),
    });
    overrideField(company.id, `investorRole.${normalizeInvestorName(name)}`, 'Unknown', 'Not yet recorded', {
      newValue: role,
      reason: `Role set at creation`,
      source: source.trim(),
    });

    if (!existingFund) {
      overrideField(entity, 'displayName', name.trim(), 'Investor-added', { newValue: name.trim(), reason: 'Fund created by investor', source: source.trim() });
      overrideField(entity, 'investorType', null, 'Investor-added', { newValue: type, reason: 'Fund created by investor', source: source.trim() });
      if (notes.trim()) {
        overrideField(entity, 'notes', '', 'Investor-added', { newValue: notes.trim(), reason: 'Fund created by investor', source: source.trim() });
      }
      for (const [key, rating] of Object.entries(ratings)) {
        if (rating == null) continue;
        overrideField(entity, key, null, 'Investor-added — no automated research behind this fund', {
          newValue: rating,
          reason: 'Scored at investor creation',
          source: source.trim(),
        });
      }
    }
    onDone();
  }

  return (
    <div className="border border-[var(--accent-ink)] rounded-md p-3 space-y-2">
      <p className="text-xs text-[var(--text-dim)]">New investor — added by {userName}</p>
      <input
        className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
        placeholder="Investor / fund name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {alreadyExists && <p className="text-[11px] text-[var(--weak)]">Already listed on this company.</p>}
      {existingFund && <p className="text-[11px] text-[var(--strong)]">Matches an existing researched fund — will reuse its profile.</p>}
      <div className="grid grid-cols-2 gap-2">
        <select className="text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]" value={type} onChange={(e) => setType(e.target.value)}>
          {FUND_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className="text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <input
        className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
        placeholder="Source (required)"
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />
      <textarea
        className="w-full text-xs bg-[var(--bg-panel-2)] border border-[var(--border)] rounded p-2 text-[var(--text)]"
        rows={2}
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {!existingFund && (
        <div>
          <p className="text-[10px] text-[var(--text-dim)] uppercase mb-1">Score across the 9 dimensions (optional, can do later)</p>
          <div className="grid grid-cols-2 gap-1.5">
            {DIMENSION_META.map((d) => (
              <div key={d.key} className="flex items-center justify-between text-[11px] border border-[var(--border)] rounded p-1.5">
                <span className="text-[var(--text-dim)]">{d.label}</span>
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => setRatings((r) => ({ ...r, [d.key]: r[d.key] === n ? undefined : n }))}
                      className="w-5 h-5 rounded border text-[10px]"
                      style={
                        ratings[d.key] === n
                          ? { borderColor: 'var(--accent-ink)', color: 'var(--accent-ink)' }
                          : { borderColor: 'var(--border)', color: 'var(--text-dim)' }
                      }
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={!name.trim() || !source.trim() || alreadyExists}
          className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-medium disabled:opacity-40"
        >
          Add investor
        </button>
        <button onClick={onDone} className="text-xs px-3 py-1.5 rounded-md text-[var(--text-dim)]">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function InvestorSyndicateSection({ company, raw, fundIndex, metricsIndex }: { company: Company; raw: Company; fundIndex: Map<string, Fund>; metricsIndex?: MetricsIndex }) {
  const [adding, setAdding] = useState(false);
  const { edits } = useEditor();

  const activeRounds = resolveRounds(raw, edits);
  const split = splitCurrentVsHistoricalInvestors(activeRounds);
  const currentSet = new Set(split.current);
  const historicalSet = new Set(split.historical);
  // Investors not tied to any round on record (e.g. manually added without a round link)
  // default into the current bucket -- they were added because they're relevant now.
  const currentInvestors = company.investors.filter((inv) => !historicalSet.has(inv) || currentSet.has(inv));
  const historicalInvestors = company.investors.filter((inv) => historicalSet.has(inv) && !currentSet.has(inv));

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--text-h)]">Investor Syndicate</h3>
        <button onClick={() => setAdding((a) => !a)} className="text-xs px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text)] hover:border-[var(--accent-ink)]">
          {adding ? 'Cancel' : '+ Add Investor'}
        </button>
      </div>
      {adding && <div className="mb-2"><AddInvestorForm company={company} fundIndex={fundIndex} onDone={() => setAdding(false)} /></div>}

      <h4 className="text-xs font-semibold text-[var(--text-dim)] uppercase tracking-wide mb-1.5">Current Round Syndicate</h4>
      <div className="space-y-2 mb-3">
        {currentInvestors.length === 0 && <p className="text-xs text-[var(--text-dim)]">No investors on the latest round.</p>}
        {currentInvestors.map((inv) => (
          <InvestorRow key={inv} company={company} investorName={inv} fundIndex={fundIndex} metricsIndex={metricsIndex} />
        ))}
      </div>

      {historicalInvestors.length > 0 && (
        <>
          <h4 className="text-xs font-semibold text-[var(--text-dim)] uppercase tracking-wide mb-1.5">
            Historical Investors <span className="normal-case font-normal">(earlier rounds only, not part of the current syndicate)</span>
          </h4>
          <div className="space-y-2 mb-3">
            {historicalInvestors.map((inv) => (
              <InvestorRow key={inv} company={company} investorName={inv} fundIndex={fundIndex} metricsIndex={metricsIndex} />
            ))}
          </div>
        </>
      )}

      {company.investors.length === 0 && <p className="text-xs text-[var(--text-dim)]">No investors on record.</p>}

      <p className="text-[10px] text-[var(--text-dim)] mt-2">
        Dimension and fund-detail edits apply to this fund wherever it appears (fund-level, per the scoring methodology). Role and
        the qualitative assessment override are specific to this company.
      </p>
    </section>
  );
}
