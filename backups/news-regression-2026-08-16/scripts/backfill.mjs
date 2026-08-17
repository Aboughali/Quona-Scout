/**
 * Per-company historical backfill.
 *
 * The weekly feed scan answers "what happened this week?". This answers "what has ever been
 * written about the companies we track?" -- by asking each source's archive for the company by
 * name, rather than waiting for it to appear in a 10-item RSS window.
 *
 * PRECISION IS THE WHOLE PROBLEM. A full-text search for "Numida" returns articles that merely
 * mention it in a funding round-up, and a search for a company called "Root" or "Traction"
 * returns the English words. Storing all of that would bury the real coverage. So every
 * candidate is scored against evidence this database already holds -- the company's founders,
 * its website domain, its country -- and only corroborated articles are kept.
 *
 * What this does NOT do: decide which company an article belongs to. That stays with the
 * existing enrichment pass (enrich.mjs), which applies the 0.8 attach threshold and routes
 * anything weaker to Needs Review. Backfill widens the net; enrichment still guards the gate.
 */

import { buildFinding, findingKey } from './runScan.mjs';
import { REQUEST_DELAY_MS, archiveSources, searchArchive, sleep } from './archiveSearch.mjs';

/** How far back to reach. Matches the scanner's own lookback (config defaults.lookbackDays). */
const DEFAULT_LOOKBACK_DAYS = 1095;
/** Per company, per source. A company with more coverage than this in one outlet is a
 *  household name, and the extra articles add noise rather than signal. */
const MAX_KEEP_PER_COMPANY_PER_SOURCE = 8;
/** Candidates requested per company per source before filtering. Deliberately the WordPress
 *  maximum: it costs exactly one request either way, and a common-word name like "Scale" needs
 *  depth before its own coverage outranks every article that merely uses the word. */
const SEARCH_PAGE_SIZE = 100;
/** Bodies fetched per company per source in phase 2. Above the per-source keep cap, so the
 *  filter never runs short of material, but far below the 100 candidates ranked in phase 1. */
const BODY_FETCH_LIMIT = 12;

/**
 * Single-token company names that are also ordinary English words. Matching one of these in
 * body text proves nothing, so they are held to the stricter evidence bar below. Drawn from
 * the actual company list -- "Root", "Traction", "Fitting", "Bloom" are all real entries.
 */
