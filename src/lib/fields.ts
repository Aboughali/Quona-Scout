import type { Company } from '../types';
import type { EditsStore } from './editStore';
import { ACQUISITION_TYPES, SERIES_A_PLUS_TYPES, hasAnyRoundEdits, resolveRounds } from './rounds';

export const SOURCE_GOLD_SHEET = 'Gold sheet — Africa: The Big Deal / deep research export';

/** The geography test's bar, per the funnel spec: 3+ African markets. */
export const MULTI_MARKET_THRESHOLD = 3;

/** African countries, for counting how many of a company's operating markets are in-region.
 *  A company operating in Guinea, Senegal, Mali and France has three African markets, not four. */
const AFRICAN_COUNTRIES = new Set(
  [
    'algeria', 'angola', 'benin', 'botswana', 'burkina faso', 'burundi', 'cameroon', 'cape verde',
    'central african republic', 'chad', 'comoros', 'congo', 'democratic republic of congo', 'drc',
    'djibouti', 'egypt', 'equatorial guinea', 'eritrea', 'eswatini', 'ethiopia', 'gabon', 'gambia',
    'ghana', 'guinea', 'guinea-bissau', 'ivory coast', "côte d'ivoire", "cote d'ivoire", 'kenya',
    'lesotho', 'liberia', 'libya', 'madagascar', 'malawi', 'mali', 'mauritania', 'mauritius',
    'morocco', 'mozambique', 'namibia', 'niger', 'nigeria', 'rwanda', 'senegal', 'seychelles',
    'sierra leone', 'somalia', 'south africa', 'south sudan', 'sudan', 'tanzania', 'togo',
    'tunisia', 'uganda', 'zambia', 'zimbabwe',
  ].map((c) => c.toLowerCase())
);

export function isAfricanCountry(name: string): boolean {
  return AFRICAN_COUNTRIES.has(String(name).trim().toLowerCase());
}

/** Current value of a field, honouring any investor edit. Mirrors resolve.ts's helper so a
 *  derived classification reads the same value the rest of the app is showing. */
function currentValueOf(edits: EditsStore, companyId: string, path: string, fallback: unknown): unknown {
  const field = edits[companyId]?.[path];
  return field ? field.currentValue : fallback;
}

export interface FieldDefault {
  value: unknown;
  source: string;
}

