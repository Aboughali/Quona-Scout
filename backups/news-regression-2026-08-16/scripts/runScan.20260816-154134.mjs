/**
 * Core scan runner -- the portable piece.
 *
 * `runScan()` is a pure-ish function: it takes a token, a source config and a set of already-seen
 * finding keys, and returns new findings. It performs no file I/O and reads no environment
 * variables itself. That is deliberate: moving the weekly scan to a scheduled serverless
 * function later means calling this exact function from a different wrapper, with the storage
 * adapter swapped. The two current wrappers are scripts/scan/cli.mjs (npm run scan) and the
 * dev-server endpoint in vite.config.ts.
 *
 * PHASE 1 SCOPE: collect raw findings only. No company matching, no LLM extraction, no writes
 * to company data. Findings land in their own append-only store and touch nothing else.
 */

import { ACTORS, runActor } from './apifyClient.mjs';
import { fetchFeed } from './rssReader.mjs';

/** Terms that make an article plausibly relevant before any LLM sees it. Cheap pre-filter to
 *  keep Phase 2 extraction costs down -- deliberately broad, since precision is Phase 2's job. */
const RELEVANCE_TERMS = [
  'raise', 'raised', 'raises', 'funding', 'investment', 'investor', 'round', 'seed',
  'series a', 'series b', 'series c', 'pre-series', 'pre-seed', 'venture', 'debt facility',
  'valuation', 'acquire', 'acquisition', 'merger', 'expansion', 'expands', 'launches',
  'launch', 'partnership', 'licence', 'license', 'regulator', 'central bank', 'cohort',
  'accelerator', 'fintech', 'payments', 'lending', 'wallet', 'remittance', 'startup',
];

const AFRICA_TERMS = [
  'africa', 'african', 'nigeria', 'kenya', 'egypt', 'south africa', 'ghana', 'morocco',
  'tanzania', 'uganda', 'rwanda', 'senegal', 'ivory coast', "côte d'ivoire", 'cote d ivoire',
  'ethiopia', 'zambia', 'cameroon', 'tunisia', 'algeria', 'botswana', 'mozambique',
  'lagos', 'nairobi', 'cairo', 'cape town', 'johannesburg', 'accra', 'kampala', 'dakar',
];

