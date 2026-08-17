import type { Company, Fund } from '../types';
import type { LiveInvestorMetrics } from './investorMetrics';
import { passesBinarySyndicateGate, scoreFundForCompany } from './scoring';

/** Investor-name (normalized) -> deal-derived metrics computed from the live database.
 *  Optional throughout: when absent, scoring falls back to the workbook's own metrics, so
 *  every call site keeps working while the index is threaded through from App.tsx. */
export type MetricsIndex = Map<string, LiveInvestorMetrics>;

/** The funnel is five stages. The former Stage 5 "Output Checkpoint" was removed because it
 *  selected exactly the same set as Stage 4 (it was defined as stage2 && stage3 && stage4),
 *  so it was a second name for the same checkpoint rather than a filter. The syndicate gate
 *  that used to be Stage 6 is now Stage 5, and the final watchlist falls out of it. */
export const STAGES = [
  { n: 1, label: 'All Raised', short: 'Stage 1' },
  { n: 2, label: 'Fintech Filter', short: 'Stage 2' },
  { n: 3, label: 'Stage Check', short: 'Stage 3' },
  { n: 4, label: 'Geography Check', short: 'Stage 4' },
  { n: 5, label: 'Syndicate Check', short: 'Stage 5' },
] as const;

/** The syndicate check's stage number, so callers never hard-code it again. */
export const SYNDICATE_STAGE = 5;

/** Passed every content gate -- fintech, stage, geography -- and is therefore eligible to be
 *  assessed by the syndicate check. This is what the removed "Output Checkpoint" meant; it is
 *  kept as a named predicate because the Review Queue legitimately needs "made it past the
 *  content filters" as a concept, just not as a funnel stage of its own. */
export function passedContentGates(company: Company): boolean {
  return !!company.stage2.pass && !!company.stage3.pass && !!company.stage4.pass;
}

export function normalizeInvestorName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface SyndicateGateResult {
  pass: boolean;
  qualifyingInvestor: string | null;
  perInvestor: { investor: string; hasFundProfile: boolean; pass: boolean; reasons: string[] }[];
}

/** Pure binary syndicate gate from investors + fund data only -- no investor-judgment override applied.
 *  This is the "Automated" side shown in the edit UI; resolveCompany() combines it with any active
 *  classifications.strongSyndicate override to produce the company's actual stage5.pass. */
export function computeSyndicateGate(company: Company, fundIndex: Map<string, Fund>, metricsIndex?: MetricsIndex): SyndicateGateResult {
  const perInvestor = company.investors.map((inv) => {
    const fund = fundIndex.get(normalizeInvestorName(inv));
    if (!fund) return { investor: inv, hasFundProfile: false, pass: false, reasons: ['No fund profile researched'] };
    const gate = passesBinarySyndicateGate(fund, company.country, metricsIndex?.get(normalizeInvestorName(inv)));
    return { investor: inv, hasFundProfile: true, pass: gate.pass, reasons: gate.reasons };
  });
  const qualifying = perInvestor.find((p) => p.pass);
  return { pass: !!qualifying, qualifyingInvestor: qualifying?.investor ?? null, perInvestor };
}

/** Company is "active" (still in the running) at a given stage view if it passed every stage up to and
 *  including N. Reads stage pass flags directly off the (already-resolved) company -- resolveCompany()
 *  is responsible for baking investor-judgment overrides into stage2-5 before this is called. */
export function isActiveAtStage(company: Company, stageN: number): boolean {
  if (stageN >= 2 && !company.stage2.pass) return false;
  if (stageN >= 3 && !company.stage3.pass) return false;
  if (stageN >= 4 && !company.stage4.pass) return false;
  if (stageN >= SYNDICATE_STAGE && !company.stage5.pass) return false;
  return true;
}

/** The stage at which a resolved company was cut. Null if still active through Stage 5, which
 *  is the final watchlist. */
export function effectiveCutStage(company: Company): { stage: number | null; reason: string | null } {
  if (company.cutStage) return { stage: company.cutStage, reason: company.cutReason };
  if (passedContentGates(company) && !company.stage5.pass) {
    return { stage: SYNDICATE_STAGE, reason: company.stage5.reason || 'No named investor met the binary syndicate-strength rubric' };
  }
  return { stage: null, reason: null };
}

export function stageCounts(companies: Company[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const s of STAGES) {
    counts[s.n] = companies.filter((c) => isActiveAtStage(c, s.n)).length;
  }
  return counts;
}

export function scoreCompanySyndicate(company: Company, fundIndex: Map<string, Fund>, metricsIndex?: MetricsIndex) {
  let best: { investor: string; score: number; completeness: string; tier: string } | null = null;
  for (const inv of company.investors) {
    const key = normalizeInvestorName(inv);
    const fund = fundIndex.get(key);
    if (!fund) continue;
    const s = scoreFundForCompany(fund, company.country, metricsIndex?.get(key));
    if (s.score !== null && (best === null || s.score > best.score)) {
      best = { investor: inv, score: s.score, completeness: s.completeness, tier: s.tier };
    }
  }
  return best;
}
