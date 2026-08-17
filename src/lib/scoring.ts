import type { Fund } from '../types';
import { getEffectiveMetrics, PRESENCE_COUNTRIES, type EffectiveMetrics } from './investorFramework';
import type { LiveInvestorMetrics } from './investorMetrics';

const TODAY = new Date('2026-08-12');

export const HIGH_WEIGHT = 16;
export const MEDIUM_WEIGHT = 7.2;

/** Weights and dimensions transcribed from the 'Weights' sheet of the analyst's scoring
 *  workbook (Quona_CaseA_Investor_Scoring_jav1.xlsx). Four High-tier at 16 and five
 *  Medium-tier at 7.2 sum to 100. `computed` marks the dimensions the workbook derives from
 *  deal data rather than manual research -- those are calculated live from the app's own
 *  database (see investorMetrics.ts), which is what lets the app score an investor the
 *  workbook never covered. */
export const DIMENSION_META = [
  { key: 'localCountryPresence', label: 'Local Country Presence', tier: 'High', weight: HIGH_WEIGHT, computed: false },
  { key: 'seriesAFollowOnCapacity', label: 'Series A Follow-on Capacity', tier: 'High', weight: HIGH_WEIGHT, computed: true },
  { key: 'fintechPortfolioDepth', label: 'Fintech Portfolio Depth', tier: 'High', weight: HIGH_WEIGHT, computed: true },
  { key: 'coInvestmentReputation', label: 'Co-Investment Reputation', tier: 'High', weight: HIGH_WEIGHT, computed: true },
  { key: 'africanMarketExpertise', label: 'African Market Expertise', tier: 'Medium', weight: MEDIUM_WEIGHT, computed: true },
  { key: 'globalCrossBorderNetwork', label: 'Global / Cross-Border Network', tier: 'Medium', weight: MEDIUM_WEIGHT, computed: false },
  { key: 'operationalSupportBench', label: 'Operational Support Bench', tier: 'Medium', weight: MEDIUM_WEIGHT, computed: false },
  { key: 'regulatoryGovRelationships', label: 'Regulatory / Gov Relationships', tier: 'Medium', weight: MEDIUM_WEIGHT, computed: false },
  { key: 'historicalInvestmentOutcomes', label: 'Historical Investment Outcomes', tier: 'Medium', weight: MEDIUM_WEIGHT, computed: true },
] as const;

export type DimensionKey = (typeof DIMENSION_META)[number]['key'];

/** Tier bands from the workbook's own formula: >=75 Strong, >=45 Moderate, else Weak.
 *  (These replace this build's earlier 65/40 bands -- the workbook takes precedence.) */
export const STRONG_BAND = 75;
export const MODERATE_BAND = 45;

/** Rate-based dimensions need a minimum sample before a rate means anything -- the workbook
 *  specifies "24m-matured, min n=4". Below that the dimension is left unscored rather than
 *  scored off noise, and simply drops out of the weighted average. */
export const MIN_RATE_SAMPLE = 4;

/** Rating anchors transcribed from the workbook's 'Rating Anchors' sheet. Each entry is the
 *  set of upper-exclusive cut points for ratings 1-4; at or above the last cut, the rating is 5. */
export const ANCHORS = {
  fintechPortfolioDepth: [2, 4, 8, 16],
  africanMarketExpertise: [2, 4, 7, 10],
  coInvestmentReputation: [1, 2, 4, 7],
  seriesAFollowOnCapacity: [0.20, 0.28, 0.40, 0.54],
  historicalInvestmentOutcomes: [0.05, 0.13, 0.20, 0.30],
  localCountryPresence: [1, 3, 5, 8],
} as const;

