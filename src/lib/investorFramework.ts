import frameworkData from '../data/investor_framework.json';
import { normalizeInvestorName } from './funnel';
import type { LiveInvestorMetrics } from './investorMetrics';
import { emptyLiveMetrics } from './investorMetrics';

/** One investor row from the analyst's scoring workbook (Quona_CaseA_Investor_Scoring_jav1.xlsx),
 *  imported by scripts/import_investor_framework.py. These are EVIDENCE INPUTS, never final
 *  scores -- every score in the app is recomputed from these via the anchors in scoring.ts. */
export interface FrameworkInvestor {
  name: string;
  tier: string | null;
  /** THE authoritative fund-level / VC score, straight from the workbook's
   *  "FUND-LEVEL SCORE (0-100)" column. Never recalculated by the app. */
  fundLevelScore: number | null;
  dimensionsScored: number | null;
  tierBand: string | null;
  /** The same workbook's SUMPRODUCT re-applied to its own current ratings. Stored only so the
   *  UI can show where the cached cell and the formula disagree (267/392 rows). Never used
   *  in place of fundLevelScore. */
  recomputedScore: number | null;
  researchStatus: string | null;
  hardFlag: string | null;
  hq: string | null;
  hqRegion: string | null;
  website: string | null;
  presenceFlags: Record<string, number | null>;
  presenceEvidence: string | null;
  metrics: {
    fintechDealsAll: number | null;
    fintechDealsWindow: number | null;
    fintechEarlyStageWindow: number | null;
    totalDeals: number | null;
    africanCountries: number | null;
    refSetCoInvestors: number | null;
    followOnDenom: number | null;
    followOnNumer: number | null;
    followOnRate: number | null;
    gradDenom: number | null;
    gradNumer: number | null;
    gradRate: number | null;
    exits: number | null;
  };
  researchRatings: Record<string, number>;
  /** Ratings where the analyst deliberately departed from what the anchors compute. Applied as
   *  a user override on top of the automated rating, never silently folded into it. */
  analystOverrides: Record<string, number>;
}

const FRAMEWORK = frameworkData as unknown as FrameworkInvestor[];

export const FRAMEWORK_BY_NAME = new Map<string, FrameworkInvestor>(
  FRAMEWORK.map((i) => [normalizeInvestorName(i.name), i])
);

/** Reference set for Co-Investment Reputation: the Tier 1 funds in the analyst's workbook.
 *  Co-investing alongside a recognised fund is the signal; "any investor" would not be one. */
export const REFERENCE_SET = new Set<string>(
  FRAMEWORK.filter((i) => i.tier === 'Tier 1').map((i) => normalizeInvestorName(i.name))
);

export const PRESENCE_COUNTRIES = ['Egypt', 'South Africa', 'Kenya', 'Nigeria'] as const;

export const ALL_FRAMEWORK_INVESTORS: FrameworkInvestor[] = FRAMEWORK;

/** The workbook's authoritative score for an investor, or null if they aren't in it. */
export function getExcelScore(investorName: string): FrameworkInvestor | null {
  return FRAMEWORK_BY_NAME.get(normalizeInvestorName(investorName)) ?? null;
}

export interface MetricWithProvenance {
  value: number | null;
  /** Which evidence base produced this value, so a rating can always be traced back. */
  source: 'workbook' | 'live' | 'none';
}

export interface EffectiveMetrics {
  fintechDeals: MetricWithProvenance;
  africanCountries: MetricWithProvenance;
  refSetCoInvestors: MetricWithProvenance;
  followOnRate: MetricWithProvenance & { denom: number };
  gradRate: MetricWithProvenance & { denom: number };
  live: LiveInvestorMetrics;
  framework: FrameworkInvestor | null;
}

/** Counts are monotonic in dataset size, so the larger of (workbook baseline, live database)
 *  is the better estimate: the workbook swept a broader deal universe than this app holds, but
 *  the app gains deals the workbook never saw as soon as the user adds a round. */
function pickCount(workbook: number | null | undefined, live: number): MetricWithProvenance {
  if (workbook == null) return live > 0 ? { value: live, source: 'live' } : { value: null, source: 'none' };
  if (live > workbook) return { value: live, source: 'live' };
  return { value: workbook, source: 'workbook' };
}

/** Rates are not monotonic, so the sample with the larger denominator wins rather than the
 *  larger value -- a 100% follow-on rate off two deals is noise, not a strong fund. */
function pickRate(
  wbRate: number | null | undefined,
  wbDenom: number | null | undefined,
  liveRate: number | null,
  liveDenom: number
): MetricWithProvenance & { denom: number } {
  const wd = wbDenom ?? 0;
  if (wbRate != null && wd >= liveDenom) return { value: wbRate, denom: wd, source: 'workbook' };
  if (liveRate != null && liveDenom > 0) return { value: liveRate, denom: liveDenom, source: 'live' };
  if (wbRate != null) return { value: wbRate, denom: wd, source: 'workbook' };
  return { value: null, denom: 0, source: 'none' };
}

export function getEffectiveMetrics(investorName: string, live: LiveInvestorMetrics | undefined): EffectiveMetrics {
  const key = normalizeInvestorName(investorName);
  const framework = FRAMEWORK_BY_NAME.get(key) ?? null;
  const l = live ?? emptyLiveMetrics();
  const m = framework?.metrics;

  return {
    fintechDeals: pickCount(m?.fintechDealsAll, l.fintechDeals),
    africanCountries: pickCount(m?.africanCountries, l.africanCountries),
    refSetCoInvestors: pickCount(m?.refSetCoInvestors, l.refSetCoInvestors),
    followOnRate: pickRate(m?.followOnRate, m?.followOnDenom, l.followOnRate, l.followOnDenom),
    gradRate: pickRate(m?.gradRate, m?.gradDenom, l.gradRate, l.gradDenom),
    live: l,
    framework,
  };
}
