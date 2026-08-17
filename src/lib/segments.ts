import type { Company } from '../types';
import { isAfricanCountry, MULTI_MARKET_THRESHOLD } from './fields';

/**
 * Segmentation used by the stage charts.
 *
 * Both segmentations are derived from the RESOLVED company, so they reflect investor edits
 * (operating countries, sector corrections, added rounds) exactly like the funnel does.
 */

const GEO_AUTO_PASS_COUNTRIES = new Set(['Egypt', 'South Africa']);

export const GEO_SEGMENTS = ['Egypt', 'South Africa', '3+ African markets', 'Single market'] as const;
export type GeoSegment = (typeof GEO_SEGMENTS)[number];

/**
 * Mirrors the Stage 4 geography test exactly: Egypt and South Africa auto-pass, everyone else
 * qualifies only on 3+ African markets. "Single market" is the residual -- it is shown rather
 * than hidden so the segments always sum to the stage count.
 */
export function classifyGeography(c: Company): GeoSegment {
  if (c.country && GEO_AUTO_PASS_COUNTRIES.has(c.country)) return c.country as GeoSegment;
  const african = (c.operatingCountries ?? []).filter(isAfricanCountry);
  if (african.length >= MULTI_MARKET_THRESHOLD) return '3+ African markets';
  // Companies promoted by the import's analyst 3+ markets judgment have no operatingCountries
  // list but did pass Stage 4 -- honour that rather than mislabelling them single-market.
  if (c.stage4?.pass) return '3+ African markets';
  return 'Single market';
}

export const FINTECH_SEGMENTS = [
  'Cross-border payments / FX',
  'Payment infrastructure',
  'Card issuing / BaaS',
  'SME & consumer lending',
  'Wealth / savings',
  'Insurance',
  'Fraud / risk infrastructure',
  'Other / unclassified',
] as const;
export type FintechSegment = (typeof FINTECH_SEGMENTS)[number];

/**
 * Keyword rules, evaluated IN ORDER -- a company matching several buckets is assigned to the
 * first, so the segments stay mutually exclusive and sum to the stage count. Order is chosen
 * so the more specific claim wins: "insurance" is tested before "lending" because insurers
 * describe themselves as underwriting, and cross-border is tested before general payments
 * because a remittance company is a payments company too but the narrower label is the useful one.
 */
const RULES: { segment: FintechSegment; re: RegExp }[] = [
  {
    segment: 'Cross-border payments / FX',
    re: /\b(cross[-\s]?border|remittance|money transfer|foreign exchange|\bfx\b|stablecoin|diaspora|multi[-\s]?currency|international payments?)\b/i,
  },
  {
    segment: 'Fraud / risk infrastructure',
    re: /\b(fraud|chargeback|\bkyc\b|\bkyb\b|\baml\b|anti[-\s]?money|identity verification|regtech|risk (?:engine|scoring|management)|compliance (?:platform|infrastructure)|due diligence)\b/i,
  },
  {
    segment: 'Insurance',
    re: /\b(insurance|insurtech|insurer|underwrit(?:e|ing) (?:policies|risk)|claims|premium[s]? (?:collection|payment))\b/i,
  },
  {
    segment: 'Card issuing / BaaS',
    re: /\b(card issuing|issue cards?|virtual cards?|corporate cards?|banking[-\s]as[-\s]a[-\s]service|\bbaas\b|embedded banking|spend management|expense management|neobank|digital bank)\b/i,
  },
  {
    segment: 'Wealth / savings',
    re: /\b(wealth|savings?|invest(?:ment|ing) (?:platform|app)|pension|asset management|wealthtech|money market|treasury management)\b/i,
  },
  {
    segment: 'SME & consumer lending',
    re: /\b(lend(?:ing|er)?|loans?|credit (?:to|for|access|scoring|line)|\bbnpl\b|buy now,? pay later|working capital|microfinance|financing|receivables|invoice financ)\b/i,
  },
  {
    segment: 'Payment infrastructure',
    re: /\b(payment[s]? (?:infrastructure|orchestration|gateway|processing|rails|enablement|platform)|merchant acquir|checkout|point[-\s]of[-\s]sale|\bpos\b|cash[-\s]?in|cash[-\s]?out|collections?|payment)\b/i,
  },
];

/**
 * Assigns a company to one fintech sub-sector. The explicit `fintechSubSector` field is tried
 * first because it is researched rather than inferred; only then does it fall back to the
 * business description. Non-fintech companies (the majority at Stage 1) land in
 * "Other / unclassified", which is honest -- they were never fintech to begin with.
 */
export function classifyFintechSegment(c: Company): FintechSegment {
  const explicit = (c.fintechSubSector ?? '').trim();
  if (explicit) {
    for (const rule of RULES) if (rule.re.test(explicit)) return rule.segment;
  }
  const haystack = `${explicit} ${c.description ?? ''} ${c.businessModel ?? ''}`;
  for (const rule of RULES) if (rule.re.test(haystack)) return rule.segment;
  return 'Other / unclassified';
}

export interface SegmentCount<T extends string> {
  label: T;
  count: number;
  share: number;
}

export function countBy<T extends string>(
  companies: Company[],
  labels: readonly T[],
  classify: (c: Company) => T
): SegmentCount<T>[] {
  const tally = new Map<T, number>(labels.map((l) => [l, 0]));
  for (const c of companies) {
    const key = classify(c);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const total = companies.length || 1;
  return labels.map((label) => {
    const count = tally.get(label) ?? 0;
    return { label, count, share: count / total };
  });
}