export function bandRating(value: number, cuts: readonly number[]): number {
  for (let i = 0; i < cuts.length; i++) {
    if (value < cuts[i]) return i + 1;
  }
  return 5;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export interface ResolvedDimension {
  key: DimensionKey;
  label: string;
  tier: 'High' | 'Medium';
  weight: number;
  rating: number | null; // 1-5
  evidence: string | null;
  source: string | null;
  /** True when this rating came from the analyst's workbook departing from the anchors, or
   *  from an in-app override -- as opposed to being freshly computed. */
  isOverride?: boolean;
}

// ---------------------------------------------------------------------------
// Country-specific relevance -- deliberately the app's OWN analysis
// ---------------------------------------------------------------------------

export interface CountryRelevance {
  /** 1-5, or null when there is genuinely nothing to judge on. */
  rating: number | null;
  /** Plain-English basis for the assessment, always shown next to the rating. */
  explanation: string;
  /** Ordered evidence lines behind the rating. */
  evidence: string[];
}

/**
 * Assesses how relevant an investor is to ONE specific country, rather than reading a
 * pre-existing fund-level score. Per the brief, this stays the application's own analysis:
 * it combines the analyst's in-country presence flag (a 0-3 staffing signal), the investor's
 * actually-observed deal activity in that country from the live database, declared presence
 * countries, and pan-African reach -- and always explains which of those drove the result.
 */
export function assessCountryRelevance(
  fund: Fund,
  companyCountry: string | null,
  metrics: EffectiveMetrics
): CountryRelevance {
  if (!companyCountry) {
    return { rating: null, explanation: 'Company country unknown — cannot assess country relevance.', evidence: [] };
  }

  const evidence: string[] = [];
  const framework = metrics.framework;
  const dealsHere = metrics.live.dealsByCountry[companyCountry] ?? 0;

  const presenceFlag = framework?.presenceFlags?.[companyCountry];
  const hasFlag = presenceFlag != null && (PRESENCE_COUNTRIES as readonly string[]).includes(companyCountry);

  let rating: number | null = null;
  let basis = '';

  if (hasFlag) {
    // 0-3 staffing flag -> 1-5. 3 = resident decision-maker, 2 = resident staff,
    // 1 = platform/ops or covered remotely, 0 = no presence at all.
    const map: Record<number, number> = { 0: 1, 1: 3, 2: 4, 3: 5 };
    rating = map[presenceFlag] ?? null;
    const label: Record<number, string> = {
      0: 'no presence',
      1: 'platform/ops only or covered from outside',
      2: 'non-partner investment staff resident',
      3: 'investment decision-maker resident in-country',
    };
    evidence.push(`Researched presence flag for ${companyCountry}: ${presenceFlag}/3 — ${label[presenceFlag]}.`);
    basis = `researched in-country presence (${presenceFlag}/3)`;
    if (framework?.presenceEvidence) evidence.push(`Presence evidence: ${framework.presenceEvidence}`);
  }

  // Every applicable signal is scored, then the STRONGEST wins. Short-circuiting on the first
  // signal was wrong: a pan-African fund with one deal in a country scored 2, while the same
  // fund with no deals scored 3 on its mandate alone -- adding evidence made the assessment
  // worse. Presence, dealflow and mandate are independent grounds for relevance, not a
  // priority chain.
  const candidates: { rating: number; basis: string }[] = [];
  if (rating != null) candidates.push({ rating, basis });

  if (dealsHere > 0) {
    evidence.push(`${dealsHere} observed deal${dealsHere === 1 ? '' : 's'} in ${companyCountry} in this database.`);
    // Demonstrated local dealflow, capped at 4 -- writing cheques into a market is not the
    // same as having a partner on the ground.
    candidates.push({
      rating: dealsHere >= 5 ? 4 : dealsHere >= 2 ? 3 : 2,
      basis: `observed deal activity in ${companyCountry}`,
    });
  }

  if (fund.presenceCountries.includes(companyCountry)) {
    evidence.push(`Fund profile lists ${companyCountry} among its presence countries.`);
    candidates.push({ rating: 4, basis: `declared office/team presence in ${companyCountry}` });
  }

  if (fund.panAfrican) {
    evidence.push('Fund has a pan-African mandate.');
    candidates.push({ rating: 3, basis: 'pan-African mandate (partial credit)' });
  }

  if (candidates.length === 0) {
    const region = framework?.hqRegion;
    if (region && region !== 'Africa' && region !== 'n.a') {
      evidence.push(`HQ region is ${region}; no African country-level evidence found.`);
    }
    return {
      rating: 1,
      explanation: `No evidence of presence or prior activity in ${companyCountry}.`,
      evidence: evidence.length ? evidence : [`Nothing on record linking this investor to ${companyCountry}.`],
    };
  }

  const best = candidates.reduce((a, b) => (b.rating > a.rating ? b : a));
  rating = best.rating;
  basis = best.basis;

  return { rating, explanation: `Assessed ${rating}/5 for ${companyCountry} on the basis of ${basis}.`, evidence };
}

// ---------------------------------------------------------------------------
// Computed dimensions
// ---------------------------------------------------------------------------

/** Legacy fund-vintage proxy, kept only as a fallback for when neither the workbook nor the
 *  live database has enough matured deals to measure a real follow-on rate. The workbook's
 *  observed-rate method is preferred wherever a sample of >= MIN_RATE_SAMPLE exists. */
export function followOnCapacityRating(fund: Fund): { rating: number | null; evidence: string; band: string } {
  if (!fund.vintageYear) return { rating: null, evidence: 'Fund vintage year unknown', band: 'Unknown' };
  const age = TODAY.getFullYear() - fund.vintageYear;
  if (age <= 3) return { rating: 5, evidence: `Fund is ${age}y old — still actively deploying`, band: 'High' };
  if (age <= 6) return { rating: 4, evidence: `Fund is ${age}y old — within/just past deployment, follow-on reserves typically active`, band: 'Medium-High' };
  if (age <= 7) return { rating: 3, evidence: `Fund is ${age}y old — past deployment but plausibly within active follow-on window`, band: 'Medium' };
  return { rating: 2, evidence: `Fund is ${age}y old — beyond typical follow-on window, likely in harvest/exit mode`, band: 'Low' };
}

function provenanceLabel(source: 'workbook' | 'live' | 'none'): string {
  return source === 'workbook' ? 'investor scoring workbook' : source === 'live' ? 'this database' : 'no evidence';
}

interface ComputedResult {
  rating: number | null;
  evidence: string;
}

function computeDimension(key: DimensionKey, m: EffectiveMetrics, fund: Fund): ComputedResult {
  switch (key) {
    case 'fintechPortfolioDepth': {
      const { value, source } = m.fintechDeals;
      if (value == null) return { rating: null, evidence: 'No fintech deal record found' };
      return {
        rating: bandRating(value, ANCHORS.fintechPortfolioDepth),
        evidence: `${value} fintech deal${value === 1 ? '' : 's'} on record (${provenanceLabel(source)})`,
      };
    }
    case 'africanMarketExpertise': {
      const { value, source } = m.africanCountries;
      if (value == null) return { rating: null, evidence: 'No country coverage on record' };
      return {
        rating: bandRating(value, ANCHORS.africanMarketExpertise),
        evidence: `Active in ${value} African ${value === 1 ? 'country' : 'countries'} (${provenanceLabel(source)})`,
      };
    }
    case 'coInvestmentReputation': {
      const { value, source } = m.refSetCoInvestors;
      if (value == null) return { rating: null, evidence: 'No co-investment record found' };
      return {
        rating: bandRating(value, ANCHORS.coInvestmentReputation),
        evidence: `Co-invested with ${value} reference-set fund${value === 1 ? '' : 's'} (${provenanceLabel(source)})`,
      };
    }
    case 'seriesAFollowOnCapacity': {
      const { value, denom, source } = m.followOnRate;
      if (value == null || denom < MIN_RATE_SAMPLE) {
        const fallback = followOnCapacityRating(fund);
        const why = denom > 0 ? `only ${denom} matured deal${denom === 1 ? '' : 's'} (need ${MIN_RATE_SAMPLE})` : 'no matured deals on record';
        if (fallback.rating == null) return { rating: null, evidence: `Insufficient sample — ${why}; fund vintage also unknown` };
        return { rating: fallback.rating, evidence: `Insufficient sample — ${why}. Fallback to vintage proxy: ${fallback.evidence}` };
      }
      return {
        rating: bandRating(value, ANCHORS.seriesAFollowOnCapacity),
        evidence: `Observed follow-on rate ${pct(value)} across ${denom} matured deals (${provenanceLabel(source)})`,
      };
    }
    case 'historicalInvestmentOutcomes': {
      const { value, denom, source } = m.gradRate;
      if (value == null || denom < MIN_RATE_SAMPLE) {
        const why = denom > 0 ? `only ${denom} matured deal${denom === 1 ? '' : 's'} (need ${MIN_RATE_SAMPLE})` : 'no matured deals on record';
        return { rating: null, evidence: `Insufficient sample — ${why}` };
      }
      return {
        rating: bandRating(value, ANCHORS.historicalInvestmentOutcomes),
        evidence: `Graduation rate to Series A+ ${pct(value)} across ${denom} matured deals (${provenanceLabel(source)})`,
      };
    }
    default:
      return { rating: null, evidence: '' };
  }
}

// ---------------------------------------------------------------------------
// Dimension resolution + scoring
// ---------------------------------------------------------------------------

export interface ScoringInput {
  fund: Fund;
  companyCountry: string | null;
  liveMetrics: LiveInvestorMetrics | undefined;
}

/**
 * Per-fund memo of resolved dimensions.
 *
 * Dimension resolution is the hot path: it runs once per (investor x company), which is ~3,500
 * calls for a full-database render, and each call does metric merging, anchor banding and a
 * country-relevance assessment. Almost all of those calls repeat -- Launch Africa alone appears
 * on 57 companies, and every company in the same country produces an identical result.
 *
 * Keyed on the Fund OBJECT via a WeakMap, so the cache invalidates for free: resolveFundIndex()
 * rebuilds every Fund whenever edits change, which yields new object identities and therefore a
 * cold cache. There is no manual invalidation to get wrong. `liveMetrics` identity is checked
 * too, so a rebuilt metrics index also busts the entry.
 */
const dimensionCache = new WeakMap<Fund, Map<string, { metrics: LiveInvestorMetrics | undefined; dims: ResolvedDimension[] }>>();

export function resolveDimensions(fund: Fund, companyCountry: string | null, liveMetrics?: LiveInvestorMetrics): ResolvedDimension[] {
  const cacheKey = companyCountry ?? ' none';
  let byCountry = dimensionCache.get(fund);
  if (byCountry) {
    const hit = byCountry.get(cacheKey);
    if (hit && hit.metrics === liveMetrics) return hit.dims;
  } else {
    byCountry = new Map();
    dimensionCache.set(fund, byCountry);
  }
  const dims = computeDimensions(fund, companyCountry, liveMetrics);
  byCountry.set(cacheKey, { metrics: liveMetrics, dims });
  return dims;
}

function computeDimensions(fund: Fund, companyCountry: string | null, liveMetrics?: LiveInvestorMetrics): ResolvedDimension[] {
  const metrics = getEffectiveMetrics(fund.name, liveMetrics);
  const framework = metrics.framework;
  const relevance = assessCountryRelevance(fund, companyCountry, metrics);

  return DIMENSION_META.map((meta): ResolvedDimension => {
    const key = meta.key as DimensionKey;

    // An in-app override (edited through the UI) always wins -- it is the investor's own
    // judgment and is never recalculated away. Note this checks the explicit override list,
    // NOT merely "does fund.dimensions carry a rating": a researched value sitting in
    // funds.json is a baseline, not a user override, and labelling it as one would tell the
    // user they had manually scored funds they never touched.
    const isInAppOverride = fund.investorOverriddenDimensions?.includes(key) ?? false;
    const inAppOverride = fund.dimensions[key as keyof Fund['dimensions']];
    if (isInAppOverride && inAppOverride?.rating != null) {
      return { ...meta, rating: inAppOverride.rating, evidence: inAppOverride.evidence, source: inAppOverride.source, isOverride: true };
    }

    // Local Country Presence is answered by the app's own country-relevance analysis rather
    // than a fund-level number, so the same fund scores differently for an Egyptian company
    // than for a Nigerian one.
    if (key === 'localCountryPresence') {
      const researched = framework?.researchRatings?.localCountryPresence;
      if (relevance.rating == null && researched != null) {
        return { ...meta, rating: researched, evidence: 'Fund-level presence rating from the scoring workbook', source: 'Investor scoring workbook' };
      }
      return {
        ...meta,
        rating: relevance.rating,
        evidence: [relevance.explanation, ...relevance.evidence].join(' '),
        source: 'Country relevance analysis (this application)',
      };
    }

    // Analyst departures from the anchors, imported from the workbook, are preserved as
    // overrides rather than being recomputed away.
    const analystOverride = framework?.analystOverrides?.[key];
    if (analystOverride != null) {
      const computed = computeDimension(key, metrics, fund);
      const suffix = computed.rating != null ? ` (anchors compute ${computed.rating}/5 from: ${computed.evidence})` : '';
      return {
        ...meta,
        rating: analystOverride,
        evidence: `Analyst-adjusted in the scoring workbook${suffix}`,
        source: 'Investor scoring workbook — manual adjustment',
        isOverride: true,
      };
    }

    if (meta.computed) {
      const computed = computeDimension(key, metrics, fund);
      if (computed.rating != null) {
        return { ...meta, rating: computed.rating, evidence: computed.evidence, source: 'Computed from deal data' };
      }
      // Nothing computable (no metrics at all) -- fall back to any researched value already
      // on the fund profile rather than dropping the dimension entirely.
      const stale = fund.dimensions[key as keyof Fund['dimensions']];
      if (stale?.rating != null) {
        return { ...meta, rating: stale.rating, evidence: stale.evidence, source: stale.source ?? 'Fund profile research' };
      }
      return { ...meta, rating: null, evidence: computed.evidence, source: null };
    }

    // Remaining research dimensions: workbook rating first, then anything already on the fund.
    const researched = framework?.researchRatings?.[key];
    if (researched != null) {
      return { ...meta, rating: researched, evidence: 'Manual research rating from the scoring workbook', source: 'Investor scoring workbook' };
    }
    const d = fund.dimensions[key as keyof Fund['dimensions']];
    return { ...meta, rating: d?.rating ?? null, evidence: d?.evidence ?? null, source: d?.source ?? null };
  });
}

export type ScoreOrigin = 'manual-override' | 'excel-workbook' | 'research-derived' | 'unscored';

export interface FundCompanyScore {
  score: number | null; // 0-100
  completeness: string; // "3 of 9"
  scoredCount: number;
  tier: 'Strong' | 'Moderate' | 'Weak' | 'Unscored';
  dimensions: ResolvedDimension[];
  countryRelevance: CountryRelevance;
  /** Where the displayed fund-level score came from. Drives the UI label so an Excel score is
   *  never presented as an AI/research-derived one, or vice versa. */
  origin: ScoreOrigin;
  /** The workbook's score, when this investor is in the workbook. */
  excelScore: number | null;
  /** The workbook's own SUMPRODUCT re-applied to its current ratings -- shown only where it
   *  disagrees with the cached cell, so the discrepancy is visible rather than silent. */
  excelRecomputed: number | null;
  /** Score computed from dimensions/deal data. Retained even when an Excel score is in use, so
   *  "original automated value" is always available alongside any override. */
  computedScore: number | null;
}

/**
 * The workbook's scoring formula, unchanged:
 *   SUMPRODUCT((rating-1)/4 * weight) / SUMPRODUCT(weight) * 100
 * over only the dimensions that actually carry a rating. Unscored dimensions drop out of both
 * numerator and denominator -- a blank is never treated as a zero.
 */
function bandFor(score: number): FundCompanyScore['tier'] {
  return score >= STRONG_BAND ? 'Strong' : score >= MODERATE_BAND ? 'Moderate' : 'Weak';
}

/**
 * Resolves an investor's fund-level score for a specific company.
 *
 * Precedence, per explicit instruction -- the analyst's workbook IS the scoring system:
 *   1. MANUAL OVERRIDE made in the app (fund:<name> -> fundLevelScoreOverride)
 *   2. EXCEL "FUND-LEVEL SCORE (0-100)" for any investor present in the workbook, used
 *      verbatim and never recalculated from the dimensions
 *   3. computed from dimensions/deal data, for investors absent from the workbook
 *   4. unscored -- insufficient verified evidence
 *
 * Local Country Presence is deliberately excluded from this hierarchy: it stays company-
 * specific and is recomputed per deal (see assessCountryRelevance), so the same investor is
 * scored differently against an Egyptian company than a Nigerian one.
 */
const scoreCache = new WeakMap<Fund, Map<string, { metrics: LiveInvestorMetrics | undefined; score: FundCompanyScore }>>();

/** Memoized wrapper -- see dimensionCache above for why a WeakMap on the Fund object is the
 *  right invalidation strategy. The uncached body is computeScoreForCompany(). */
export function scoreFundForCompany(fund: Fund, companyCountry: string | null, liveMetrics?: LiveInvestorMetrics): FundCompanyScore {
  const cacheKey = companyCountry ?? ' none';
  let byCountry = scoreCache.get(fund);
  if (byCountry) {
    const hit = byCountry.get(cacheKey);
    if (hit && hit.metrics === liveMetrics) return hit.score;
  } else {
    byCountry = new Map();
    scoreCache.set(fund, byCountry);
  }
  const score = computeScoreForCompany(fund, companyCountry, liveMetrics);
  byCountry.set(cacheKey, { metrics: liveMetrics, score });
  return score;
}

function computeScoreForCompany(fund: Fund, companyCountry: string | null, liveMetrics?: LiveInvestorMetrics): FundCompanyScore {
  const dims = resolveDimensions(fund, companyCountry, liveMetrics);
  const metrics = getEffectiveMetrics(fund.name, liveMetrics);
  const countryRelevance = assessCountryRelevance(fund, companyCountry, metrics);
  const framework = metrics.framework;
  const scored = dims.filter((d) => d.rating !== null);

  // --- computed score (always calculated, so the automated baseline is never lost) ---
  let computedScore: number | null = null;
  if (scored.filter((d) => d.tier === 'High').length >= 1) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const d of scored) {
      weightedSum += ((d.rating! - 1) / 4) * d.weight;
      weightTotal += d.weight;
    }
    computedScore = Math.round((weightedSum / weightTotal) * 1000) / 10;
  }

  const excelScore = framework?.fundLevelScore ?? null;
  const excelRecomputed = framework?.recomputedScore ?? null;
  const base = {
    dimensions: dims,
    countryRelevance,
    excelScore,
    excelRecomputed,
    computedScore,
  };

  // 1. Manual override always wins and is never recalculated away.
  if (fund.fundLevelScoreOverride != null) {
    const s = fund.fundLevelScoreOverride;
    return { ...base, score: s, tier: bandFor(s), completeness: `${scored.length} of 9`, scoredCount: scored.length, origin: 'manual-override' };
  }

  // 2. The workbook is authoritative for every investor it contains.
  if (excelScore != null) {
    const count = framework?.dimensionsScored ?? scored.length;
    const tier = (framework?.tierBand as FundCompanyScore['tier']) || bandFor(excelScore);
    return { ...base, score: excelScore, tier, completeness: `${count} of 9`, scoredCount: count, origin: 'excel-workbook' };
  }

  // 3. Not in the workbook -- compute from dimensions / deal data.
  if (computedScore != null) {
    return { ...base, score: computedScore, tier: bandFor(computedScore), completeness: `${scored.length} of 9`, scoredCount: scored.length, origin: 'research-derived' };
  }

  // 4. Nothing to go on.
  return { ...base, score: null, tier: 'Unscored', completeness: `${scored.length} of 9`, scoredCount: scored.length, origin: 'unscored' };
}

