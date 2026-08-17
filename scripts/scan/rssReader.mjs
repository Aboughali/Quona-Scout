/**
 * Native RSS/Atom reader -- no Apify, no dependencies.
 *
 * WHY NOT APIFY FOR THIS: RSS is plain XML over HTTP. There is no official Apify RSS Actor
 * (`apify/rss-scraper` does not exist -- only third-party ones), and routing a simple GET
 * through a paid compute platform would add cost, latency and a third-party dependency for no
 * benefit. Apify is reserved for what it is genuinely needed for: JS-rendered pages that a
 * plain fetch cannot read (see accessMethod: "crawler").
 *
 * The parser is intentionally small and tolerant: feeds in the wild are frequently malformed,
 * so it extracts the handful of fields the pipeline needs and ignores everything else.
 */

const USER_AGENT =
  'QuonaScout/1.0 (+sourcing-research; contact via repository owner) Node fetch';

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&amp;/g, '&'); // last, so it cannot double-decode the entities above
}

function stripTags(s) {
  return decodeEntities(s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** First matching tag's inner content, namespace-tolerant (handles `content:encoded`). */
function tag(block, ...names) {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const m = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
    if (m && m[1].trim()) return decodeEntities(m[1]).trim();
  }
  return null;
}

/**
 * The article's lead image, if the feed offers one. Feeds advertise it in four different
 * places, none of them mandatory, so all four are tried in descending order of reliability;
 * the last resort is the first <img> inside the article body itself.
 *
 * Only used for display in the per-company news feed -- a missing image is normal and the UI
 * falls back to a source monogram rather than showing a broken frame.
 */
function imageUrl(block, rawBody) {
  const patterns = [
    /<media:content[^>]*\burl=["']([^"']+)["'][^>]*>/i,
    /<media:thumbnail[^>]*\burl=["']([^"']+)["'][^>]*>/i,
    /<enclosure[^>]*\btype=["']image\/[^"']*["'][^>]*\burl=["']([^"']+)["']/i,
    /<enclosure[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\/[^"']*["']/i,
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m) return decodeEntities(m[1]);
  }
  const inline = (rawBody || '').match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  if (inline) return decodeEntities(inline[1]);
  return null;
}

/** Atom links carry the URL in an href attribute rather than as tag content. */
function atomLink(block) {
  const alternate = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alternate) return decodeEntities(alternate[1]);
  const any = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return any ? decodeEntities(any[1]) : null;
}

export function parseFeed(xml) {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  return blocks.map((block) => {
    const rawBody =
      tag(block, 'content:encoded') ?? tag(block, 'content') ?? tag(block, 'description') ?? tag(block, 'summary') ?? '';
    return {
      title: tag(block, 'title'),
      url: tag(block, 'link') || atomLink(block),
      publishedAt: tag(block, 'pubDate', 'published', 'updated', 'dc:date'),
      text: stripTags(rawBody),
      imageUrl: imageUrl(block, rawBody),
    };
  }).filter((item) => item.title || item.url);
}

/**
 * Fetches and parses a feed. Returns items in the same shape the Apify path produces, so
 * runScan() treats both sources identically.
 */
export async function fetchFeed(feedUrl, { maxItems = 40, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseFeed(xml).slice(0, maxItems);
  } finally {
    clearTimeout(timer);
  }
}