function manualSourceLabel(raw: Company): string {
  const when = raw.addedAt ? new Date(raw.addedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
  return `Manual Entry — User Added${when ? ` (${when})` : ''}${raw.addedBy ? ` by ${raw.addedBy}` : ''}`;
}

/** Single source of truth for what a field's "original / automated" value and source are.
 *  Most fields derive purely from the static ETL output; `classifications.hasSeriesA` and
 *  `status` are the two exceptions -- they must reflect the CURRENT resolved round list
 *  (including any round edits/additions/removals), which is why `edits` is threaded through
 *  here rather than only used in resolve.ts. This keeps the classification editor and the
 *  actual funnel computation from ever disagreeing about what "automated" means.
 *
 *  For a company created via "+ Add Company" (raw.isManuallyAdded), the profile fields have
 *  no gold-sheet baseline to report -- their "automated" source is the investor themselves,
 *  labeled "Manual Entry" rather than the gold sheet, per case brief section 3/19. */
export function getFieldDefault(raw: Company, path: string, edits: EditsStore = {}): FieldDefault {
  if (raw.isManuallyAdded) {
    const manualSource = manualSourceLabel(raw);
    switch (path) {
      case 'name':
        return { value: raw.name, source: manualSource };
      case 'website':
        return { value: raw.website, source: manualSource };
      case 'country':
        return { value: raw.country, source: manualSource };
      case 'city':
        return { value: raw.city ?? '', source: manualSource };
      case 'description':
        return { value: raw.description, source: manualSource };
      case 'foundingYear':
        return { value: raw.foundingYear, source: manualSource };
      case 'founders':
        return { value: raw.founders, source: manualSource };
      case 'sector':
        return { value: raw.sector, source: manualSource };
      case 'status':
        return { value: raw.status ?? 'Active', source: manualSource };
      // 'investors' deliberately falls through to the shared rounds-derived logic below --
      // a manually-added company's investor list should auto-track its rounds exactly like
      // every other company's does (case brief Part 6/23/27).
      case 'fintechSubSector':
        return { value: raw.fintechSubSector ?? '', source: manualSource };
      case 'businessModel':
        return { value: raw.businessModel ?? '', source: manualSource };
      // Classification fields (fintech/hasSeriesA/multiMarket) and everything else fall
      // through to the normal logic below -- their reasons already read from raw.stage2/3/4,
      // which lib/manualCompany.ts composes with "Manual Entry" language at creation time.
    }
  }
  switch (path) {
    case 'name':
      return { value: raw.name, source: SOURCE_GOLD_SHEET };
    case 'website':
      return { value: raw.website, source: SOURCE_GOLD_SHEET };
    case 'country':
      return { value: raw.country, source: SOURCE_GOLD_SHEET };
    case 'city':
      return { value: raw.city ?? '', source: 'Not yet researched' };
    case 'operatingCountries':
      return { value: [], source: 'Not yet researched' };
    case 'foundingYear':
      return { value: raw.foundingYear, source: raw.foundingYear ? SOURCE_GOLD_SHEET : 'Not yet researched' };
    case 'founders':
      return { value: raw.founders, source: raw.founders.length ? SOURCE_GOLD_SHEET : 'Not yet researched' };
    case 'founderInfo':
      return { value: '', source: 'Not yet researched' };
    case 'description':
      return { value: raw.description, source: SOURCE_GOLD_SHEET };
    case 'sector':
      return { value: raw.sector, source: SOURCE_GOLD_SHEET };
    case 'fintechSubSector':
      return { value: '', source: 'Not yet researched' };
    case 'businessModel':
      return { value: '', source: 'Not yet researched' };
    case 'status': {
      const activeRounds = resolveRounds(raw, edits);
      const acqRound = activeRounds.find((r) => ACQUISITION_TYPES.has(r.type ?? ''));
      if (acqRound) {
        return { value: 'Acquired', source: `Derived: ${acqRound.type} round on record (${acqRound.date ?? 'date unknown'})` };
      }
      return { value: 'Active', source: 'Derived: no exit/shutdown round on record' };
    }
    case 'investors': {
      // Derived live from the current round list (original + edits + additions, minus
      // removed) rather than the frozen ETL snapshot, so adding/editing/removing an investor
      // on ANY round automatically updates the syndicate with zero separate "sync" step --
      // case brief Part 6/23/27. Lossless for ETL companies: raw.investors was itself only
      // ever the union of raw.rounds' investors to begin with (see scripts/etl.py), so this
      // changes nothing until a round is actually touched. An investor manually added via
      // "+ Add Investor" independent of any round survives via the normal override mechanism
      // (overrideField on this same path), which always wins over this computed default.
      const activeRounds = resolveRounds(raw, edits);
      const fromRounds = new Set<string>();
      for (const r of activeRounds) for (const inv of r.investors) fromRounds.add(inv);
      return {
        value: [...fromRounds].sort(),
        source: activeRounds.length ? 'Derived from rounds on record' : SOURCE_GOLD_SHEET,
      };
    }
    case 'classifications.fintech': {
      // If the investor has corrected the Sector field, that correction drives the fintech
      // gate -- same principle as operating countries driving geography. Until Sector is
      // touched, the ETL's frozen judgment stands (it carries the analyst's fintech-adjacent
      // promotions, which a naive sector string check would throw away).
      const sectorEdit = edits[raw.id]?.['sector'];
      if (sectorEdit?.isOverridden) {
        const sector = String(sectorEdit.currentValue ?? '').trim();
        const isFintech = /fintech|financial/i.test(sector);
        return {
          value: isFintech,
          source: `Derived from Sector = "${sector}" (investor-corrected)`,
        };
      }
      return {
        value: !!raw.stage2.pass,
        source: raw.overrides?.fintechPivot?.active
          ? `${raw.stage2.reason} — ETL judgment pass: ${raw.overrides.fintechPivot.note}`
          : raw.stage2.reason,
      };
    }
    case 'classifications.hasSeriesA': {
      const activeRounds = resolveRounds(raw, edits);
      const seriesARound = activeRounds.find((r) => SERIES_A_PLUS_TYPES.has(r.type ?? ''));
      if (seriesARound) {
        return { value: true, source: `Derived from rounds on record: ${seriesARound.type} — ${seriesARound.date ?? 'date unknown'}` };
      }
      // The gold sheet's ETL pass checked full deal history (including rounds outside the
      // Aug 2023-Aug 2026 window that aren't represented in Rounds on Record above) for a
      // Series A+ signal. Keep trusting that frozen result until the investor actually
      // touches this company's rounds -- otherwise a company with an out-of-window Series A
      // would silently re-enter the funnel just because its visible rounds look clean.
      const windowAcquired = activeRounds.some((r) => ACQUISITION_TYPES.has(r.type ?? ''));
      if (!hasAnyRoundEdits(raw, edits) && !raw.stage3.pass && !windowAcquired) {
        return { value: true, source: `${raw.stage3.reason} (from full deal history, including rounds outside the window shown above)` };
      }
      return { value: false, source: 'Derived from rounds on record: no Series A or later round found' };
    }
    case 'classifications.multiMarket': {
      // Derived live from the Operating countries field, exactly as hasSeriesA is derived from
      // the round list: edit the evidence and the classification follows, without the investor
      // having to remember to flip this flag by hand as well.
      const operating = (currentValueOf(edits, raw.id, 'operatingCountries', []) as string[]) ?? [];
      const african = operating.filter(isAfricanCountry);
      if (african.length >= MULTI_MARKET_THRESHOLD) {
        return {
          value: true,
          source: `Derived from operating countries: ${african.length} African markets on record (${african.join(', ')})`,
        };
      }
      if (operating.length > 0) {
        // The investor has supplied countries but they don't clear the bar -- say so explicitly
        // rather than silently falling back to the stale ETL reason.
        return {
          value: false,
          source: `Derived from operating countries: ${african.length} African market${african.length === 1 ? '' : 's'} on record (${MULTI_MARKET_THRESHOLD}+ required)`,
        };
      }
      // Nothing recorded yet -- keep trusting the ETL's frozen judgment, including any
      // analyst 3+ markets promotion applied during the import pass.
      return {
        value: !!raw.stage4.pass && !raw.stage4.autoPass,
        source: raw.overrides?.geography3Markets?.active
          ? `${raw.stage4.reason} — ETL judgment pass: ${raw.overrides.geography3Markets.note}`
          : raw.stage4.reason,
      };
    }
    default:
      return { value: null, source: 'Unknown field' };
  }
}

export type FieldType = 'text' | 'textarea' | 'url' | 'number' | 'list' | 'date' | 'select';

export interface FieldDef {
  path: string;
  label: string;
  type: FieldType;
  section: 'Profile' | 'Classification' | 'Funding' | 'Investors';
  options?: string[];
  placeholder?: string;
}

export const STATUS_OPTIONS = ['Active', 'Acquired', 'Shutdown', 'Gone Quiet', 'Unknown'];

export const FIELD_REGISTRY: FieldDef[] = [
  { path: 'name', label: 'Company name', type: 'text', section: 'Profile' },
  { path: 'website', label: 'Website', type: 'url', section: 'Profile' },
  { path: 'country', label: 'Country / HQ', type: 'text', section: 'Profile' },
  { path: 'city', label: 'City', type: 'text', section: 'Profile' },
  { path: 'operatingCountries', label: 'Operating countries / African markets', type: 'list', section: 'Profile', placeholder: 'e.g. Nigeria, Kenya, Ghana' },
  { path: 'foundingYear', label: 'Founding year', type: 'number', section: 'Profile' },
  { path: 'founders', label: 'Founders', type: 'list', section: 'Profile', placeholder: 'Founder full name' },
  { path: 'founderInfo', label: 'Founder information', type: 'textarea', section: 'Profile', placeholder: 'Background, prior companies, notes from meetings...' },
  { path: 'description', label: 'Business description', type: 'textarea', section: 'Profile' },
  { path: 'fintechSubSector', label: 'Fintech sub-sector', type: 'text', section: 'Classification', placeholder: 'e.g. embedded lending, trade finance' },
  { path: 'businessModel', label: 'Business model', type: 'textarea', section: 'Classification', placeholder: 'Revenue model, unit economics notes...' },
  { path: 'status', label: 'Company status', type: 'select', section: 'Classification', options: STATUS_OPTIONS },
  { path: 'investors', label: 'Investors', type: 'list', section: 'Investors', placeholder: 'Fund or investor name' },
];

export interface ClassificationDef {
  path: string;
  label: string;
  hint: string;
}

export const CLASSIFICATION_REGISTRY: ClassificationDef[] = [
  { path: 'classifications.fintech', label: 'Fintech?', hint: 'Drives Stage 2 — sector or fintech-adjacent classification.' },
  { path: 'classifications.hasSeriesA', label: 'Series A (or later) raised?', hint: 'Drives Stage 3 — Yes excludes the company from the pre-Series-A funnel.' },
  { path: 'classifications.multiMarket', label: '3+ African markets?', hint: 'Drives Stage 4 for companies outside Egypt/South Africa.' },
  { path: 'classifications.strongSyndicate', label: 'Strong syndicate?', hint: 'Drives Stage 5 — the binary qualitative gate, independent of the 0-100 scoring engine.' },
];
