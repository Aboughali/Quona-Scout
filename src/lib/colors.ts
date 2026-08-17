export const CONFIDENCE_COLOR: Record<string, string> = {
  High: 'var(--strong)',
  Medium: 'var(--moderate)',
  Low: 'var(--weak)',
};

export const TIER_COLOR: Record<string, string> = {
  Strong: 'var(--strong)',
  Moderate: 'var(--moderate)',
  Weak: 'var(--weak)',
  Unscored: 'var(--unscored)',
};

/** The date the gold sheet was last pulled through the ETL pipeline -- shown as
 *  "last verified" for any value that has never been touched by an investor edit. */
export const DATA_BUILD_DATE = 'Aug 13, 2026';
