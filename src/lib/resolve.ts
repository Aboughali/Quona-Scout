import type { Company, CompanyFieldStates, FieldState, Fund } from '../types';
import type { EditsStore } from './editStore';
import { getFieldDefault } from './fields';
import { computeSyndicateGate, type MetricsIndex } from './funnel';
import { resolveRounds, summarizeRounds } from './rounds';

const GEO_AUTO_PASS_COUNTRIES = new Set(['Egypt', 'South Africa']);

function currentValueOf(edits: EditsStore, companyId: string, path: string, fallback: unknown): unknown {
  const field = edits[companyId]?.[path];
  return field ? field.currentValue : fallback;
}

/**
 * The evidence behind each funnel classification.
 *
 * Each of these classifications is already DERIVED from a field the investor can edit (see
 * getFieldDefault): fintech from Sector, multi-market from Operating countries, syndicate
 * strength from the investor list, Series A from the rounds on record. Editing the evidence is
 * therefore what makes a previously-recorded classification stale.
 *
 * `round:*` matches the per-round edit keys, since the round list is not a single field.
 */
const CLASSIFICATION_EVIDENCE: Record<string, string[]> = {
  'classifications.fintech': ['sector'],
  'classifications.hasSeriesA': ['round:*', 'status'],
  'classifications.multiMarket': ['operatingCountries'],
  'classifications.strongSyndicate': ['investors'],
};

/** Newest edit timestamp among a company's evidence fields for one classification. */
function evidenceTouchedAt(states: CompanyFieldStates | undefined, paths: string[]): number | null {
  if (!states || !paths.length) return null;
  const wantsRounds = paths.includes('round:*');
  let newest: number | null = null;
  for (const [path, state] of Object.entries(states)) {
    const matches = paths.includes(path) || (wantsRounds && path.startsWith('round:'));
    if (!matches) continue;
    for (const entry of state.history) {
      const t = Date.parse(entry.timestamp);
      if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
    }
  }
  return newest;
}

