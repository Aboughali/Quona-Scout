/**
 * Wide web search via Apify -- for the sources an archive API cannot reach.
 *
 * WHY THIS EXISTS. archiveSearch.mjs covers every source that runs WordPress, which is most of
 * them, for free. Two configured sources are not reachable that way:
 *
 *   Wamda            not WordPress. No /wp-json, no /jsonapi, its /api/search returns nothing
 *                    and /sitemap.xml is a 500. Only its RSS window is fetchable, so its back
 *                    catalogue -- including Connect Money's $8m seed, June 2024 -- is invisible.
 *   TechAfrica News  runs WordPress but deliberately restricts the REST API
 *                    (itsec_rest_api_access_restricted). That restriction is respected.
 *
 * A search engine has already indexed those archives, so this asks it instead of crawling the
 * sites. Apify's Google Search Results Scraper is billed per search-results page, so one query
 * per company is a few tenths of a cent -- far cheaper than crawling a site with no search.
 *
 * The results are *candidates only*. They go through the same relevance guard and the same
 * staging -> verify -> promote pipeline as everything else, so nothing here can reach the live
 * store unreviewed, and search snippets can never masquerade as article text.
 */

import { runActor } from './apifyClient.mjs';

export const SEARCH_ACTOR = 'apify~google-search-scraper';

/**
 * Domains worth searching, because no archive API reaches them.
 *
 * Restricted to sources that actually publish news. The accelerator and fund portfolio pages in
 * the config (Y Combinator, 500 Global, Plug and Play, Partech) are directory listings rather
 * than reporting, and piling ten `site:` operators into one query degrades the results for the
 * outlets that matter.
 */
const NEWS_SOURCE_TYPES = new Set(['ecosystem-news', 'global-fintech-news', 'research-report']);

export function searchOnlySources(config) {
  return (config.sources || []).filter(
    (s) => s.enabled && s.domain && !s.archiveSearch?.endpoint && NEWS_SOURCE_TYPES.has(s.sourceType)
  );
}

/**
 * One query per company, restricted to the domains we cannot reach any other way.
 * Quoting the name keeps Google from wandering off to near-matches.
 */
export function buildQuery(companyName, domains) {
  const sites = domains.map((d) => `site:${d}`).join(' OR ');
  return `"${companyName}" (${sites})`;
}

/** Apify returns one item per search-results page; organic hits live inside it. */
function organicResultsOf(item) {
  if (Array.isArray(item?.organicResults)) return item.organicResults;
  if (Array.isArray(item?.results)) return item.results;
  return [];
}

/**
 * Index pages masquerade as hits: a search for "Connect Money" returns wamda.com/tag/Connect
 * Money, which carries the company name in its URL and would sail through the slug check while
 * being a listing rather than a story. Article URLs are what belongs in a news feed.
 */
const NON_ARTICLE_PATH =
  /\/(tag|tags|keyword|keywords|category|categories|author|authors|topic|topics|search|page|feed|about|contact|companies|company|portfolio|directory|listing|listings|jobs|job|profile|profiles)(\/|$)/i;

/**
 * Job boards and portfolio directories live on subdomains of otherwise legitimate sources
 * (portfoliojobs.partechpartners.com), so host matching alone lets them in.
 */
const NON_NEWS_HOST = /^(portfoliojobs|jobs|careers|shop|store|events)\./i;

export function looksLikeArticleUrl(url) {
  if (!url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (NON_NEWS_HOST.test(u.hostname)) return false;
  if (NON_ARTICLE_PATH.test(u.pathname)) return false;
  // A bare domain or a one-segment path is a section front, not an article.
  const segments = u.pathname.split('/').filter(Boolean);
  return segments.length >= 2;
}

/**
 * Runs the search actor for a batch of queries.
 *
 * @param {string} token           Apify token, supplied by the caller (never read from disk here)
 * @param {string[]} queries
 * @param {object} [options]
 * @param {number} [options.resultsPerPage]
 * @returns {Promise<Map<string, object[]>>} query -> normalized items, in the shape the rest of
 *          the pipeline expects (title/url/publishedAt/text), so findings built from a search
 *          are indistinguishable in structure from findings built from a feed.
 */
export async function runWebSearch(
  token,
  queries,
  { resultsPerPage = 10, timeoutSecs = 300, batchSize = 10, log = () => {} } = {}
) {
  if (!queries.length) return new Map();

  // Apify's run-sync endpoint holds the HTTP connection open for the whole run, so a single
  // batch of 50 queries outlives the socket and fails with a bare "fetch failed" -- observed
  // exactly that. Batching keeps each run short and means a failure costs one batch, not all of
  // them. The extra actor-start events are the price of not losing a whole sweep.
  const items = [];
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    log(`  search batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(queries.length / batchSize)} (${batch.length} queries)`);
    const batchItems = await runActor(
      token,
      SEARCH_ACTOR,
      {
        queries: batch.join('\n'),
        resultsPerPage,
        maxPagesPerQuery: 1,
        // Add-ons (AI overviews, ads, page scraping) are billed separately and are not wanted.
        saveHtml: false,
        saveHtmlToKeyValueStore: false,
        mobileResults: false,
      },
      { timeoutSecs }
    );
    items.push(...batchItems);
  }

  const byQuery = new Map();
  for (const item of items) {
    const term = item?.searchQuery?.term ?? item?.searchQuery ?? null;
    const results = organicResultsOf(item).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? null,
      // A search snippet is NOT article text. It is stored as the body so the finding has
      // something readable, but the relevance guard is told (via `snippetOnly`) not to treat
      // its length as evidence of sustained coverage.
      text: r.description ?? r.snippet ?? '',
      publishedAt: r.date ?? null,
      snippetOnly: true,
    })).filter((r) => looksLikeArticleUrl(r.url));
    if (term) byQuery.set(term, [...(byQuery.get(term) ?? []), ...results]);
  }
  return byQuery;
}

/** Which configured source a result URL belongs to, so the finding is attributed correctly. */
export function sourceForUrl(url, sources) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
  return sources.find((s) => {
    const d = String(s.domain).replace(/^www\./, '').toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  }) ?? null;
}
