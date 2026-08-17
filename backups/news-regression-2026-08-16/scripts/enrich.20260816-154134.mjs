/**
 * Phase 2 orchestration: raw findings -> enriched findings + deduplicated signals.
 *
 * Two outputs, deliberately separate (brief Part 10):
 *   FINDINGS  — every article, enriched in place with category / company match / extraction.
 *               An article stays here forever, even after its facts have been extracted, so
 *               the company's News & Intelligence history is never lost.
 *   SIGNALS   — proposed DATABASE CHANGES (a new company, or a new round on an existing one),
 *               with every article reporting that same event attached as a source.
 *
 * Nothing here writes to companies.json or to the manual-override store. A signal is a
 * PROPOSAL; it only becomes company data when approved in the app, and approval goes through
 * the same code paths as a manual entry, so the funnel and syndicate scoring recompute exactly
 * as they already do. The investment methodology is untouched.
 */

import { extractFinding, matchCompany, normalizeName } from './extract.mjs';

/** This is an AFRICA fintech sourcing database. Several configured outlets (Wamda especially)
 *  cover the wider MENA region, so a Gulf raise is a perfectly valid article but must never
 *  become a company record here. Articles still land in the findings store and remain readable;
 *  they simply do not propose a database change. */
const AFRICA_HINTS = /\b(africa|african|nigeria|kenya|egypt|south africa|ghana|morocco|tanzania|uganda|rwanda|senegal|ethiopia|zambia|cameroon|tunisia|algeria|botswana|mozambique|lagos|nairobi|cairo|cape town|johannesburg|accra|kampala|dakar|abidjan|kigali)\b/i;

/** Above this, a company match is trustworthy enough to attach news automatically. */
export const AUTO_ATTACH_CONFIDENCE = 0.8;

/**
 * A backfilled finding arrives with a candidate identity the feed scan never has: it was
 * retrieved by searching one company's name, and it passed a corroboration tier (see
 * backfill.mjs). That matters because extractCompanyName() reads funding-announcement grammar
 * ("X raises $Y"), so a hiring, licence or launch story about a known company extracts nothing
 * and would otherwise never attach.
 *
 * The candidate is a hint, not a verdict: matchCompany() still has to resolve the name against
 * the database on its own, and the tier caps how much confidence the corroboration can buy, so
 * a weaker tier cannot reach the same certainty as a headline naming the company outright.
 */
const BACKFILL_TIER_CEILING = {
  domain: 0.95,
  headline: 0.92,
  founder: 0.9,
  'headline-corroborated': 0.85,
  sustained: 0.85,
};
/** Above this, a funding event may be proposed for one-click approval. Below -> Needs Review. */
export const HIGH_CONFIDENCE = 0.75;
/** Below this, we keep the article but propose no database change at all (brief Part 12). */
export const LOW_CONFIDENCE = 0.45;

/** Two reports describe the same financing event if same company + same round type + amounts
 *  agree (or one is missing) + announced within a short window. Mirrors the tolerance logic
 *  already used by the deal-register importer, for consistency. */
const SAME_EVENT_DAYS = 45;
const AMOUNT_REL_TOLERANCE = 0.02;

function amountsCompatible(a, b) {
  if (a == null || b == null) return true;
  if (Math.abs(a - b) <= 0.01) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale <= AMOUNT_REL_TOLERANCE;
}

