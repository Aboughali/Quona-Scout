import { useEffect, useMemo, useState } from 'react';
import {
  CATEGORY_COLOR,
  NEWS_WINDOW_YEARS,
  findingsForCompany,
  loadNewsFindings,
  loadScanRuns,
  relativeTime,
  summarise,
  withinWindow,
  type NewsFinding,
  type ScanRunSummary,
} from '../lib/newsData';

/** How many articles the feed shows before "Show more" is needed. */
const COLLAPSED_COUNT = 3;

function fmtDate(iso: string | null): string {
  if (!iso) return 'unknown';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

/** The scan runs weekly, so the next pass is a week after the last one. Shown so the investor
 *  can tell at a glance whether they are looking at a fresh feed or a stale one. */
function nextScanDue(lastRun: ScanRunSummary | null): string | null {
  if (!lastRun?.finishedAt) return null;
  const due = new Date(new Date(lastRun.finishedAt).getTime() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(due.getTime())) return null;
  return due.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

/**
 * Thumbnail. Feeds that advertise a lead image get the real thing; everything else gets a
 * source monogram in the category's colour. Deliberately not a stock placeholder image -- an
 * invented picture next to a real headline is a small lie about the source.
 */
function Thumb({ finding }: { finding: NewsFinding }) {
  const [failed, setFailed] = useState(false);
  const tint = (finding.news_category && CATEGORY_COLOR[finding.news_category]) || 'var(--text-dim)';

  if (finding.image_url && !failed) {
    return (
      <img
        src={finding.image_url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className="w-[84px] h-[64px] shrink-0 rounded-md object-cover border border-[var(--border)]"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="w-[84px] h-[64px] shrink-0 rounded-md border border-[var(--border)] flex items-center justify-center"
      style={{ background: 'var(--bg-panel-2)' }}
    >
      <span className="text-base font-extrabold tracking-tight" style={{ color: tint }}>
        {(finding.source || '?').slice(0, 2).toUpperCase()}
      </span>
    </div>
  );
}

function NewsCard({ finding }: { finding: NewsFinding }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarise(finding.raw_content);
  const category = finding.news_category;

  return (
    <article className="py-3 border-b border-[var(--border)] last:border-b-0">
      <div className="flex gap-3 items-start">
        <div className="min-w-0 flex-1">
          {category && (
            <div
              className="text-[10px] font-semibold uppercase tracking-wide mb-0.5"
              style={{ color: CATEGORY_COLOR[category] ?? 'var(--text-dim)' }}
            >
              {category}
            </div>
          )}

          {finding.url ? (
            <a
              href={finding.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-[var(--text-h)] leading-snug hover:text-[var(--accent-ink)] block"
            >
              {finding.headline ?? '(untitled)'}
            </a>
          ) : (
            <span className="text-sm font-semibold text-[var(--text-h)] leading-snug block">
              {finding.headline ?? '(untitled)'}
            </span>
          )}

          {finding.funding_round_detected && (
            <p className="text-[11px] mt-1" style={{ color: 'var(--strong)' }}>
              Funding event: {finding.round_type ?? 'round type unstated'}
              {finding.funding_amount != null ? ` — $${finding.funding_amount}M` : ' — amount undisclosed'}
              {finding.investors?.length ? ` · ${finding.investors.join(', ')}` : ''}
            </p>
          )}
        </div>

        <Thumb finding={finding} />
      </div>

      <div className="flex items-center gap-2 mt-2 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
        <span className="font-semibold text-[var(--text)]">{finding.source}</span>
        <span>·</span>
        <span>{relativeTime(finding.published_date)}</span>
        {summary && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="ml-auto normal-case tracking-normal text-[11px] text-[var(--text-dim)] hover:text-[var(--accent-ink)]"
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
      </div>

      {expanded && summary && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-[var(--text)]">{summary}</p>
          <p className="text-[10px] text-[var(--text-dim)]">
            Published {fmtDate(finding.published_date)} · found by the scan on {fmtDate(finding.retrieved_date)}
            {finding.company_match_confidence != null
              ? ` · matched to this company with ${(finding.company_match_confidence * 100).toFixed(0)}% confidence`
              : ''}
          </p>
        </div>
      )}
    </article>
  );
}

/**
 * News & Intelligence for one company (brief Part 1).
 *
 * Shows every article the weekly scan has attached to this company over the last three years --
 * the same lookback the scanner itself uses. The three most recent are visible by default and
 * "Show more" reveals the full history, so a busy profile stays readable without hiding the
 * archive.
 *
 * Append-only by construction: it renders whatever the scan store currently holds, so a later
 * scan adds to the history rather than replacing it. Articles remain here permanently even once
 * their facts have been extracted into a funding round -- news and database records are
 * deliberately separate concepts (brief Part 10).
 */
export function CompanyNewsSection({ companyId }: { companyId: string }) {
  const [all, setAll] = useState<NewsFinding[] | null>(null);
  const [runs, setRuns] = useState<ScanRunSummary[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([loadNewsFindings(), loadScanRuns()]).then(([findings, scanRuns]) => {
      if (!alive) return;
      setAll(findings);
      setRuns(scanRuns);
    });
    return () => {
      alive = false;
    };
  }, []);

  const items = useMemo(
    () => (all ? withinWindow(findingsForCompany(all, companyId)) : []),
    [all, companyId]
  );

  const lastRun = runs.length ? runs[runs.length - 1] : null;
  const visible = showAll ? items : items.slice(0, COLLAPSED_COUNT);

  return (
    <section>
      {/* Header bar, matching the "Top News" panel convention: the feed reads as one object. */}
      <div className="rounded-t-md px-3 py-2 flex items-center justify-between" style={{ background: 'var(--text-h)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--bg)' }}>News</h3>
        <span className="text-[10px]" style={{ color: 'var(--bg-soft)', opacity: 0.75 }}>
          {items.length} article{items.length === 1 ? '' : 's'} · last {NEWS_WINDOW_YEARS} years
        </span>
      </div>

      <div className="border border-t-0 border-[var(--border)] rounded-b-md px-3">
        {all === null ? (
          <p className="text-xs text-[var(--text-dim)] py-3">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-[var(--text-dim)] py-3">
            No articles matched this company yet. The scan attaches an article only when the company match is
            high-confidence; weaker matches wait in Needs Review rather than being attached automatically.
          </p>
        ) : (
          <>
            {visible.map((f) => (
              <NewsCard key={f.finding_id} finding={f} />
            ))}

            {items.length > COLLAPSED_COUNT && (
              <button
                onClick={() => setShowAll((s) => !s)}
                className="w-full text-xs font-medium text-[var(--accent-ink)] py-2.5 border-t border-[var(--border)] hover:bg-[var(--bg-panel-2)]"
              >
                {showAll ? 'Show fewer' : `Show all ${items.length} articles`}
              </button>
            )}
          </>
        )}
      </div>

      <p className="text-[10px] text-[var(--text-dim)] mt-1.5">
        Updated weekly by the web scan
        {lastRun ? ` · last run ${fmtDate(lastRun.finishedAt)}` : ''}
        {nextScanDue(lastRun) ? ` · next due ${nextScanDue(lastRun)}` : ''}
      </p>
    </section>
  );
}
