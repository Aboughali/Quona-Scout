/**
 * Phase 2 — extraction and company matching.
 *
 * Turns a raw Phase 1 finding (headline + article text) into structured facts:
 *   - what kind of news it is
 *   - whether it reports a funding event, and its round type / amount / investors
 *   - which company in the Quona Scout database it refers to, with a confidence and rationale
 *
 * DELIBERATELY DETERMINISTIC. This runs with no API key and no LLM: every value it produces is
 * traceable to a regex match on the source text, so nothing is invented. That matters more than
 * recall here -- a wrong auto-added funding round is far more damaging than a missed one, and
 * anything it is unsure about is routed to Needs Review rather than written to the database.
 *
 * An LLM extractor can be layered on later behind the same function signature (see
 * extractFinding's return shape); when ANTHROPIC_API_KEY is set, a future llmExtract() can
 * refine or raise confidence on these same fields. The pipeline does not need to change.
 */

// ---------------------------------------------------------------------------
// Round types -- the app's taxonomy. Order matters: the most specific pattern must be
// tested first, otherwise "pre-series A" is swallowed by the "series A" pattern and
// "seed extension" by "seed". This is the exact bug the brief calls out.
// ---------------------------------------------------------------------------
const ROUND_PATTERNS = [
  { type: 'Pre-Series A', re: /\bpre[\s-]*series[\s-]*a\b/i },
  { type: 'Series C+', re: /\bseries\s*[cdefg]\b/i },
  { type: 'Series B', re: /\bseries\s*b\b/i },
  { type: 'Series A', re: /\bseries\s*a\b/i },
  { type: 'Seed II', re: /\b(seed\s*(ii|2|extension)|extension\s*(of\s*)?(its\s*)?seed)\b/i },
  { type: 'Pre-seed', re: /\bpre[\s-]*seed\b/i },
  { type: 'Seed', re: /\bseed\b/i },
  { type: 'Venture Debt', re: /\b(venture\s*debt|debt\s*(facility|financing|funding|round)|credit\s*facility)\b/i },
  { type: 'Grant', re: /\bgrant\b/i },
  { type: 'Follow-on', re: /\bfollow[\s-]*on\b/i },
];

const CURRENCY_PATTERNS = [
  { code: 'USD', re: /(?:us\$|\$|usd)\s*/i },
  { code: 'EUR', re: /(?:€|eur)\s*/i },
  { code: 'GBP', re: /(?:£|gbp)\s*/i },
];

/** Verbs that indicate the article is ABOUT a raise, not merely mentioning past funding. */
const RAISE_VERBS = /\b(raise[sd]?|raising|secure[sd]?|closes?|closed|lands?|landed|bags?|nets?|receives?|attracts?)\b/i;

const CATEGORY_RULES = [
  { category: 'Acquisition', re: /\b(acquires?|acquisition|acquired by|buys out|takeover)\b/i },
  { category: 'Exit', re: /\b(exits?|ipo|listing|goes public|sold to)\b/i },
  { category: 'Funding', re: RAISE_VERBS },
  { category: 'New investor', re: /\b(backs?|backed by|invests? in|investment from|joins? as investor)\b/i },
  { category: 'Accelerator / cohort', re: /\b(accelerator|cohort|incubator|demo day|batch)\b/i },
  { category: 'Regulatory', re: /\b(licen[cs]e|regulator|central bank|compliance|approval|authorised|authorized)\b/i },
  { category: 'Leadership change', re: /\b(appoints?|names? new|steps down|resigns?|new ceo|new cfo|hires? as)\b/i },
  { category: 'Partnership', re: /\b(partners? with|partnership|teams? up|collaborat)\b/i },
  { category: 'Expansion', re: /\b(expands?|expansion|launches? in|enters? the|rolls? out (?:in|to))\b/i },
  { category: 'Product launch', re: /\b(launch(es|ed)?|unveils?|introduces?|rolls? out|debuts?)\b/i },
  { category: 'Business model change', re: /\b(pivots?|rebrands?|restructur)\b/i },
];

