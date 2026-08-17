import type { Company, EditConfidence, Round, RoundRecord } from '../types';
import type { EditsStore } from './editStore';

/** User-facing round-type taxonomy. "M&A / Exit" is kept alongside the requested 11 options
 *  because company Status (Active/Acquired/...) depends on being able to tell an exit round
 *  apart from an "Other / Unknown" catch-all -- losing that signal would silently break Stage 3. */
export const ROUND_TYPE_OPTIONS = [
  'Pre-seed', 'Seed', 'Seed II', 'Pre-Series A', 'Series A', 'Series B', 'Series C+',
  'Venture Debt', 'Grant', 'Follow-on', 'M&A / Exit', 'Other / Unknown',
];

// Deliberately does NOT include "Pre-Series A" -- per spec, a Pre-Series A round is
// Seed-equivalent for funnel purposes (no Series A raised yet), even though it now displays
// as its own distinct label rather than being coarsened into "Seed". The actual round label
// and the funnel classification are separate concepts; only this set drives Stage 3.
export const SERIES_A_PLUS_TYPES = new Set(['Series A', 'Series B', 'Series C+']);
export const ACQUISITION_TYPES = new Set(['M&A / Exit']);

export const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'NGN', 'EGP', 'ZAR', 'KES', 'GHS'];

/** Maps a raw gold-sheet round type onto the user-facing taxonomy. Pre-Series A must NEVER
 *  fall into the Seed bucket -- the source data's classification is preserved and displayed
 *  as-is, exactly as named, even though it still counts as Seed-equivalent for the funnel
 *  (see SERIES_A_PLUS_TYPES above, which is untouched by this display mapping). */
function normalizeRoundType(raw: string | null): string {
  if (!raw) return 'Other / Unknown';
  const t = raw.toLowerCase();
  if (t.includes('pre-seed') || t.includes('pre seed')) return 'Pre-seed';
  if (t.includes('pre-series a') || t.includes('pre series a')) return 'Pre-Series A';
  if (t === 'seed') return 'Seed';
  if (t.includes('seed extension') || t.includes('bridge')) return 'Seed II';
  if (t === 'series a') return 'Series A';
  if (t.includes('series a extension')) return 'Follow-on';
  if (t === 'series b' || t.includes('pre-series b')) return 'Series B';
  if (t.startsWith('series c') || t.startsWith('series d') || t.startsWith('series e') || t.includes('series b2')) return 'Series C+';
  if (t === 'debt') return 'Venture Debt';
  if (t === 'grant') return 'Grant';
  if (t === 'm&a') return 'M&A / Exit';
  return 'Other / Unknown';
}

/** Maps a raw gold-sheet round onto the editable RoundRecord shape. Bracket-only amounts
 *  (no exact $M figure) are preserved in notes rather than dropped. sourceDataset/conflict
 *  come straight from the ETL's cross-dataset reconciliation (scripts/etl.py) -- a round
 *  merged from both the intake and 2019-2025 sheets carries both, and a genuine
 *  amount/type disagreement between the two is preserved rather than silently resolved. */
export function rawRoundToRecord(r: Round, id: string): RoundRecord {
  const bracketNote = r.amountUsdM == null && r.amountBracket ? `Amount bracket per source: ${r.amountBracket}` : '';
  return {
    id,
    type: normalizeRoundType(r.type),
    amount: r.amountUsdM ?? null,
    currency: 'USD',
    date: r.date || null,
    investors: r.investors,
    leadInvestor: r.investors[0] ?? null,
    sources: r.link ? [{ label: 'Gold sheet source', url: r.link }] : [],
    confidence: r.link && r.amountDisclosure ? 'High' : r.link ? 'Medium' : 'Low',
    notes: [r.comment, bracketNote].filter(Boolean).join(' — '),
    verified: true,
    status: 'active',
    sourceDataset: r.sourceDataset,
    conflict: r.conflict ?? null,
  };
}

export function originalRoundId(index: number): string {
  return `r${index}`;
}

/** The "automated/research" default for a round field -- either mapped from the gold sheet
 *  (existing round) or a blank shell with no research behind it (investor-added round). */
