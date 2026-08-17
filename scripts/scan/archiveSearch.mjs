/**
 * Archive search -- reaching PAST the RSS window.
 *
 * WHY THIS EXISTS. An RSS feed only publishes the newest handful of posts: techcabal.com/feed
 * returns 10 items covering about a day. So the weekly feed scan can only ever see this week's
 * news, and `lookbackDays: 1095` filters articles it already fetched rather than reaching back
 * three years. A company that raised in January 2025 was never retrievable, which is why
 * profiles showed an empty news feed while the source site had the story all along.
 *
 * Most of the configured outlets run WordPress, which exposes its full archive as a documented
 * public JSON API at /wp-json/wp/v2/posts -- the same content the RSS reader already consumes,
 * with a `search` parameter and no window limit. That turns "three years of history" from an
 * aspiration into a fetch.
 *
 * ACCESS POLICY (same rule the rest of the scanner follows): this uses each site's own public,
 * documented API under the User-agent it identifies itself with. Sources that restrict the
 * endpoint (TechAfrica News answers `itsec_rest_api_access_restricted`) are simply not
 * configured for archive search -- the restriction is respected, never worked around.
 */

const USER_AGENT = 'QuonaScout/1.0 (+sourcing-research; contact via repository owner) Node fetch';

/** Politeness gap between requests to the same host. */
export const REQUEST_DELAY_MS = 350;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
    .replace(/&amp;/g, '&'); // last, so it cannot double-decode the entities above
}

function stripTags(html = '') {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** WordPress puts the lead image in the rendered body; taking it from there costs no extra
 *  request, unlike expanding the featured-media relation. */
function firstImage(html = '') {
  const m = html.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : null;
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) {
      // WordPress reports its own errors as an object -- surface the site's own words.
      throw new Error(body?.message ? stripTags(body.message) : 'unexpected response shape');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function toItem(post) {
  const bodyHtml = post.content?.rendered ?? '';
  const excerptHtml = post.excerpt?.rendered ?? '';
  return {
    title: stripTags(post.title?.rendered ?? ''),
    url: post.link ?? null,
    publishedAt: post.date ?? null,
    text: stripTags(bodyHtml || excerptHtml),
    imageUrl: firstImage(bodyHtml),
  };
}

/**
 * Archive search for one company name, in two phases.
 *
 * WHY TWO PHASES. Article bodies dominate the response: 100 posts with `content.rendered` is
 * ~1.4MB, against ~60KB for the same posts without it. Sweeping 800 companies across 8 archives
 * in one phase would pull several gigabytes off publishers who are giving this away for free.
 * So phase 1 asks only for titles and excerpts, and phase 2 fetches full bodies for the handful
 * of posts that actually look like the company -- typically two or three per company, often
 * none, which is roughly a twentyfold reduction in what these sites have to serve.
 *
 * The cost of the shortcut: an article that never names the company in its title or excerpt,
 * only deep in the body, is not promoted to phase 2. That is the weakest evidence tier anyway
 * (a passing mention), and it is the trade the bandwidth saving is worth.
 *
 * @param {object} source     a config entry carrying `archiveSearch.endpoint`
 * @param {string} query      free-text search (a company name)
 * @param {object} [options]
 * @param {number} [options.perPage]     candidates to rank in phase 1 (WP caps at 100)
 * @param {number} [options.maxBodies]   most bodies to fetch in phase 2
 * @param {string} [options.after]       ISO date; only posts published after it
 * @param {(post: {title: string, excerpt: string}) => boolean} [options.looksRelevant]
 *        phase-1 screen; defaults to keeping everything (which restores single-phase behaviour)
 * @returns {Promise<object[]>} items in the same shape the RSS reader produces, so the rest of
 *                              the pipeline cannot tell the two apart
 */
export async function searchArchive(
  source,
  query,
  { perPage = 100, maxBodies = 12, after = null, timeoutMs = 25000, looksRelevant = null, counters = null, alwaysReadTop = 3 } = {}
) {
  const endpoint = source.archiveSearch?.endpoint;
  if (!endpoint) throw new Error(`${source.name} has no archiveSearch.endpoint configured`);

  const url = new URL(endpoint);
  url.searchParams.set('search', query);
  url.searchParams.set('per_page', String(Math.min(perPage, 100)));
  // Rank by RELEVANCE, not date. Sorting a search by date buries the answer for any company
  // whose name is a common word: "Scale raises $700,000 to help fintechs issue cards" sat far
  // below every recent article that merely used the word "scale", so the one story actually
  // about the company never came back. Relevance is also WordPress's own default for a search
  // query -- forcing `orderby=date` was overriding it.
  url.searchParams.set('orderby', 'relevance');
  url.searchParams.set('_fields', 'id,date,link,title,excerpt');
  if (after) url.searchParams.set('after', after);

  const candidates = await getJson(url, timeoutMs);
  if (counters) counters.ranked = (counters.ranked ?? 0) + candidates.length;
  if (!candidates.length) return [];

  // The top few results are read in full REGARDLESS of the screen. The screen only sees a title
  // and an excerpt, so an article that profiles a company further down the page looks identical
  // to one that never mentions it -- which is how Numida, whose coverage names it in the body
  // of a round-up rather than the headline, ended up with an empty news section. Relevance
  // ranking has already judged these the best matches; reading three of them costs little and
  // lets the real guard (which sees the whole article) make the call.
  const screened = looksRelevant
    ? candidates.filter((post) =>
        looksRelevant({ title: stripTags(post.title?.rendered ?? ''), excerpt: stripTags(post.excerpt?.rendered ?? '') }))
    : candidates;

  const ids = new Set([
    ...candidates.slice(0, alwaysReadTop).map((p) => p.id),
    ...screened.map((p) => p.id),
  ].filter((id) => id != null));
  const wanted = [...ids].slice(0, maxBodies);
  if (counters) {
    counters.screenedOut = (counters.screenedOut ?? 0) + (candidates.length - screened.length);
    counters.bodiesFetched = (counters.bodiesFetched ?? 0) + wanted.length;
  }
  if (!wanted.length) return [];

  // Phase 2: one request for the bodies of everything that survived the screen.
  const bodyUrl = new URL(endpoint);
  bodyUrl.searchParams.set('include', wanted.join(','));
  bodyUrl.searchParams.set('per_page', String(wanted.length));
  bodyUrl.searchParams.set('_fields', 'id,date,link,title,excerpt,content');
  const full = await getJson(bodyUrl, timeoutMs);

  // `include` ignores relevance ordering, so restore the phase-1 ranking.
  const byId = new Map(full.map((p) => [p.id, p]));
  return wanted.map((id) => byId.get(id)).filter(Boolean).map(toItem);
}

/** Sources this run can search, in configured priority order. */
export function archiveSources(config, { only = null } = {}) {
  const filter = only?.length ? new Set(only.map((n) => n.trim().toLowerCase())) : null;
  return (config.sources || [])
    .filter((s) => s.enabled && s.archiveSearch?.endpoint)
    .filter((s) => !filter || filter.has(s.name.toLowerCase()) || filter.has(s.domain.toLowerCase()))
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
}
