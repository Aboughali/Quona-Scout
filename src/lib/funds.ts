import type { DimensionScore, EditConfidence, Fund } from '../types';
import type { EditsStore } from './editStore';
import { DIMENSION_META, resolveDimensions, type DimensionKey } from './scoring';
import type { LiveInvestorMetrics } from './investorMetrics';
import { ALL_FRAMEWORK_INVESTORS, FRAMEWORK_BY_NAME } from './investorFramework';
import { normalizeInvestorName } from './funnel';

export function fundEntityId(name: string): string {
  return `fund:${normalizeInvestorName(name)}`;
}

const DIMENSION_KEYS = DIMENSION_META.map((d) => d.key);

function blankDimension(): DimensionScore {
  return { rating: null, evidence: null, source: null };
}

export function blankFund(name: string): Fund {
  return {
    name,
    hq: null,
    presenceCountries: [],
    panAfrican: false,
    vintageYear: null,
    fundSizeUsdM: null,
    investorCreated: true,
    investorType: undefined,
    dimensions: {
      fintechPortfolioDepth: blankDimension(),
      coInvestmentReputation: blankDimension(),
      africanMarketExpertise: blankDimension(),
      globalCrossBorderNetwork: blankDimension(),
      operationalSupportBench: blankDimension(),
      regulatoryGovRelationships: blankDimension(),
      historicalInvestmentOutcomes: blankDimension(),
    },
  };
}

export interface FundFieldDefault {
  value: unknown;
  source: string;
}

/** "Automated/research" default for a fund-level field or dimension rating -- mirrors
 *  lib/fields.ts's getFieldDefault but scoped to the fund entity namespace. `companyCountry`
 *  is only used for the two dimensions that are normally computed rather than researched
 *  (Local Country Presence is deal-relative; Follow-on Capacity derives from fund vintage) --
 *  without it those two would always show as "Unscored" instead of their real computed value. */
export function getFundFieldDefault(
  staticFund: Fund | undefined,
  displayName: string,
  path: string,
  companyCountry: string | null = null,
  liveMetrics?: LiveInvestorMetrics
): FundFieldDefault {
  const base = staticFund ?? blankFund(displayName);
  const notResearched = staticFund ? 'Not yet researched' : 'Investor-added — no automated research behind this fund';
  switch (path) {
    case 'hq':
      return { value: base.hq, source: base.hq ? 'Research' : notResearched };
    case 'vintageYear':
      return { value: base.vintageYear, source: base.vintageYear ? 'Research' : notResearched };
    case 'fundSizeUsdM':
      return { value: base.fundSizeUsdM, source: base.fundSizeUsdM ? 'Research' : notResearched };
    case 'investorType':
      return { value: base.investorType ?? null, source: base.investorType ? 'Research' : notResearched };
    case 'notes':
      return { value: base.notes ?? '', source: notResearched };
    case 'presenceCountries':
      return { value: base.presenceCountries, source: base.presenceCountries.length ? 'Research' : notResearched };
    case 'panAfrican':
      return { value: base.panAfrican, source: 'Research' };
    case 'displayName':
      return { value: base.name, source: 'Research' };
    default: {
      if ((DIMENSION_KEYS as string[]).includes(path)) {
        // The "Automated" baseline for any of the 9 dimensions is whatever the scoring engine
        // produces from the STATIC fund plus live deal metrics -- i.e. the value before any
        // in-app override. Running resolveDimensions() on the raw fund (rather than the
        // resolved one) is the same raw-vs-resolved discipline used for company fields: using
        // the resolved fund here would make an override look like it was always the
        // researched value.
        const dims = resolveDimensions(base, companyCountry, liveMetrics);
        const dim = dims.find((d) => d.key === path);
        if (dim?.rating != null) {
          return { value: dim.rating, source: dim.evidence ?? dim.source ?? 'Computed from deal data' };
        }
        return { value: null, source: dim?.evidence ?? notResearched };
      }
      return { value: null, source: 'Unknown field' };
    }
  }
}

/** Merges a static fund (or a blank shell for an investor-created one) with any active
 *  fund-level edits. Fund edits are intentionally NOT scoped to a single company -- per the
 *  syndicate scoring spec, every dimension except Local Country Presence is fund-level and
 *  reused across every company that fund backs, so an override here is meant to travel. */