export function getRoundDefault(raw: Company, roundId: string): { value: RoundRecord | null; source: string } {
  const match = roundId.match(/^r(\d+)$/);
  if (match) {
    const idx = Number(match[1]);
    const r = raw.rounds[idx];
    if (r) return { value: rawRoundToRecord(r, roundId), source: 'Gold sheet — Africa: The Big Deal / deep research export' };
  }
  return { value: null, source: 'Investor-added — no automated research behind this round' };
}

function blankNewRound(id: string): RoundRecord {
  return {
    id,
    type: 'Seed',
    amount: null,
    currency: 'USD',
    date: null,
    investors: [],
    leadInvestor: null,
    sources: [],
    confidence: 'Medium',
    notes: '',
    verified: false,
    status: 'active',
  };
}

export function newRoundTemplate(id: string): RoundRecord {
  return blankNewRound(id);
}

/** All round ids that exist for this company: original gold-sheet rounds, plus any
 *  investor-added rounds discovered in the edit store (fieldPath `round:new-*`). */
export function allRoundIds(raw: Company, edits: EditsStore): string[] {
  const ids = raw.rounds.map((_, i) => originalRoundId(i));
  const companyEdits = edits[raw.id] ?? {};
  for (const path of Object.keys(companyEdits)) {
    const m = path.match(/^round:(new-.+)$/);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** Resolves every round (original + investor-added) to its current active RoundRecord,
 *  excluding ones marked removed. Reuses the exact same field-edit mechanism as every
 *  other editable field -- "round:<id>" is just another field path. */
export function resolveRounds(raw: Company, edits: EditsStore): RoundRecord[] {
  const ids = allRoundIds(raw, edits);
  const records: RoundRecord[] = [];
  for (const id of ids) {
    const path = `round:${id}`;
    const def = getRoundDefault(raw, id);
    const field = edits[raw.id]?.[path];
    const value = (field ? field.currentValue : def.value) as RoundRecord | null;
    if (value && value.status !== 'removed') records.push(value);
  }
  return records.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
}

/** True once the investor has touched at least one round (edit, add, or remove) on this
 *  company. Used to know when it's safe to stop trusting the ETL's frozen full-history
 *  classification (see getFieldDefault's hasSeriesA case) in favor of the live round list. */
export function hasAnyRoundEdits(raw: Company, edits: EditsStore): boolean {
  const companyEdits = edits[raw.id];
  if (!companyEdits) return false;
  return Object.keys(companyEdits).some((path) => path.startsWith('round:'));
}

export interface RoundsSummary {
  count: number;
  totalDisclosedUsdM: number;
  latest: RoundRecord | null;
}

/** Coerces to a finite number or 0 -- defends the summary math against a non-numeric
 *  amount slipping through (bad source data, a stray manual edit), so a single bad round
 *  can't crash the whole Rounds on Record summary via string concatenation. */
function safeAmount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function summarizeRounds(records: RoundRecord[]): RoundsSummary {
  const totalDisclosedUsdM = records.reduce((sum, r) => sum + safeAmount(r.amount), 0);
  const latest = records.length ? records[records.length - 1] : null;
  return { count: records.length, totalDisclosedUsdM, latest };
}

export interface InvestorSplit {
  current: string[];
  historical: string[];
}

/** Splits a company's investors into "current round syndicate" (backed the latest round on
 *  record) vs "historical investors" (backed only an earlier round) -- so an investor who
 *  only participated in a 2021 seed isn't displayed as if they're part of today's syndicate.
 *  Someone who appears in both buckets (backed the seed AND the latest round) counts as
 *  current, since they're still an active participant. */
export function splitCurrentVsHistoricalInvestors(activeRounds: RoundRecord[]): InvestorSplit {
  if (activeRounds.length === 0) return { current: [], historical: [] };
  const latest = activeRounds[activeRounds.length - 1];
  const currentSet = new Set(latest.investors);
  const historicalSet = new Set<string>();
  for (const r of activeRounds.slice(0, -1)) {
    for (const inv of r.investors) {
      if (!currentSet.has(inv)) historicalSet.add(inv);
    }
  }
  return { current: [...currentSet], historical: [...historicalSet] };
}

export function formatAmount(amount: number | null, currency: string): string {
  if (amount == null) return 'Undisclosed';
  return `$${amount}M ${currency !== 'USD' ? `(${currency})` : ''}`.trim();
}

export const EMPTY_CONFIDENCE: EditConfidence = 'Medium';