/**
 * The headline decides, and the body is only consulted when the headline says nothing.
 *
 * Same principle already applied to round type and amount below, for the same reason: a body
 * routinely recaps the company's funding history, so classifying over headline+body together
 * labelled "MoneyHash hires Hwan Lee as Africa regional director" as Funding purely because the
 * article later mentioned the round it raised last year. Categories are display-only -- funding
 * detection has its own headline-verb test -- but a feed of stories all labelled "Funding" is
 * worse than useless to someone scanning it.
 */
export function classifyCategory(headline = '', text = '') {
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(headline)) return rule.category;
  }
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category;
  }
  return 'Other company news';
}

/** "$5 million" / "$5m" / "$5.2M" / "US$1.5 billion" / "€3m" -> { amountUsdM, currency }. */
export function parseAmount(text = '') {
  for (const cur of CURRENCY_PATTERNS) {
    const re = new RegExp(cur.re.source + String.raw`(\d[\d,]*(?:\.\d+)?)\s*(million|billion|m\b|bn\b|k\b)?`, 'i');
    const m = text.match(re);
    if (!m) continue;
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const unit = (m[2] || '').toLowerCase();
    let inMillions;
    if (unit.startsWith('b')) inMillions = value * 1000;
    else if (unit === 'k') inMillions = value / 1000;
    else if (unit.startsWith('m')) inMillions = value;
    else inMillions = value >= 1000 ? value / 1_000_000 : value; // bare "$5" in a funding headline reads as $5m
    return { amount: Math.round(inMillions * 100) / 100, currency: cur.code };
  }
  return { amount: null, currency: null };
}

export function detectRoundType(text = '') {
  for (const p of ROUND_PATTERNS) {
    if (p.re.test(text)) return p.type;
  }
  return null;
}

/**
 * Investor names from "led by X", "backed by X and Y", "with participation from X, Y and Z".
 * Conservative by design: it only reads these explicit constructions, because a loose
 * capitalised-noun grab pulls in journalists, cities and product names.
 */