function daysApart(a, b) {
  if (!a || !b) return 0;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

function sameEvent(signal, cand) {
  if (signal.company_key !== cand.company_key) return false;
  if ((signal.round_type || '') !== (cand.round_type || '')) return false;
  if (!amountsCompatible(signal.funding_amount, cand.funding_amount)) return false;
  if (signal.event_date && cand.event_date && daysApart(signal.event_date, cand.event_date) > SAME_EVENT_DAYS) return false;
  return true;
}

/**
 * @param {object[]} findings   raw Phase 1 findings
 * @param {object[]} companies  the current company database (read-only)
 * @returns {{ findings: object[], signals: object[], stats: object }}
 */
export function enrichFindings(findings, companies) {
  const stats = {
    processed: 0, matchedExisting: 0, needsReviewMatch: 0, unmatched: 0,
    fundingEventsDetected: 0, signalsCreated: 0, signalsMerged: 0, nonAfricanSkipped: 0,
    newCompanySignals: 0, newRoundSignals: 0, lowConfidenceIgnored: 0,
  };

  const enriched = [];
  const signals = [];

  for (const f of findings) {
    stats.processed += 1;

    const ex = extractFinding(f);
    const matchContext = {
      articleText: `${f.headline || ''} ${f.raw_content || ''}`,
      articleUrl: f.url,
    };
    let match = matchCompany(ex.extracted_company_name, companies, matchContext);

    // Fall back to the archive-search candidate when headline extraction found nothing usable.
    if (f.backfill_query && match.confidence < AUTO_ATTACH_CONFIDENCE) {
      const viaBackfill = matchCompany(f.backfill_query, companies, matchContext);
      const ceiling = BACKFILL_TIER_CEILING[f.backfill_tier] ?? AUTO_ATTACH_CONFIDENCE;
      if (viaBackfill.company && viaBackfill.confidence > match.confidence) {
        match = {
          ...viaBackfill,
          confidence: Math.min(viaBackfill.confidence, ceiling),
          rationale: `${viaBackfill.rationale} Retrieved by archive search for "${f.backfill_query}" (${f.backfill_tier} evidence).`,
        };
      }
    }

    if (match.company && match.confidence >= AUTO_ATTACH_CONFIDENCE) stats.matchedExisting += 1;
    else if (match.company) stats.needsReviewMatch += 1;
    else stats.unmatched += 1;

    const enrichedFinding = {
      ...f,
      news_category: ex.news_category,
      company_match: match.company ? match.company.id : null,
      company_match_name: match.company ? match.company.name : null,
      company_match_confidence: match.confidence,
      company_match_rationale: match.rationale,
      extracted_company_name: ex.extracted_company_name,
      funding_round_detected: ex.funding_round_detected,
      round_type: ex.round_type,
      funding_amount: ex.funding_amount,
      currency: ex.currency,
      investors: ex.investors,
      lead_investor: ex.lead_investor,
      confidence: ex.extraction_confidence,
      extraction_method: ex.extraction_method,
      // Attach the article to the company's News feed only when the match is solid. A weak
      // match leaves the article in the store, visible in Needs Review, but off the profile.
      attached_company_id: match.company && match.confidence >= AUTO_ATTACH_CONFIDENCE ? match.company.id : null,
      status: f.approved_by_user ? f.status : 'enriched',
      updated_at: new Date().toISOString(),
    };
    enriched.push(enrichedFinding);

    if (!ex.funding_round_detected) continue;
    stats.fundingEventsDetected += 1;

    // Geography gate: only propose database changes for African events.
    const geoHay = `${f.headline || ''} ${f.raw_content || ''}`;
    if (!match.company && !AFRICA_HINTS.test(geoHay)) {
      stats.nonAfricanSkipped = (stats.nonAfricanSkipped || 0) + 1;
      continue;
    }

    const overall = Math.min(ex.extraction_confidence, match.company ? Math.max(match.confidence, 0.5) : 0.6);
    if (overall < LOW_CONFIDENCE) {
      stats.lowConfidenceIgnored += 1;
      continue; // article retained above; no database change proposed
    }

    const companyKey = match.company ? `id:${match.company.id}` : `new:${normalizeName(ex.extracted_company_name || f.headline)}`;
    const candidate = {
      company_key: companyKey,
      round_type: ex.round_type,
      funding_amount: ex.funding_amount,
      event_date: f.published_date,
    };

    // --- Duplicate funding-round protection (brief Part 5) -----------------------------
    // Three outlets reporting one raise must produce ONE signal with three sources.
    const existing = signals.find((s) => sameEvent(s, candidate));
    if (existing) {
      existing.sources.push({
        finding_id: f.finding_id,
        source: f.source,
        url: f.url,
        headline: f.headline,
        published_date: f.published_date,
        confidence: ex.extraction_confidence,
      });
      // Corroboration from an independent outlet genuinely raises confidence, capped so it
      // can never reach certainty on reporting alone.
      existing.confidence = Math.min(0.97, existing.confidence + 0.06);
      // Fill gaps from the better-specified report without overwriting what we already have.
      if (existing.funding_amount == null && ex.funding_amount != null) existing.funding_amount = ex.funding_amount;
      if (!existing.currency && ex.currency) existing.currency = ex.currency;
      if (!existing.lead_investor && ex.lead_investor) existing.lead_investor = ex.lead_investor;
      for (const inv of ex.investors) if (!existing.investors.includes(inv)) existing.investors.push(inv);
      existing.updated_at = new Date().toISOString();
      stats.signalsMerged += 1;
      continue;
    }

    const signal = {
      signal_id: `sig_${companyKey.replace(/[^a-z0-9]+/gi, '_')}_${(ex.round_type || 'round').replace(/\W+/g, '')}_${Date.now().toString(36)}`,
      signal_type: match.company ? 'existing-company-new-round' : 'new-company-discovered',
      company_key: companyKey,
      company_id: match.company ? match.company.id : null,
      company_name: match.company ? match.company.name : ex.extracted_company_name,
      company_match_confidence: match.confidence,
      company_match_rationale: match.rationale,
      round_type: ex.round_type,
      funding_amount: ex.funding_amount,
      currency: ex.currency || 'USD',
      event_date: f.published_date,
      investors: [...ex.investors],
      lead_investor: ex.lead_investor,
      confidence: overall,
      status: 'pending',
      sources: [{
        finding_id: f.finding_id,
        source: f.source,
        url: f.url,
        headline: f.headline,
        published_date: f.published_date,
        confidence: ex.extraction_confidence,
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    signals.push(signal);
    stats.signalsCreated += 1;
    if (signal.signal_type === 'new-company-discovered') stats.newCompanySignals += 1;
    else stats.newRoundSignals += 1;
  }

  // Confidence tier drives what the UI offers: approve directly vs. review first.
  for (const s of signals) {
    s.review_tier = s.confidence >= HIGH_CONFIDENCE ? 'high' : 'medium';
    s.source_count = s.sources.length;
  }

  return { findings: enriched, signals, stats };
}