/** When the investor last asserted this classification by hand. */
function overriddenAt(state: FieldState | undefined): number | null {
  if (!state) return null;
  let newest: number | null = null;
  for (const entry of state.history) {
    if (entry.kind !== 'override') continue;
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

export interface ResolvedClassification {
  value: boolean;
  /** True when newer evidence has overtaken a hand-entered value. */
  superseded: boolean;
  /** The evidence field(s) that did the overtaking, for the explanation shown in the UI. */
  supersededBy: string[];
}

/**
 * Resolves one funnel classification, letting NEWER EVIDENCE WIN over an older manual override.
 *
 * The problem this solves: an investor who corrects Operating countries for a company had to
 * remember to go and flip the "3+ African markets?" answer by hand as well, because a stored
 * override shadowed the derivation forever. Now the funnel re-reads the evidence: change the
 * countries and Stage 4 follows on its own.
 *
 * The override is NOT deleted. It stays in the field's history and can be re-asserted at any
 * time -- re-asserting it makes it newer than the evidence again, so it wins again. This keeps
 * investor judgment sovereign while stopping it from silently going stale, and it means no
 * recorded decision is ever lost.
 */
export function resolveClassification(
  raw: Company,
  edits: EditsStore,
  path: string,
  derivedValue: boolean
): ResolvedClassification {
  const state = edits[raw.id]?.[path];
  if (!state) return { value: derivedValue, superseded: false, supersededBy: [] };
  if (!state.isOverridden) return { value: derivedValue, superseded: false, supersededBy: [] };

  const overrideAt = overriddenAt(state);
  const evidencePaths = CLASSIFICATION_EVIDENCE[path] ?? [];
  const evidenceAt = evidenceTouchedAt(edits[raw.id], evidencePaths);
  const stale = overrideAt !== null && evidenceAt !== null && evidenceAt > overrideAt;

  if (stale && derivedValue !== state.currentValue) {
    const touched = Object.keys(edits[raw.id] ?? {}).filter(
      (p) => evidencePaths.includes(p) || (evidencePaths.includes('round:*') && p.startsWith('round:'))
    );
    return { value: derivedValue, superseded: true, supersededBy: touched };
  }
  return { value: state.currentValue as boolean, superseded: false, supersededBy: [] };
}

/**
 * Merges the static (original/research) company with any active investor-judgment edits,
 * producing the object every screen (funnel counts, tables, drawer) actually reads.
 * The raw `companies.json` data is never mutated -- this runs fresh on every render.
 */
export function resolveCompany(raw: Company, edits: EditsStore, fundIndex: Map<string, Fund>, metricsIndex?: MetricsIndex): Company {
  const id = raw.id;
  const cv = (path: string) => currentValueOf(edits, id, path, getFieldDefault(raw, path, edits).value);

  const name = cv('name') as string;
  const website = cv('website') as string | null;
  const country = cv('country') as string | null;
  const city = cv('city') as string;
  const operatingCountries = cv('operatingCountries') as string[];
  const foundingYear = cv('foundingYear') as number | null;
  const founders = cv('founders') as string[];
  const founderInfo = cv('founderInfo') as string;
  const description = cv('description') as string;
  const sector = cv('sector') as string | null;
  const fintechSubSector = cv('fintechSubSector') as string;
  const businessModel = cv('businessModel') as string;
  const status = cv('status') as string;
  const investors = cv('investors') as string[];

  // Classifications resolve through resolveClassification so that editing the underlying
  // evidence (Sector, Operating countries, the round list, the investor list) re-runs the
  // funnel on its own, instead of leaving a stale hand-entered answer in charge.
  const fintechRes = resolveClassification(raw, edits, 'classifications.fintech', getFieldDefault(raw, 'classifications.fintech', edits).value as boolean);
  const hasSeriesARes = resolveClassification(raw, edits, 'classifications.hasSeriesA', getFieldDefault(raw, 'classifications.hasSeriesA', edits).value as boolean);
  const multiMarketRes = resolveClassification(raw, edits, 'classifications.multiMarket', getFieldDefault(raw, 'classifications.multiMarket', edits).value as boolean);

  const fintech = fintechRes.value;
  const hasSeriesA = hasSeriesARes.value;
  const multiMarket = multiMarketRes.value;

  // --- Rounds on Record: fully resolved (original + edits + additions, minus removed) ---
  const activeRounds = resolveRounds(raw, edits);
  const roundsSummary = summarizeRounds(activeRounds);
  const latestRoundType = roundsSummary.latest?.type ?? null;

  // --- Stage recomputation using the CURRENT (possibly investor-edited) values ---
  const stage2Pass = fintech;
  const stage2Reason = fintechRes.superseded
    ? `${getFieldDefault(raw, 'classifications.fintech', edits).source} — re-derived after you edited ${fintechRes.supersededBy.join(', ')}`
    : edits[id]?.['classifications.fintech']?.isOverridden
      ? `Investor judgment: ${fintech ? 'Yes' : 'No'} — ${edits[id]!['classifications.fintech'].history.at(-1)?.reason ?? ''}`
      : raw.stage2.reason;

  const statusExcludes = status === 'Acquired' || status === 'Shutdown';
  const stage3Pass = !hasSeriesA && !statusExcludes;
  const stage3Reason = statusExcludes
    ? `Company status = ${status} — no longer an independent investable target`
    : hasSeriesARes.superseded
      ? `${getFieldDefault(raw, 'classifications.hasSeriesA', edits).source} — re-derived after you edited ${hasSeriesARes.supersededBy.join(', ')}`
      : edits[id]?.['classifications.hasSeriesA']?.isOverridden
        ? `Investor judgment: ${hasSeriesA ? 'Has raised Series A+' : 'No Series A on record'} — ${edits[id]!['classifications.hasSeriesA'].history.at(-1)?.reason ?? ''}`
        : getFieldDefault(raw, 'classifications.hasSeriesA', edits).source;

  const geoAutoPass = !!country && GEO_AUTO_PASS_COUNTRIES.has(country);
  const stage4Pass = geoAutoPass || multiMarket;
  // The reason must describe why the gate landed where it did NOW, not repeat the frozen ETL
  // string. getFieldDefault already explains a derived multi-market result (e.g. "Derived from
  // operating countries: 4 African markets on record"), so that explanation is reused verbatim
  // instead of the stale "no multi-market evidence found".
  const multiMarketDefault = getFieldDefault(raw, 'classifications.multiMarket', edits);
  const stage4Reason = geoAutoPass
    ? `HQ/base = ${country} (auto-pass)`
    : multiMarketRes.superseded
      ? `${multiMarketDefault.source} — re-derived after you edited ${multiMarketRes.supersededBy.join(', ')}`
      : edits[id]?.['classifications.multiMarket']?.isOverridden
        ? `Investor judgment: ${multiMarket ? '3+ African markets confirmed' : 'not multi-market'} — ${edits[id]!['classifications.multiMarket'].history.at(-1)?.reason ?? ''}`
        : `HQ/base = ${country}; ${multiMarketDefault.source}`;

  // Passed every content gate; eligible for the syndicate check (Stage 5).
  const passedContent = stage2Pass && stage3Pass && stage4Pass;

  let cutStage: number | null = null;
  let cutReason: string | null = null;
  if (!stage2Pass) {
    cutStage = 2;
    cutReason = stage2Reason;
  } else if (!stage3Pass) {
    cutStage = 3;
    cutReason = stage3Reason;
  } else if (!stage4Pass) {
    cutStage = 4;
    cutReason = stage4Reason;
  }

  // The gate is recomputed from the CURRENT investor list, so adding or removing an investor
  // re-runs Stage 5 the same way editing operating countries re-runs Stage 4.
  const resolvedForGate: Company = { ...raw, investors, country };
  const autoGate = computeSyndicateGate(resolvedForGate, fundIndex, metricsIndex);
  const strongSyndicateField = edits[id]?.['classifications.strongSyndicate'];
  const syndicateRes = resolveClassification(raw, edits, 'classifications.strongSyndicate', autoGate.pass);
  // A seed-baked investor-judgment promotion carried in the dataset itself
  // (overrides.syndicateJudgment) -- the Stage-5 analogue of overrides.geography3Markets /
  // fintechPivot for the earlier stages (see getFieldDefault in fields.ts). It stands in for a
  // live strongSyndicate edit so a deliberate judgment call survives a fresh browser or a deploy
  // with an empty localStorage, but a live edit still supersedes it (same precedence as the ETL
  // overrides upstream: the localStorage edit layer always wins when present).
  const seedSyndicateJudgment = raw.overrides?.syndicateJudgment?.active === true;
  const strongSyndicate = strongSyndicateField ? syndicateRes.value : (autoGate.pass || seedSyndicateJudgment);
  const syndicateOverridden = !!strongSyndicateField?.isOverridden && !syndicateRes.superseded;
  const stage5Pass = passedContent && strongSyndicate;
  const stage5Reason = syndicateRes.superseded
    ? `Automated: ${autoGate.pass ? `qualifying anchor ${autoGate.qualifyingInvestor}` : 'no named investor met the binary syndicate-strength rubric'} — re-derived after you edited ${syndicateRes.supersededBy.join(', ')}`
    : syndicateOverridden
      ? `Investor judgment: ${strongSyndicate ? 'Strong syndicate confirmed' : 'Syndicate rejected'} — ${strongSyndicateField!.history.at(-1)?.reason ?? ''}`
      : autoGate.pass
        ? `Automated: qualifying anchor ${autoGate.qualifyingInvestor}`
        : seedSyndicateJudgment
          ? `Investor judgment: Strong syndicate confirmed — ${raw.overrides.syndicateJudgment.note}`
          : 'Automated: no named investor met the binary syndicate-strength rubric';

  return {
    ...raw,
    name,
    website,
    country,
    city,
    operatingCountries,
    foundingYear,
    founders,
    founderInfo,
    description,
    sector,
    fintechSubSector,
    businessModel,
    status,
    investors,
    latestRoundType,
    stage2: { ...raw.stage2, pass: stage2Pass, reason: stage2Reason },
    stage3: { ...raw.stage3, pass: stage3Pass, reason: stage3Reason },
    stage4: { ...raw.stage4, pass: stage4Pass, reason: stage4Reason },
    stage5: { pass: stage5Pass, reason: stage5Reason, qualifyingInvestor: autoGate.qualifyingInvestor ?? undefined },
    cutStage,
    cutReason,
  } as Company;
}
