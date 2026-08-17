import type { Company } from '../types';
import type { EditsStore } from './editStore';
import { normalizeInvestorName } from './funnel';
import { resolveRounds, SERIES_A_PLUS_TYPES } from './rounds';

const TODAY = new Date('2026-08-12');
/** Workbook anchors specify follow-on / graduation rates on a "24m-matured" basis: a deal is
 *  only eligible to have produced a follow-on once it has had 24 months to do so. Counting
 *  a 3-month-old deal as a follow-on failure would understate every recently active fund. */
const MATURITY_MONTHS = 24;

export interface LiveInvestorMetrics {
  /** Rounds this investor participated in, across fintech companies in the app's database. */
  fintechDeals: number;
  /** Distinct African countries this investor has backed a company in. */
  africanCountries: number;
  /** Distinct reference-set (Tier 1) funds co-invested alongside on fintech deals. */
  refSetCoInvestors: number;
  followOnDenom: number;
  followOnNumer: number;
  followOnRate: number | null;
  gradDenom: number;
  gradNumer: number;
  gradRate: number | null;
  /** Per-country deal counts, used for the app's own country-relevance analysis. */
  dealsByCountry: Record<string, number>;
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

function parseDate(d: string | null): Date | null {
  if (!d) return null;
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function emptyMetrics(): LiveInvestorMetrics {
  return {
    fintechDeals: 0, africanCountries: 0, refSetCoInvestors: 0,
    followOnDenom: 0, followOnNumer: 0, followOnRate: null,
    gradDenom: 0, gradNumer: 0, gradRate: null,
    dealsByCountry: {},
  };
}

interface Accumulator {
  metrics: LiveInvestorMetrics;
  countries: Set<string>;
  coInvestors: Set<string>;
}

/**
 * Computes every deal-derived metric in the scoring framework directly from the app's own
 * company/round database -- including rounds the user has added or edited, since it reads
 * through resolveRounds() rather than the frozen ETL snapshot. This is what makes an investor
 * that never appeared in the scoring workbook scoreable: enter them on a round and their
 * metrics (and therefore their rating on every computed dimension) exist immediately.
 *
 * `refSetNames` is the reference set for Co-Investment Reputation -- the Tier 1 funds from the
 * scoring workbook. Co-investing alongside a recognised fund is the signal being measured, so
 * the set is deliberately the analyst's tiering rather than "any investor".
 */
export function buildInvestorMetricsIndex(
  companies: Company[],
  edits: EditsStore,
  refSetNames: Set<string>
): Map<string, LiveInvestorMetrics> {
  const acc = new Map<string, Accumulator>();

  const get = (key: string): Accumulator => {
    let a = acc.get(key);
    if (!a) {
      a = { metrics: emptyMetrics(), countries: new Set(), coInvestors: new Set() };
      acc.set(key, a);
    }
    return a;
  };

  for (const company of companies) {
    const rounds = resolveRounds(company, edits);
    if (rounds.length === 0) continue;

    // resolveRounds() already returns date-ascending order.
    const firstRoundIndexByInvestor = new Map<string, number>();
    rounds.forEach((round, idx) => {
      for (const raw of round.investors) {
        const key = normalizeInvestorName(raw);
        if (!key) continue;
        if (!firstRoundIndexByInvestor.has(key)) firstRoundIndexByInvestor.set(key, idx);

        const a = get(key);
        a.metrics.fintechDeals += 1;
        if (company.country) {
          a.countries.add(company.country);
          a.metrics.dealsByCountry[company.country] = (a.metrics.dealsByCountry[company.country] ?? 0) + 1;
        }
        for (const other of round.investors) {
          const otherKey = normalizeInvestorName(other);
          if (otherKey && otherKey !== key && refSetNames.has(otherKey)) a.coInvestors.add(otherKey);
        }
      }
    });

    // Follow-on and graduation are measured from each investor's FIRST round in this company,
    // and only once that round has had MATURITY_MONTHS to produce a follow-on.
    for (const [key, firstIdx] of firstRoundIndexByInvestor) {
      const firstRound = rounds[firstIdx];
      const firstDate = parseDate(firstRound.date);
      if (!firstDate || monthsBetween(firstDate, TODAY) < MATURITY_MONTHS) continue;

      const later = rounds.slice(firstIdx + 1);
      const a = get(key);

      a.metrics.followOnDenom += 1;
      const investedAgain = later.some((r) => r.investors.some((i) => normalizeInvestorName(i) === key));
      if (investedAgain) a.metrics.followOnNumer += 1;

      a.metrics.gradDenom += 1;
      const graduated = later.some((r) => SERIES_A_PLUS_TYPES.has(r.type ?? ''));
      if (graduated) a.metrics.gradNumer += 1;
    }
  }

  const out = new Map<string, LiveInvestorMetrics>();
  for (const [key, a] of acc) {
    a.metrics.africanCountries = a.countries.size;
    a.metrics.refSetCoInvestors = a.coInvestors.size;
    a.metrics.followOnRate = a.metrics.followOnDenom > 0 ? a.metrics.followOnNumer / a.metrics.followOnDenom : null;
    a.metrics.gradRate = a.metrics.gradDenom > 0 ? a.metrics.gradNumer / a.metrics.gradDenom : null;
    out.set(key, a.metrics);
  }
  return out;
}

export function emptyLiveMetrics(): LiveInvestorMetrics {
  return emptyMetrics();
}
