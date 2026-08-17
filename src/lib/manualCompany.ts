import type { Company, RoundRecord } from '../types';
import { uid } from './editStore';

const GEO_AUTO_PASS_COUNTRIES = new Set(['Egypt', 'South Africa']);

/** Normalizes for duplicate-name matching: case, punctuation, and whitespace only -- mirrors
 *  scripts/etl.py's norm_company_name so "Honeycoin", "HoneyCoin", " honeycoin " all collide. */
export function normalizeCompanyNameForMatch(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Checks a candidate name against every company currently in the app (gold-sheet + any
 *  already manually-added) before creating a new one, per case brief section 5. */
export function findExistingCompany(name: string, companies: Company[]): Company | null {
  const target = normalizeCompanyNameForMatch(name);
  if (!target) return null;
  return companies.find((c) => normalizeCompanyNameForMatch(c.name) === target) ?? null;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface ManualRoundInput {
  type: string;
  amount: number | null;
  currency: string;
  date: string;
  investors: string[];
  leadInvestor: string;
  sourceUrl: string;
  notes: string;
}

export interface ManualCompanyInput {
  name: string;
  country: string;
  city: string;
  website: string;
  description: string;
  category: string; // "Fintech / financial-services category" -> fintechSubSector
  status: string;
  founders: string[];
  round: ManualRoundInput | null;
}

/** Builds a fully-shaped Company record for a manually-added company -- same interface every
 *  ETL-sourced company implements, so it flows through resolveCompany()/the funnel/the table
 *  with zero special-casing (case brief section 3: "should NOT be treated differently"). The
 *  funding round itself is deliberately NOT baked in here -- see buildInitialRoundRecord()
 *  below, which is applied as a `round:new-*` field edit right after creation, reusing the
 *  exact same mechanism as adding a round to any existing company. */
export function buildManualCompany(input: ManualCompanyInput, userName: string): Company {
  const now = new Date().toISOString();
  const id = `manual-${slugify(input.name) || 'company'}-${uid().slice(0, 6)}`;
  const country = input.country.trim() || null;
  const geoAutoPass = !!country && GEO_AUTO_PASS_COUNTRIES.has(country);
  const manualNote = 'Manual Entry — User Added';

  const stage2 = { pass: true, reason: `Category: ${input.category.trim() || 'Fintech'} (${manualNote})`, adjacentCandidate: false };
  const stage3 = { pass: true, reason: `No Series A or later round on record (${manualNote})` };
  const stage4 = {
    pass: geoAutoPass,
    reason: geoAutoPass
      ? `HQ/base = ${country} (auto-pass, ${manualNote})`
      : `HQ/base = ${country ?? 'unknown'}; no multi-market evidence found (${manualNote} — apply the 3+ markets override if applicable)`,
    autoPass: geoAutoPass,
    multiMarketSignal: false,
  };

  let cutStage: number | null = null;
  let cutReason: string | null = null;
  if (!stage4.pass) {
    cutStage = 4;
    cutReason = stage4.reason;
  }

  return {
    id,
    name: input.name.trim(),
    website: input.website.trim() || null,
    country,
    region: null,
    description: input.description.trim(),
    sector: 'Fintech',
    foundingYear: null,
    founders: input.founders,
    investors: input.round?.investors ?? [],
    rounds: [],
    latestRoundType: input.round?.type ?? null,
    sourceConfidence: input.round?.sourceUrl ? 'High' : 'Medium',
    city: input.city.trim(),
    status: input.status || 'Active',
    fintechSubSector: input.category.trim(),
    businessModel: '',
    operatingCountries: [],
    founderInfo: '',
    isManuallyAdded: true,
    addedAt: now,
    addedBy: userName,
    stage1: { pass: true, reason: `Added manually by ${userName} on ${new Date(now).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}` },
    stage2,
    stage3,
    stage4,
    stage5: { pass: null, reason: 'Pending syndicate research' },
    overrides: {
      seriesAReclass: { active: false, note: '' },
      geography3Markets: { active: false, note: '' },
      fintechPivot: { active: false, note: '' },
      syndicateJudgment: { active: false, note: '' },
    },
    cutStage,
    cutReason,
  };
}

/** Converts the optional funding-round section of the form into the same RoundRecord shape
 *  produced by the existing "+ Add Round" flow, so it can be applied via the identical
 *  overrideField('round:new-<id>', ...) call used everywhere else -- see AddCompanyModal. */
export function buildInitialRoundRecord(round: ManualRoundInput): { id: string; record: RoundRecord } {
  const id = `new-${uid()}`;
  return {
    id,
    record: {
      id,
      type: round.type,
      amount: round.amount,
      currency: round.currency || 'USD',
      date: round.date || null,
      investors: round.investors,
      leadInvestor: round.leadInvestor.trim() || null,
      sources: round.sourceUrl.trim() ? [{ label: 'Investor-provided source', url: round.sourceUrl.trim() }] : [],
      confidence: round.sourceUrl.trim() ? 'High' : 'Medium',
      notes: round.notes.trim(),
      verified: false,
      status: 'active',
    },
  };
}