export function extractInvestors(text = '') {
  const found = new Set();
  let lead = null;

  const clauses = [
    // The comma before "with participation" is optional in the wild ("led by X with
    // participation from Y"), so it must not be required -- otherwise the lead investor
    // absorbs the whole participation clause as part of its name.
    { re: /\bled by ([^.;]+?)(?:\.|;|,?\s*(?:with|alongside|and joined|joined by)\b|$)/i, isLead: true },
    { re: /\bco-led by ([^.;]+?)(?:\.|;|,?\s*(?:with|alongside|and joined|joined by)\b|$)/i, isLead: true },
    { re: /\bbacked by ([^.;]+?)(?:\.|;|$)/i, isLead: false },
    { re: /\bparticipation (?:from|of) ([^.;]+?)(?:\.|;|$)/i, isLead: false },
    { re: /\binvestors? include[sd]? ([^.;]+?)(?:\.|;|$)/i, isLead: false },
    { re: /\bfrom investors ([^.;]+?)(?:\.|;|$)/i, isLead: false },
  ];

  for (const clause of clauses) {
    const m = text.match(clause.re);
    if (!m) continue;
    const names = m[1]
      .split(/,| and | & |\balongside\b|\bplus\b/i)
      .map((s) =>
        s
          .replace(/\b(existing|new|returning|other|several|various|angel)\s+investors?\b/gi, '')
          .replace(/\bwho\b[\s\S]*$/i, '')
          .replace(/[()"']/g, '')
          .trim()
      )
      // A real fund name starts with a capital and is not a sentence fragment.
      .filter((s) => s.length > 2 && s.length < 60 && /^[A-Z0-9]/.test(s) && !/\s(said|added|noted|will|has|is)\b/i.test(s));
    for (const n of names) {
      found.add(n);
      if (clause.isLead && !lead) lead = n;
    }
  }
  return { investors: [...found], leadInvestor: lead };
}

/**
 * Extracts the subject company from a funding headline: the text before the raise verb.
 * "Kenyan fintech HoneyCoin raises $4.9m seed" -> "HoneyCoin"
 */
/** Headlines that are analysis, opinion or market aggregates -- they contain a raise verb and a
 *  dollar figure but no single subject company, and would otherwise produce phantom records. */
const NOT_A_COMPANY_HEADLINE = [
  /^(what|why|how|when|where|who|is|are|should|can|does)\b/i,
  /\b(startups?|companies|firms|ventures|founders)\s+(raise|raised|secure|secured|attract)/i,
  /\b(round[\s-]?up|weekly|monthly|recap|analysis|opinion|explainer|report says)\b/i,
  /\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b.*\braise/i,
];

/**
 * Extracts the subject company from a funding headline.
 *
 * Journalists prefix the company with nationality and sector descriptors
 * ("Bahraini insurtech Soor secures...", "Mobility fintech Naran secures..."). Rather than
 * maintain an endless blocklist of those descriptors, this takes the TRAILING RUN OF
 * CAPITALISED TOKENS before the verb, which is what the company name actually is:
 *
 *   "Mobility fintech Naran"            -> Naran
 *   "Saudi game studio Majestic Mind Games" -> Majestic Mind Games
 *   "Arab Therapy"                      -> Arab Therapy
 */
export function extractCompanyName(headline = '') {
  if (NOT_A_COMPANY_HEADLINE.some((re) => re.test(headline))) return null;

  const m = headline.match(new RegExp(String.raw`^(.*?)\s+` + RAISE_VERBS.source, 'i'));
  if (!m) return null;

  const subject = m[1].replace(/^(exclusive|breaking|just in)\s*[:\-]\s*/i, '').trim();
  if (!subject) return null;

  const tokens = subject.split(/\s+/).filter(Boolean);
  const isCapitalised = (t) => /^[A-Z0-9]/.test(t.replace(/^[("']+/, ''));

  // Walk back from the verb while tokens still look like part of a proper noun.
  const run = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (isCapitalised(tokens[i])) run.unshift(tokens[i]);
    else break;
  }

  const name = (run.length ? run : tokens).join(' ').replace(/[,;:]+$/, '').trim();
  if (!name || name.length > 60) return null;
  if (run.length === 0) return null; // nothing capitalised -> not a company subject
  if (name.split(/\s+/).length > 6) return null;
  // A lone generic word is not a company.
  if (/^(the|a|an|this|it|they|startup|company|firm|fintech)$/i.test(name)) return null;
  return name;
}

export function extractFinding(finding) {
  const headline = finding.headline || '';
  const text = finding.raw_content || '';
  const hay = `${headline}. ${text}`;

  const category = classifyCategory(headline, text);
  // A funding event requires a raise verb IN THE HEADLINE. Body-only mentions are usually
  // background ("...which raised $3m last year") and would create phantom rounds.
  const headlineRaise = RAISE_VERBS.test(headline);

  // Round type and amount are read from the HEADLINE ONLY, never the body. Body fallback was
  // tried and actively harmful: an article about a $2m Seed also mentioned "$200 billion" of
  // sovereign capital (recorded as a $200,000m round), and a Seed announcement whose body
  // discussed the company's earlier pre-seed was filed as Pre-seed. The headline is the one
  // place the round being announced is stated unambiguously.
  const roundType = detectRoundType(headline);
  const { amount, currency } = parseAmount(headline);

  const { investors, leadInvestor } = extractInvestors(hay);
  const companyName = extractCompanyName(headline);

  // Without a subject company there is nothing to attach a round to, so it is not a usable
  // funding event no matter how confident the other fields look.
  const isFundingEvent = headlineRaise && companyName != null && (roundType != null || amount != null);

  // Confidence is additive and capped -- each component is a fact we actually found.
  let confidence = 0;
  if (isFundingEvent) {
    confidence = 0.4;
    if (roundType) confidence += 0.2;
    if (amount != null) confidence += 0.2;
    if (companyName) confidence += 0.1;
    if (investors.length) confidence += 0.1;
  }

  return {
    news_category: category,
    funding_round_detected: isFundingEvent,
    extracted_company_name: companyName,
    round_type: isFundingEvent ? roundType : null,
    funding_amount: isFundingEvent ? amount : null,
    currency: isFundingEvent ? currency : null,
    investors,
    lead_investor: leadInvestor,
    extraction_confidence: Math.min(1, Math.round(confidence * 100) / 100),
    extraction_method: 'deterministic-v1',
  };
}

// ---------------------------------------------------------------------------
// Company matching
// ---------------------------------------------------------------------------

export function normalizeName(s = '') {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Strips a legal/geographic suffix so "MoneyHash Egypt" and "MoneyHash Ltd" reduce to the base. */
function baseName(s = '') {
  return normalizeName(s)
    .replace(/\b(ltd|limited|inc|llc|plc|holdings?|group|technologies|technology|tech|labs?|africa|egypt|kenya|nigeria|ghana|south africa)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function domainOf(url) {
  if (!url) return null;
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolves an extracted company name to a company in the database.
 *
 * Returns a confidence and a human-readable rationale, never a bare boolean: an investor has to
 * be able to see WHY a match was made before trusting an automated database write. Anything
 * below the auto-apply threshold is routed to Needs Review instead of being attached.
 */
export function matchCompany(extractedName, companies, { articleText = '', articleUrl = null } = {}) {
  if (!extractedName) return { company: null, confidence: 0, rationale: 'No company name could be extracted from the headline.' };

  const target = normalizeName(extractedName);
  const targetBase = baseName(extractedName);
  if (!target) return { company: null, confidence: 0, rationale: 'Extracted name normalised to empty.' };

  // 1. Exact canonical-name match.
  const exact = companies.filter((c) => normalizeName(c.name) === target);
  if (exact.length === 1) {
    return { company: exact[0], confidence: 0.98, rationale: `Exact name match on "${exact[0].name}".` };
  }
  if (exact.length > 1) {
    return { company: null, confidence: 0.4, rationale: `Ambiguous: ${exact.length} companies share the name "${extractedName}". Needs a human decision.` };
  }

  // 2. Website/domain match -- strongest possible signal when the article links the company site.
  const articleDomain = domainOf(articleUrl);
  if (articleDomain) {
    const byDomain = companies.filter((c) => domainOf(c.website) && domainOf(c.website) === articleDomain);
    if (byDomain.length === 1) {
      return { company: byDomain[0], confidence: 0.95, rationale: `Website domain match (${articleDomain}).` };
    }
  }

  // 3. Base-name match (suffix/geography stripped), corroborated by country if the article says one.
  const byBase = companies.filter((c) => baseName(c.name) === targetBase && targetBase.length >= 4);
  if (byBase.length === 1) {
    const c = byBase[0];
    const countryConfirmed = c.country && new RegExp(`\\b${c.country}\\b`, 'i').test(articleText);
    return {
      company: c,
      confidence: countryConfirmed ? 0.92 : 0.82,
      rationale: countryConfirmed
        ? `Name matches "${c.name}" after normalising suffixes, and the article mentions ${c.country}.`
        : `Name matches "${c.name}" after normalising suffixes/geography. Country not confirmed in the article.`,
    };
  }
  if (byBase.length > 1) {
    return { company: null, confidence: 0.35, rationale: `"${extractedName}" reduces to a base name shared by ${byBase.length} companies.` };
  }

  // 4. Containment, only for distinctive names. Requires a country hit to avoid matching a
  //    short common word inside an unrelated company's name.
  if (target.length >= 6) {
    const contains = companies.filter((c) => {
      const n = normalizeName(c.name);
      return n.includes(target) || target.includes(n);
    });
    if (contains.length === 1) {
      const c = contains[0];
      const countryConfirmed = c.country && new RegExp(`\\b${c.country}\\b`, 'i').test(articleText);
      if (countryConfirmed) {
        return { company: c, confidence: 0.78, rationale: `Partial name match with "${c.name}", corroborated by ${c.country} in the article.` };
      }
      return { company: c, confidence: 0.55, rationale: `Partial name match with "${c.name}" only — no corroborating country. Review before applying.` };
    }
  }

  return { company: null, confidence: 0, rationale: `No company in the database matches "${extractedName}". Candidate for a new company record.` };
}