const COMMON_WORD_NAMES = new Set([
  'root', 'traction', 'fitting', 'bloom', 'flow', 'wave', 'pulse', 'spark', 'anchor', 'bridge',
  'ladder', 'lemon', 'orange', 'mango', 'sun', 'moon', 'star', 'nova', 'apex', 'atlas', 'delta',
  'echo', 'edge', 'fair', 'grid', 'hub', 'jet', 'kite', 'leaf', 'lift', 'link', 'loop', 'match',
  'mint', 'nest', 'note', 'oak', 'orbit', 'pace', 'peak', 'pier', 'pilot', 'point', 'prime',
  'pride', 'quest', 'reach', 'rise', 'sage', 'scale', 'seed', 'shift', 'shore', 'signal',
  'slate', 'smart', 'spring', 'stack', 'stream', 'summit', 'swift', 'thread', 'tide', 'track',
  'trust', 'unity', 'vault', 'verve', 'vista', 'wing', 'zenith', 'money', 'cash', 'pay', 'bank',
  'credit', 'capital', 'finance', 'invest', 'fund', 'save', 'lend', 'card', 'wallet', 'nice',
  'float', 'settle', 'salad', 'surge', 'shield', 'chain', 'union', 'access', 'value', 'yield',
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive presence. Prevents "Enza" matching inside "influenza". */
function mentions(haystack, needle) {
  if (!haystack || !needle || needle.length < 2) return false;
  return new RegExp(`(?<![\\w-])${escapeRegex(needle)}(?![\\w-])`, 'i').test(haystack);
}

/** Case-SENSITIVE whole-word presence. For a name that is also an ordinary word, capitalisation
 *  is the cheapest available signal: "Root raises $8m" is the company, "the root of the funding
 *  problem" is the noun. */
function mentionsExactCase(haystack, needle) {
  if (!haystack || !needle || needle.length < 2) return false;
  return new RegExp(`(?<![\\w-])${escapeRegex(needle)}(?![\\w-])`).test(haystack);
}

/**
 * How many times the name appears as a whole word, CAPITALISED as a name.
 *
 * This is the discriminator between an article ABOUT a company and a digest that merely lists
 * it: a "TechCabal Daily" round-up names twenty companies once each, while a story about one
 * company keeps referring back to it. Country and funding vocabulary cannot tell the two apart
 * -- every African tech article has both -- but repetition can.
 *
 * Case matters here: a funding round-up that says companies "float" on the market would
 * otherwise look like sustained coverage of the South African fintech named Float.
 */
function mentionCountExactCase(haystack, needle) {
  if (!haystack || !needle || needle.length < 2) return 0;
  const matches = haystack.match(new RegExp(`(?<![\\w-])${escapeRegex(needle)}(?![\\w-])`, 'g'));
  return matches ? matches.length : 0;
}

/** Below this, a body-only mention is a passing reference rather than coverage. */
const SUSTAINED_MENTIONS = 3;

/** Any African geography, for the global-outlet check below. Mirrors the same list the feed
 *  scan applies to global sources (runScan.mjs AFRICA_TERMS). */
const AFRICA_HINT = /\b(africa|african|nigeria|kenya|egypt|south africa|ghana|morocco|tanzania|uganda|rwanda|senegal|ethiopia|zambia|cameroon|tunisia|algeria|botswana|mozambique|lagos|nairobi|cairo|cape town|johannesburg|accra|kampala|dakar|abidjan|kigali)\b/i;

/**
 * Company names collide across continents: "Float" is a South African fintech in this database,
 * a Canadian one raising CAD $85m, and a European one closing a Series A. An African outlet
 * writing about "Float" means the African one; PYMNTS or Fintech Global might mean any of the
 * three.
 *
 * So a global outlet has to place the story in Africa before a name match counts -- exactly the
 * `requireAfrica` rule the feed scan already applies to `sourceType: global-fintech-news`.
 * Identity-specific evidence (the company's own domain, a named founder) is exempt: those
 * cannot belong to a different company with the same name.
 */
function passesGeographyCheck(source, company, text) {
  if (source?.sourceType !== 'global-fintech-news') return true;
  return (company.country && mentions(text, company.country)) || AFRICA_HINT.test(text);
}

/**
 * Grammar that only appears around a company name: "fintech Root", "Root raises", "Root, the".
 * An ordinary-word usage almost never sits in one of these frames.
 *
 * The verbs here are deliberately limited to things a COMPANY does. Generic ones (is, was, has,
 * will, said) are useless: capitalisation cannot rescue them at a sentence start, so "Scale is
 * the third state to..." and "Next Wave: Scale is perspective" both read as the company Scale.
 * Every verb in this list would be odd with the ordinary noun.
 */
function hasCompanyCue(haystack, name) {
  if (!haystack) return false;
  const n = escapeRegex(name);
  const before = `\\b(?:startup|start-up|fintech|insurtech|company|platform|firm|lender|provider|app|venture)\\s+${n}\\b`;
  const after = `\\b${n}\\s*(?:,\\s*(?:the|a|an|which|whose|based|founded)|\\s+(?:rais\\w*|secur\\w*|clos\\w*|launch\\w*|announc\\w*|expand\\w*|acquir\\w*|partner\\w*|receiv\\w*|land\\w*|bagg?\\w*|netted|plans to|has raised|is expanding))`;
  return new RegExp(`${before}|${after}`).test(haystack);
}

/** Legal suffixes and the like carry no search value and hurt matching. */
export function searchableName(name = '') {
  return name
    .replace(/\b(ltd|limited|inc|llc|plc|holdings?|group|technologies|technology|tech|labs?|co)\b\.?/gi, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "https://www.enzagroup.global/" -> "enzagroup.global" */
function websiteDomain(website) {
  if (!website || typeof website !== 'string') return null;
  const cleaned = website.trim().toLowerCase();
  if (!cleaned || cleaned === 'n.a' || cleaned === 'n/a' || cleaned === '-') return null;
  const m = cleaned.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
  return m ? m[1] : null;
}

/** A name is ambiguous when a bare mention of it is not evidence of anything. */
export function isAmbiguousName(name) {
  const clean = searchableName(name).toLowerCase();
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && clean.length >= 8) return false;   // multi-word names are distinctive
  if (clean.length <= 4) return true;                          // too short to be evidence
  return COMMON_WORD_NAMES.has(clean);
}

/**
 * Phase-1 screen: is this candidate worth spending a body fetch on?
 *
 * Deliberately generous -- it only has the title and excerpt to work with, and its job is to
 * discard the bulk of a common-word search ("scale", "float") cheaply, not to make the final
 * call. assessRelevance() still judges every survivor on the full text.
 */
export function makeCandidateScreen(company) {
  const name = searchableName(company.name);
  const domain = websiteDomain(company.website);
  const ambiguous = isAmbiguousName(company.name);
  const surnames = (company.founders ?? [])
    .map((f) => String(f).replace(/\([^)]*\)/g, '').trim().split(/\s+/).slice(-1)[0])
    .filter((sn) => sn && sn.length >= 5);

  return ({ title, excerpt }) => {
    const hay = `${title} ${excerpt}`;
    if (domain && hay.toLowerCase().includes(domain)) return true;
    if (surnames.some((sn) => mentions(hay, sn))) return true;
    // For an ordinary-word name the screen must be case-sensitive, or the body budget is spent
    // on headlines using the verb -- "raises $5 million to scale ad-supported news" outranked
    // "South-African startup Scale raises $700,000" and pushed the real story out of the fetch.
    return ambiguous ? mentionsExactCase(hay, name) : mentions(hay, name);
  };
}

/**
 * Decides whether a retrieved article is really about this company.
 *
 * @returns {{keep: boolean, tier?: string, reason: string}}
 */
export function assessRelevance(item, company, source = null) {
  const name = searchableName(company.name);
  const title = item.title ?? '';
  const text = item.text ?? '';
  const both = `${title} ${text}`;

  // --- evidence that does not depend on how the name is written ---
  // Checked FIRST: an article can cite enzagroup.global or quote a founder without ever
  // spelling the company name as a separate word, and that is strong evidence, not weak.
  const domain = websiteDomain(company.website);
  const domainHit = domain ? both.toLowerCase().includes(domain) : false;
  if (domainHit) return { keep: true, tier: 'domain', reason: `cites ${domain}` };

  const nameAppears = mentions(both, name);
  const founderHit = (company.founders ?? []).some((f) => {
    // Founder strings carry annotations in this dataset ("David Nandwa (CEO)"). Left in, the
    // last token becomes "(CEO)" and matches any article containing that string.
    const full = String(f).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    if (full.length < 4) return false;
    if (mentions(both, full)) return true;
    // A surname alone is only evidence when the company is also named -- plenty of unrelated
    // people share a surname with a founder.
    const surname = full.split(/\s+/).slice(-1)[0];
    return surname.length >= 5 && /^[\p{L}'-]+$/u.test(surname) && nameAppears && mentions(both, surname);
  });
  if (founderHit) return { keep: true, tier: 'founder', reason: 'names a founder on record' };

  // --- otherwise the name itself has to carry the weight ---
  const titleHit = mentions(title, name);
  const bodyHit = mentions(text, name);
  if (!titleHit && !bodyHit) {
    // The search engine matched on something other than the name itself (stemming, fuzzy
    // relevance). Nothing here ties the article to this company.
    return { keep: false, reason: 'name never appears as a whole word' };
  }

  const cueHit = hasCompanyCue(both, name);

  if (!passesGeographyCheck(source, company, both)) {
    return { keep: false, reason: 'global outlet, and nothing places this story in the company\'s market' };
  }

  if (isAmbiguousName(company.name)) {
    // The name is an ordinary word, so a bare mention proves nothing. Demand that it is
    // capitalised as a name AND sits in a frame only a company name appears in.
    if (!(mentionsExactCase(both, name) && cueHit)) {
      return { keep: false, reason: 'name is an ordinary word here, not a company reference' };
    }
    if (titleHit) return { keep: true, tier: 'headline-corroborated', reason: 'headline mention reads as a company name' };
    if (mentionCountExactCase(text, name) >= SUSTAINED_MENTIONS) {
      return { keep: true, tier: 'sustained', reason: 'referred to repeatedly as a company' };
    }
    return { keep: false, reason: 'ambiguous name with too little corroboration' };
  }

  if (titleHit) return { keep: true, tier: 'headline', reason: 'named in the headline' };

  // Body-only. Country and funding vocabulary are NOT enough -- every African tech article has
  // both, which is how newsletter digests slip through. Coverage means the article keeps coming
  // back to the company.
  const count = mentionCountExactCase(text, name);
  if (count >= SUSTAINED_MENTIONS && cueHit) {
    return { keep: true, tier: 'sustained', reason: `named ${count} times with company framing` };
  }
  return { keep: false, reason: count > 1 ? `only ${count} passing mentions` : 'single passing mention' };
}

/**
 * Chooses which companies to search. Searching all 828 is possible but slow and mostly wasted:
 * the funnel already says which ones an investor is actually tracking.
 */
export function selectCompanies(companies, scope = 'watchlist') {
  if (scope === 'all') return companies;
  if (scope === 'stage4') return companies.filter((c) => c.stage4?.pass);
  // Default: everything still standing at the end of the funnel.
  return companies.filter((c) => c.cutStage === null || c.cutStage === undefined);
}

/**
 * Runs the backfill.
 *
 * Pure-ish, like runScan(): it performs no file I/O and reads no environment variables, so the
 * CLI wrapper and any future scheduled function share one implementation.
 *
 * @returns {Promise<{findings: object[], stats: object, perSource: object[]}>}
 */
export async function runBackfill(config, companies, seenKeys = new Set(), log = () => {}, options = {}) {
  const {
    scope = 'watchlist',
    // The CLI applies the scope itself (so it can also honour --limit) and passes the chosen
    // list straight through; this keeps the log line honest about which scope produced it.
    scopeLabel = scope,
    only = null,
    lookbackDays = config.defaults?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
    maxPerCompanyPerSource = MAX_KEEP_PER_COMPANY_PER_SOURCE,
    delayMs = REQUEST_DELAY_MS,
  } = options;

  const sources = archiveSources(config, { only });
  const targets = selectCompanies(companies, scope);
  const after = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const retrievedAt = new Date().toISOString();

  if (!sources.length) {
    return { findings: [], stats: { reason: 'no sources have archiveSearch configured' }, perSource: [] };
  }

  log(`Searching ${sources.length} archive(s) for ${targets.length} companies (${scopeLabel}), back to ${after.slice(0, 10)}.`);

  const findings = [];
  const stats = {
    companiesSearched: targets.length, requests: 0, kept: 0,
    // ranked = titles ranked in phase 1; bodiesFetched = articles actually read in full.
    ranked: 0, screenedOut: 0, bodiesFetched: 0,
    skippedDuplicate: 0, skippedIrrelevant: 0, errors: 0,
    byTier: {}, companiesWithHits: 0,
  };
  const perSource = sources.map((s) => ({ name: s.name, requests: 0, kept: 0, errors: 0 }));
  const hitsByCompany = new Map();

  const queries = targets
    .map((company) => ({ company, query: searchableName(company.name), screen: makeCandidateScreen(company) }))
    .filter(({ query }) => query && query.length >= 3);

  /** One source, every company, sequentially -- the politeness delay is per HOST. */
  async function sweepSource(source, i) {
    for (const { company, query, screen } of queries) {
      let items = [];
      try {
        items = await searchArchive(source, query, {
          perPage: SEARCH_PAGE_SIZE, after, maxBodies: BODY_FETCH_LIMIT, looksRelevant: screen,
          counters: stats,
        });
        stats.requests += 1;
        perSource[i].requests += 1;
      } catch (err) {
        stats.errors += 1;
        perSource[i].errors += 1;
        // One noisy source must not drown the log for 800 companies; the count is reported
        // in the per-source summary and only the first few are spelled out.
        if (perSource[i].errors <= 3) log(`  ! ${source.name} / ${company.name}: ${err.message}`);
        continue;
      } finally {
        await sleep(delayMs);
      }

      let keptHere = 0;
      for (const item of items) {
        if (keptHere >= maxPerCompanyPerSource) break;
        const url = item.url;
        const headline = item.title;
        const key = findingKey(source.domain, url, headline);
        if (seenKeys.has(key)) { stats.skippedDuplicate += 1; continue; }

        const verdict = assessRelevance(item, company, source);
        if (!verdict.keep) { stats.skippedIrrelevant += 1; continue; }

        const published = item.publishedAt ? new Date(item.publishedAt).toISOString() : null;
        const finding = buildFinding({
          item, source, key, url, headline, published, retrievedAt, discovery: 'archive-backfill',
        });
        // Why this article was retrieved at all. Auditing only -- enrichment still decides
        // attachment independently, so this can never be mistaken for a company match.
        finding.backfill_query = company.name;
        finding.backfill_tier = verdict.tier;

        findings.push(finding);
        seenKeys.add(key);
        stats.kept += 1;
        stats.byTier[verdict.tier] = (stats.byTier[verdict.tier] ?? 0) + 1;
        perSource[i].kept += 1;
        keptHere += 1;
        hitsByCompany.set(company.name, (hitsByCompany.get(company.name) ?? 0) + 1);
      }
    }
    log(`  ${source.name}: done (${perSource[i].kept} kept from ${perSource[i].requests} searches${perSource[i].errors ? `, ${perSource[i].errors} errors` : ''})`);
  }

  // Sources are separate hosts, so sweeping them concurrently costs each host exactly the same
  // request rate as before while cutting wall-clock time by the number of sources. That is what
  // makes an all-828-company run practical rather than an hours-long serial crawl.
  await Promise.all(sources.map((source, i) => sweepSource(source, i)));

  stats.companiesWithHits = hitsByCompany.size;
  stats.topCompanies = [...hitsByCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  return { findings, stats, perSource };
}
