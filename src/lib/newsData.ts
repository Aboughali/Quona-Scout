/**
 * Read-only access to the Phase 1/2 scan outputs.
 *
 * These files are written by the Node scan runner, not by the app, so they are FETCHED at
 * runtime rather than imported into the component tree: a scan can then refresh the UI without a
 * rebuild. Nothing here writes -- turning a signal into company data goes through the normal
 * editor mechanisms (addManualCompany / round field-edits), so the funnel and syndicate scoring
 * recompute exactly as they do for a manual entry.
 *
 * The URLs are produced by Vite's `?url` asset mechanism rather than being hard-coded to
 * `/src/data/...`. Under `npm run dev` this resolves to the source file (so a fresh scan is
 * still picked up on reload); under `vite build` each file is emitted into `dist/assets/` with a
 * content hash and the import resolves to that hashed path. This is what makes the news feed
 * work in the production build and on Netlify -- a bare `/src/data/...` fetch only exists while
 * the dev server is running and 404s in a static deploy.
 */
import newsFindingsUrl from '../data/news_findings.json?url';
import newsSignalsUrl from '../data/news_signals.json?url';
import scanRunsUrl from '../data/scan_runs.json?url';

export interface NewsFinding {
  finding_id: string;
  source: string;
  source_domain: string;
  url: string | null;
  published_date: string | null;
  retrieved_date: string | null;
  headline: string | null;
  /** Lead image from the source feed, when it advertises one. Display-only, and absent on any
   *  finding collected before the scanner started capturing it -- the UI falls back to a
   *  source monogram rather than a broken frame. */
  image_url?: string | null;
  raw_content: string;
  news_category: string | null;
  company_match: string | null;
  company_match_name: string | null;
  company_match_confidence: number | null;
  company_match_rationale: string | null;
  attached_company_id: string | null;
  extracted_company_name: string | null;
  funding_round_detected: boolean;
  round_type: string | null;
  funding_amount: number | null;
  currency: string | null;
  investors: string[];
  lead_investor: string | null;
  confidence: number | null;
  status: string;
}

export interface SignalSource {
  finding_id: string;
  source: string;
  url: string | null;
  headline: string | null;
  published_date: string | null;
  confidence: number;
}

export interface NewsSignal {
  signal_id: string;
  signal_type: 'existing-company-new-round' | 'new-company-discovered';
  company_key: string;
  company_id: string | null;
  company_name: string | null;
  company_match_confidence: number;
  company_match_rationale: string;
  round_type: string | null;
  funding_amount: number | null;
  currency: string;
  event_date: string | null;
  investors: string[];
  lead_investor: string | null;
  confidence: number;
  review_tier: 'high' | 'medium';
  source_count: number;
  status: 'pending' | 'approved' | 'ignored';
  sources: SignalSource[];
}

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return fallback;
    const data = await res.json();
    return Array.isArray(data) ? (data as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadNewsFindings(): Promise<NewsFinding[]> {
  return fetchJson<NewsFinding[]>(newsFindingsUrl, []);
}

export function loadNewsSignals(): Promise<NewsSignal[]> {
  return fetchJson<NewsSignal[]>(newsSignalsUrl, []);
}

/** One entry per scan, written by the runner. Read here purely so the news feed can say when
 *  it was last refreshed and when the next weekly pass is due. */
export interface ScanRunSummary {
  startedAt: string;
  finishedAt: string;
  trigger: string;
  findingsAdded: number;
}

export function loadScanRuns(): Promise<ScanRunSummary[]> {
  return fetchJson<ScanRunSummary[]>(scanRunsUrl, []);
}

/** The scan's own lookback window (config/news_sources.json -> defaults.lookbackDays = 1095).
 *  Applied again at render time so the profile shows three years of history even if the store
 *  still holds older findings from an earlier configuration. */
export const NEWS_WINDOW_YEARS = 3;

export function withinWindow(findings: NewsFinding[], years = NEWS_WINDOW_YEARS): NewsFinding[] {
  const cutoff = Date.now() - years * 365.25 * 24 * 60 * 60 * 1000;
  return findings.filter((f) => {
    // A finding with no publication date is kept: the scan only collects current articles, so
    // an unparsed date is a feed quirk rather than evidence the piece is old.
    if (!f.published_date) return true;
    const t = new Date(f.published_date).getTime();
    return Number.isNaN(t) || t >= cutoff;
  });
}

/** Compact age for a news card: "3h", "2d", then an absolute date once it stops being "recent". */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'date unknown';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'date unknown';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  if (mins < 60 * 24 * 7) return `${Math.round(mins / (60 * 24))}d`;
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Articles attached to one company, newest first. Attachment requires a high-confidence
 *  company match -- a weak match leaves the article in Needs Review instead of on the profile. */
export function findingsForCompany(findings: NewsFinding[], companyId: string): NewsFinding[] {
  return findings
    .filter((f) => f.attached_company_id === companyId)
    .sort((a, b) => (b.published_date ?? '').localeCompare(a.published_date ?? ''));
}

/** First two sentences of the article body -- a summary that is quoted, never generated, so it
 *  cannot introduce a claim the source did not make. */
export function summarise(text: string, maxChars = 260): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  let out = sentences ? sentences.slice(0, 2).join(' ').trim() : clean;
  if (out.length > maxChars) out = `${out.slice(0, maxChars).replace(/\s+\S*$/, '')}…`;
  return out;
}

export const CATEGORY_COLOR: Record<string, string> = {
  Funding: 'var(--strong)',
  'New investor': 'var(--strong)',
  Acquisition: 'var(--moderate)',
  Exit: 'var(--moderate)',
  Regulatory: 'var(--moderate)',
  'Leadership change': 'var(--text-dim)',
  Partnership: 'var(--text-dim)',
  Expansion: 'var(--text-dim)',
  'Product launch': 'var(--text-dim)',
  'Accelerator / cohort': 'var(--text-dim)',
  'Business model change': 'var(--text-dim)',
  'Other company news': 'var(--text-dim)',
};