/**
 * Stage 5 binary qualitative gate -- deliberately NOT the 0-100 engine (per spec, that's
 * reserved for Deliverable #2). Operationalizes "dedicated Africa/fintech thesis,
 * demonstrated Series A follow-through, local presence, co-investment reputation" as:
 * local presence confirmed (direct or pan-African) AND fund not in harvest mode AND
 * has some evidence of fintech thesis or co-investment reputation. Missing evidence
 * fails the criterion (conservative reading) -- documented here, not hidden.
 */
export function passesBinarySyndicateGate(fund: Fund, companyCountry: string | null, liveMetrics?: LiveInvestorMetrics): { pass: boolean; reasons: string[] } {
  const dims = resolveDimensions(fund, companyCountry, liveMetrics);
  const local = dims.find((d) => d.key === 'localCountryPresence')!;
  const followOn = dims.find((d) => d.key === 'seriesAFollowOnCapacity')!;
  const fintechDepth = dims.find((d) => d.key === 'fintechPortfolioDepth')!.rating;
  const coInvest = dims.find((d) => d.key === 'coInvestmentReputation')!.rating;

  const presenceOk = (local.rating ?? 0) >= 3;
  const followOnOk = (followOn.rating ?? 0) >= 3;
  const thesisOk = (fintechDepth ?? 0) >= 3 || (coInvest ?? 0) >= 3;

  const reasons: string[] = [];
  const localEvidence = local.evidence ?? 'No evidence noted';
  const followOnEvidence = followOn.evidence ?? 'No evidence noted';
  reasons.push(presenceOk ? `Presence: ${localEvidence}` : `Presence gap: ${localEvidence}`);
  reasons.push(followOnOk ? `Follow-on: ${followOnEvidence}` : `Follow-on gap: ${followOnEvidence}`);
  reasons.push(thesisOk ? 'Fintech thesis or co-investment reputation evidenced' : 'No evidenced fintech thesis or co-investment reputation');

  return { pass: presenceOk && followOnOk && thesisOk, reasons };
}

/** Kept for the fund-detail editor, which shows a country-independent presence baseline. */
export function localPresenceRating(fund: Fund, companyCountry: string | null): { rating: number | null; evidence: string } {
  const relevance = assessCountryRelevance(fund, companyCountry, getEffectiveMetrics(fund.name, undefined));
  return { rating: relevance.rating, evidence: relevance.explanation };
}