export function resolveFund(displayName: string, staticFund: Fund | undefined, edits: EditsStore): Fund {
  const entity = fundEntityId(displayName);
  const inWorkbook = FRAMEWORK_BY_NAME.has(normalizeInvestorName(displayName));
  // "investor-created" means a fund the user typed in that exists in no source. A fund carried
  // by the analyst's scoring workbook is emphatically NOT investor-created, and labelling it
  // so would misattribute their own research to an ad-hoc entry.
  const base = staticFund ?? { ...blankFund(displayName), investorCreated: !inWorkbook };
  const entityEdits = edits[entity] ?? {};

  const cv = (path: string) => {
    const field = entityEdits[path];
    return field ? field.currentValue : getFundFieldDefault(staticFund, displayName, path).value;
  };

  const dimensions: Fund['dimensions'] = { ...base.dimensions };
  const investorOverriddenDimensions: string[] = [];
  for (const key of DIMENSION_KEYS) {
    const field = entityEdits[key];
    if (field?.isOverridden) {
      const lastEntry = field.history.at(-1);
      dimensions[key as Exclude<DimensionKey, never>] = {
        rating: field.currentValue as number | null,
        evidence: lastEntry?.reason ?? null,
        source: lastEntry?.source ?? null,
      };
      investorOverriddenDimensions.push(key);
    }
  }

  return {
    ...base,
    name: (cv('displayName') as string) || displayName,
    hq: cv('hq') as string | null,
    vintageYear: cv('vintageYear') as number | null,
    fundSizeUsdM: cv('fundSizeUsdM') as number | null,
    investorType: (cv('investorType') as string) || undefined,
    notes: cv('notes') as string,
    presenceCountries: cv('presenceCountries') as string[],
    panAfrican: cv('panAfrican') as boolean,
    dimensions,
    investorOverriddenDimensions,
    fundLevelScoreOverride: entityEdits['fundLevelScore']?.isOverridden
      ? (entityEdits['fundLevelScore'].currentValue as number | null)
      : null,
  };
}

/** Builds the merged fund index every scoring/funnel computation reads.
 *
 *  Sources, in order of how the display name is chosen:
 *    1. the analyst's investor scoring workbook (investor_framework.json) -- EVERY row, so an
 *       investor you have already scored is always scoreable;
 *    2. funds.json -- the older hand-researched fund profiles;
 *    3. `fund:*` entities in the edit store -- funds created inline in the app;
 *    4. `knownInvestorNames` -- every investor named on any round, so investors that are in
 *       neither the workbook nor funds.json still get a profile and can be researched.
 *
 *  Source (1) is the fix for the "Unknown / Unscored" bug: previously the index was built from
 *  funds.json alone, so 338 investors that the workbook HAD scored never got a Fund object,
 *  and the scoring engine -- which can only score an investor that has one -- never looked at
 *  their workbook data at all. */
export function resolveFundIndex(staticFunds: Fund[], edits: EditsStore, knownInvestorNames?: Iterable<string>): Map<string, Fund> {
  const displayNameByNormalized = new Map<string, string>();

  for (const i of ALL_FRAMEWORK_INVESTORS) displayNameByNormalized.set(normalizeInvestorName(i.name), i.name);
  for (const f of staticFunds) displayNameByNormalized.set(normalizeInvestorName(f.name), f.name);

  for (const entityKey of Object.keys(edits)) {
    const m = entityKey.match(/^fund:(.+)$/);
    if (!m) continue;
    const normalized = m[1];
    if (displayNameByNormalized.has(normalized)) continue;
    const displayField = edits[entityKey]?.['displayName'];
    displayNameByNormalized.set(normalized, (displayField?.currentValue as string) || normalized);
  }

  for (const raw of knownInvestorNames ?? []) {
    const normalized = normalizeInvestorName(raw);
    if (!normalized || displayNameByNormalized.has(normalized)) continue;
    displayNameByNormalized.set(normalized, raw);
  }

  const staticByNormalized = new Map(staticFunds.map((f) => [normalizeInvestorName(f.name), f]));
  const idx = new Map<string, Fund>();
  for (const [normalized, displayName] of displayNameByNormalized) {
    idx.set(normalized, resolveFund(displayName, staticByNormalized.get(normalized), edits));
  }
  return idx;
}

export const FUND_TYPE_OPTIONS = ['VC fund', 'Angel / individual', 'Corporate VC', 'DFI', 'Accelerator', 'Bank / lender', 'Family office', 'Other'];

export interface FundMetaDef {
  path: string;
  label: string;
  type: 'text' | 'number' | 'textarea' | 'select' | 'list' | 'boolean';
  options?: string[];
}

export const FUND_META_REGISTRY: FundMetaDef[] = [
  { path: 'hq', label: 'HQ', type: 'text' },
  { path: 'investorType', label: 'Investor type', type: 'select', options: FUND_TYPE_OPTIONS },
  { path: 'vintageYear', label: 'Fund vintage year', type: 'number' },
  { path: 'fundSizeUsdM', label: 'Fund size ($M)', type: 'number' },
  { path: 'presenceCountries', label: 'Presence countries', type: 'list' },
  { path: 'notes', label: 'Notes', type: 'textarea' },
];

export const NO_RATING_CONFIDENCE: EditConfidence = 'Medium';