function textOf(item) {
  return [item.title, item.text, item.description, item.content, item.summary]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function looksRelevant(item, { requireAfrica }) {
  const t = textOf(item);
  if (!t) return false;
  const hasSignal = RELEVANCE_TERMS.some((k) => t.includes(k));
  if (!hasSignal) return false;
  // Global outlets carry mostly non-African news, so they additionally need a geography hit.
  // African outlets do not -- everything they publish is already in-region.
  if (requireAfrica && !AFRICA_TERMS.some((k) => t.includes(k))) return false;
  return true;
}

/** Stable identity for a finding: same article from the same source is never stored twice,
 *  across runs. URL is the natural key; headline+source is the fallback when a feed omits it. */
export function findingKey(sourceDomain, url, headline) {
  const cleanUrl = (url || '').split('?')[0].replace(/\/$/, '').toLowerCase();
  return cleanUrl ? `${sourceDomain}|${cleanUrl}` : `${sourceDomain}|${(headline || '').trim().toLowerCase()}`;
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildInput(source, defaults) {
  const maxItems = source.maxItemsPerRun ?? defaults.maxItemsPerRun ?? 40;
  if (source.accessMethod === 'crawler') {
    return {
      actorId: ACTORS.crawler,
      input: {
        startUrls: (source.startUrls || []).map((url) => ({ url })),
        maxCrawlPages: maxItems,
        crawlerType: 'playwright:adaptive',
        // Respecting robots.txt is a hard requirement, not a tunable.
        respectRobotsTxtFile: true,
        saveMarkdown: false,
        removeCookieWarnings: true,
      },
    };
  }
  return null;
}

/**
 * The Phase 1 finding record. Fields that only Phase 2+ can populate are present and explicitly
 * null, so the storage schema does not change shape later.
 *
 * Shared by BOTH collectors -- the weekly feed scan below and the per-company archive backfill
 * (backfill.mjs) -- so a record is indistinguishable by shape regardless of how it was found,
 * and the enrichment pass needs no special cases. `discovery` records which collector produced
 * it, purely for auditing.
 */
export function buildFinding({ item, source, key, url, headline, published, retrievedAt, discovery = 'feed-scan' }) {
  const rawText = (item.text || item.content || item.description || item.summary || '').trim();
  return {
    finding_id: `f_${key.replace(/[^a-z0-9]+/gi, '_').slice(0, 90)}_${Date.now().toString(36)}`,
    finding_key: key,
    source: source.name,
    source_domain: source.domain,
    source_type: source.sourceType,
    url,
    published_date: published,
    retrieved_date: retrievedAt,
    headline,
    // Lead image, when the source advertises one. Display-only: it is never used for
    // matching or extraction, and older findings predate this field (hence the ?? null).
    image_url: item.imageUrl ?? item.image ?? null,
    raw_content: rawText.slice(0, 6000),
    raw_content_truncated: rawText.length > 6000,
    discovery,

    // --- populated in Phase 2 ---
    company_match: null,
    company_match_confidence: null,
    news_category: null,
    funding_round_detected: null,
    funding_amount: null,
    currency: null,
    investors: null,
    extracted_facts: null,
    confidence: null,

    // --- lifecycle ---
    status: 'new',
    approved_by_user: null,
    created_at: retrievedAt,
    updated_at: retrievedAt,
  };
}

/**
 * @param {string} token                Apify API token (from env, supplied by the caller)
 * @param {object} config               parsed config/news_sources.json
 * @param {Set<string>} seenKeys        findingKey()s already stored, to skip duplicates
 * @param {(msg: string) => void} log
 * @returns {Promise<{findings: object[], sourceResults: object[]}>}
 */
export async function runScan(token, config, seenKeys = new Set(), log = () => {}, options = {}) {
  const defaults = config.defaults ?? {};
  const lookbackDays = defaults.lookbackDays ?? 1095;
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  // `only` restricts the run to named sources, so the pipeline can be validated on one or two
  // cheap feeds before committing to a full sweep across every source.
  const only = options.only?.length
    ? new Set(options.only.map((n) => n.trim().toLowerCase()))
    : null;

  const enabled = (config.sources || [])
    .filter((s) => s.enabled)
    .filter((s) => !only || only.has(s.name.toLowerCase()) || only.has(s.domain.toLowerCase()))
    .sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));

  if (only && enabled.length === 0) {
    log(`No enabled source matched --only=${[...only].join(',')}`);
  }

  const findings = [];
  const sourceResults = [];
  const retrievedAt = new Date().toISOString();

  for (const source of enabled) {
    const maxItems = source.maxItemsPerRun ?? defaults.maxItemsPerRun ?? 40;
    log(`Scanning ${source.name} (${source.accessMethod})...`);

    let items = [];
    try {
      if (source.accessMethod === 'rss') {
        // Native fetch -- costs nothing and needs no Apify Actor. See rssReader.mjs.
        items = await fetchFeed(source.feedUrl, { maxItems });
      } else {
        const built = buildInput(source, defaults);
        if (!built) {
          sourceResults.push({ name: source.name, status: 'skipped', reason: `Unsupported accessMethod "${source.accessMethod}"`, kept: 0 });
          continue;
        }
        items = await runActor(token, built.actorId, built.input);
      }
    } catch (err) {
      log(`  ! ${source.name}: ${err.message}`);
      sourceResults.push({ name: source.name, status: 'error', reason: err.message, kept: 0 });
      continue;
    }

    const requireAfrica = source.sourceType === 'global-fintech-news';
    let kept = 0;
    let skippedOld = 0;
    let skippedIrrelevant = 0;
    let skippedDuplicate = 0;

    for (const item of items) {
      const url = item.url || item.link || null;
      const headline = item.title || item.headline || null;
      const key = findingKey(source.domain, url, headline);

      if (seenKeys.has(key)) { skippedDuplicate += 1; continue; }

      const published = toIso(item.publishedAt || item.date || item.pubDate || item.publishedDate);
      if (published && new Date(published).getTime() < cutoff) { skippedOld += 1; continue; }

      if (!looksRelevant(item, { requireAfrica })) { skippedIrrelevant += 1; continue; }

      findings.push(buildFinding({ item, source, key, url, headline, published, retrievedAt }));
      kept += 1;
      seenKeys.add(key);
    }

    log(`  ${source.name}: ${items.length} fetched, ${kept} kept (${skippedDuplicate} dup, ${skippedIrrelevant} off-topic, ${skippedOld} older than ${lookbackDays}d)`);
    sourceResults.push({
      name: source.name,
      status: items.length ? 'ok' : 'empty',
      fetched: items.length,
      kept,
      skippedDuplicate,
      skippedIrrelevant,
      skippedOld,
      scannedAt: retrievedAt,
    });
  }

  return { findings, sourceResults };
}
