/** Which gold-sheet tab a round's data came from. "Both" means the same round was found
 *  in both tabs and merged rather than duplicated -- see scripts/etl.py's merge passes. */
export type RoundSourceDataset = '2023-2026 Intake Dataset' | 'Deals 2019-2025' | 'Both (2023-2026 Intake Dataset + Deals 2019-2025)';

export interface RoundConflict {
  field: 'amountUsdM' | 'type';
  values: { value: unknown; source: string }[];
}

export interface Round {
  date: string;
  type: string | null;
  amountBracket: string | null;
  amountUsdM: number | null;
  amountDisclosure: string | null;
  valuationUsdM: number | null;
  estimatedValuationUsdM: number | null;
  investors: string[];
  link: string | null;
  comment: string | null;
  sourceDataset?: RoundSourceDataset;
  conflict?: RoundConflict | null;
}

/** A fully editable funding round record -- the unit the Investor Judgment system operates on.
 *  For rounds sourced from the gold sheet, this is derived from `Round` (see roundsToRecord in
 *  lib/rounds.ts); for investor-added rounds it exists only as an edit-store entry. */
export interface RoundRecord {
  id: string;
  type: string | null;
  amount: number | null;
  currency: string;
  date: string | null;
  investors: string[];
  leadInvestor: string | null;
  sources: { label: string; url?: string }[];
  confidence: EditConfidence;
  notes: string;
  verified: boolean;
  status: 'active' | 'removed';
  sourceDataset?: RoundSourceDataset;
  conflict?: RoundConflict | null;
}

export interface StageResult {
  pass: boolean | null;
  reason: string;
  [key: string]: unknown;
}

export interface Override {
  active: boolean;
  note: string;
  /** Optional direction for a seed-baked judgment, currently honored only by
   *  overrides.syndicateJudgment (see lib/resolve.ts): value:false REJECTS a syndicate the
   *  automated Stage-5 gate would otherwise pass, while true/undefined CONFIRMS one it misses.
   *  The other override slots are one-directional promotions and leave this unset. */
  value?: boolean;
}

export interface Overrides {
  seriesAReclass: Override;
  geography3Markets: Override;
  fintechPivot: Override;
  syndicateJudgment: Override;
}

export interface Company {
  id: string;
  name: string;
  website: string | null;
  country: string | null;
  region: string | null;
  description: string;
  sector: string | null;
  foundingYear: number | null;
  founders: string[];
  investors: string[];
  rounds: Round[];
  latestRoundType: string | null;
  sourceConfidence: 'High' | 'Medium' | 'Low';
  // The fields below only exist on a *resolved* company (see lib/resolve.ts) --
  // they are computed from investor edits and have no raw-JSON equivalent, EXCEPT for a
  // manually-added company (see lib/manualCompany.ts), which sets them directly at creation
  // since there's no ETL baseline underneath it to derive them from.
  operatingCountries?: string[];
  founderInfo?: string;
  fintechSubSector?: string;
  businessModel?: string;
  status?: string;
  city?: string;
  /** True only for a company created via "+ Add Company" -- never set by the ETL. Drives
   *  getFieldDefault() to report "Manual Entry" as the source instead of the gold sheet. */
  isManuallyAdded?: boolean;
  addedAt?: string;
  addedBy?: string;
  stage1: StageResult;
  stage2: StageResult & { adjacentCandidate: boolean };
  stage3: StageResult;
  stage4: StageResult & { autoPass: boolean; multiMarketSignal: boolean };
  /** Stage 5 = Syndicate Check, the final gate before the watchlist. This was Stage 6 until
   *  the redundant "Output Checkpoint" stage (which selected the same set as Stage 4) was
   *  removed; see STAGES in lib/funnel.ts. */
  stage5: { pass: boolean | null; reason: string; qualifyingInvestor?: string };
  overrides: Overrides;
  cutStage: number | null;
  cutReason: string | null;
}

// ---- Investor Judgment / Edit system ----

export type EditConfidence = 'High' | 'Medium' | 'Low';

export interface SourceEntry {
  id: string;
  label: string;
  url?: string;
  confidence: EditConfidence;
  addedBy: string;
  addedAt: string;
}

export interface FieldEditEntry {
  id: string;
  timestamp: string;
  user: string;
  kind: 'override' | 'revert' | 'source-added';
  previousValue: unknown;
  newValue: unknown;
  reason: string;
  source: string;
  evidenceUrl?: string;
  confidence?: EditConfidence;
}

export interface FieldState {
  fieldPath: string;
  originalValue: unknown;
  originalSource: string;
  currentValue: unknown;
  isOverridden: boolean;
  sources: SourceEntry[];
  history: FieldEditEntry[];
}

export type CompanyFieldStates = Record<string, FieldState>;

export interface CommentaryNote {
  id: string;
  date: string;
  type: 'Meeting notes' | 'Founder comment' | 'Investor comment' | 'Email note' | 'Research note' | 'Internal thought' | 'Follow-up' | 'Question to investigate';
  author: string;
  text: string;
  nextAction?: string;
  source?: string;
}

export interface DimensionScore {
  rating: number | null; // 1-5
  evidence: string | null;
  source: string | null;
}

export interface Fund {
  name: string;
  hq: string | null;
  presenceCountries: string[];
  panAfrican: boolean;
  vintageYear: number | null;
  fundSizeUsdM: number | null;
  /** True if this fund exists only because an investor created it inline (not in funds.json). */
  investorCreated?: boolean;
  /** Dimension keys the user has explicitly overridden IN THE APP (via the edit store).
   *  Populated by resolveFund(). Distinct from dimensions that merely carry a researched
   *  value in funds.json -- without this, static research data reads as a user override. */
  investorOverriddenDimensions?: string[];
  /** Manual override of the whole fund-level score, set in the app. Outranks the Excel
   *  workbook score and every computed value, and survives every import/refresh/rebuild
   *  because it lives in the persisted edit store, not in any imported data file. */
  fundLevelScoreOverride?: number | null;
  investorType?: string;
  dimensions: {
    /** Normally computed from presenceCountries/companyCountry (see scoring.ts) -- only
     *  populated here when an investor has explicitly overridden the computed rating. */
    localCountryPresence?: DimensionScore;
    /** Normally computed from vintageYear (see scoring.ts) -- only populated here when an
     *  investor has explicitly overridden the computed rating. */
    seriesAFollowOnCapacity?: DimensionScore;
    fintechPortfolioDepth: DimensionScore;
    coInvestmentReputation: DimensionScore;
    africanMarketExpertise: DimensionScore;
    globalCrossBorderNetwork: DimensionScore;
    operationalSupportBench: DimensionScore;
    regulatoryGovRelationships: DimensionScore;
    historicalInvestmentOutcomes: DimensionScore;
  };
  notes?: string;
}
