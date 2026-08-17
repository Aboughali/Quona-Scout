/**
 * The traction agent: an uploaded document in, 2-3 bulleted traction updates out.
 *
 * This is the one file in the project that calls a model. Everything it returns is grounded in
 * the document the user just uploaded -- the system prompt forbids outside knowledge, requires
 * every figure to appear in the source, and provides an explicit "no traction data here" exit
 * so the honest answer is always available. That matters because these bullets sit next to
 * gold-sheet data in the company profile, and an invented metric would be indistinguishable
 * from a researched one.
 *
 * Structured outputs (output_config.format) guarantee the response parses -- no regex over
 * prose, no retry-on-JSON-parse loop.
 *
 * COST: input is billed per token, and a PDF deck is billed as images (roughly 1.5-3k tokens a
 * page). A 30-page deck lands around $0.30-0.60 per upload on Claude Opus 5. `estimatedCostUsd`
 * is returned on every call so the UI can show what a scan actually cost.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Anthropic's most capable model, and the one this project defaults to. */
export const MODEL = 'claude-opus-5';

/** List price per million tokens, for the cost estimate returned to the UI. */
const PRICE_PER_MTOK = { input: 5, output: 25 };

/** Reading a deck for figures is extraction, not deep reasoning -- medium effort keeps the
 *  latency of an upload in the seconds rather than the minutes. */
const EFFORT = 'medium';

const SYSTEM_PROMPT = `You are a traction analyst at Quona Capital, an emerging-markets fintech VC.

An investor has uploaded a document about one portfolio or pipeline company. Your job is to
read it and report ONLY what it says about TRACTION -- evidence that the business is working.

Traction means: revenue and its growth, customers/users/merchants and their growth, transaction
or disbursement volume, loan book size, retention or repeat rate, unit economics (CAC, LTV,
margin, take rate), burn and runway, and named commercial partnerships or licences.

NOT traction: the market-size story, the product roadmap, team bios, the funding ask, competitor
analysis, or mission statements. Skip all of it.

RULES -- these are absolute:
- Use ONLY this document. You have no outside knowledge of this company. Never fill a gap from
  memory, and never infer a figure that is not written down.
- Every bullet must carry at least one concrete figure or named fact copied from the document.
- Always attach the period a figure belongs to when the document states one ("Q2 2026", "FY25",
  "as of March"). If it does not state one, do not invent it.
- If the document contains no traction evidence at all, set has_traction_data to false and
  return a single bullet saying plainly what the document does contain instead.
- Prefer the most recent and most load-bearing metrics. Two excellent bullets beat three padded
  ones; never exceed three.
- Write each bullet as one plain sentence an investor can scan in isolation. No headers, no
  markdown, no lead-in phrases like "The document states".`;

/** Structured outputs make the response shape a guarantee rather than a hope. Note the schema
 *  deliberately carries no array length constraints -- those are not supported -- so the 2-3
 *  bullet limit is set in the prompt and enforced again on the way out. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['document_type', 'period', 'has_traction_data', 'bullets'],
  properties: {
    document_type: {
      type: 'string',
      description: 'What this document actually is, in 1-4 words. E.g. "Pitch deck", "Monthly management accounts", "KPI export".',
    },
    period: {
      type: 'string',
      description: 'The period the figures cover, as stated in the document (e.g. "Q2 2026", "FY2025", "Jan-Jun 2026"). Exactly "Not stated" if the document does not say.',
    },
    has_traction_data: {
      type: 'boolean',
      description: 'True only if the document contains at least one concrete traction metric.',
    },
    bullets: {
      type: 'array',
      description: 'Two or three traction updates, each one plain sentence containing a figure copied from the document.',
      items: { type: 'string' },
    },
  },
};

function buildContent(doc, fileName, companyName) {
  const ask =
    `Document: "${fileName}"\n` +
    `Company: ${companyName || 'not specified'}\n\n` +
    'Extract the traction evidence from this document as 2-3 bullets, following your rules exactly.';

  if (doc.kind === 'pdf') {
    // Document blocks go BEFORE the instruction text -- the model reads the source first.
    return [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 } },
      { type: 'text', text: ask },
    ];
  }
  return [
    { type: 'text', text: `<document name="${fileName}">\n${doc.text}\n</document>` },
    { type: 'text', text: doc.truncated ? `${ask}\n\nNote: the document was truncated for length; work from what is present.` : ask },
  ];
}

const NO_CREDENTIALS_MESSAGE =
  'No Anthropic credentials are configured, so the AI summary could not run. Add ANTHROPIC_API_KEY ' +
  'to .env (see .env.example) and re-upload. The file itself is stored either way -- you can also ' +
  'just write the traction points in by hand.';

/**
 * The SDK resolves credentials from several places (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, a
 * stored `ant auth login` profile), so an unset ANTHROPIC_API_KEY does not by itself mean there
 * is no key. Let the SDK decide rather than pre-judging it.
 */
function makeClient(apiKey) {
  try {
    return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  } catch {
    throw new Error(NO_CREDENTIALS_MESSAGE);
  }
}

/** The SDK raises its "no credentials" error when the request is built, not when the client is
 *  constructed, and as a plain Error rather than AuthenticationError -- so the friendly message
 *  has to be substituted here too, or the UI shows an SDK internals dump. */
function isMissingCredentials(err) {
  return err instanceof Anthropic.AuthenticationError ||
    /could not resolve authentication|apiKey.*not set|authentication method/i.test(String(err?.message ?? ''));
}

function estimateCost(usage) {
  if (!usage) return null;
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return Number(((input / 1e6) * PRICE_PER_MTOK.input + (output / 1e6) * PRICE_PER_MTOK.output).toFixed(4));
}

/**
 * @param {object} args
 * @param {{kind:'pdf'|'text', base64?:string, text?:string, truncated?:boolean}} args.doc  from extract.mjs
 * @param {string} args.fileName
 * @param {string} [args.companyName]
 * @param {string} [args.apiKey]  defaults to ANTHROPIC_API_KEY in the environment
 * @returns {Promise<{bullets:string[], docKind:string, period:string, hasTractionData:boolean,
 *                    model:string, usage:object, estimatedCostUsd:number|null}>}
 */
export async function summariseTraction({ doc, fileName, companyName, apiKey = process.env.ANTHROPIC_API_KEY }) {
  const client = makeClient(apiKey);
  const request = {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: buildContent(doc, fileName, companyName) }],
  };

  let response;
  try {
    // Claude Opus 5's safety classifiers can decline a request; `fallbacks: "default"` lets the
    // API re-run it on Anthropic's recommended fallback model server-side instead of handing
    // back a refusal. A financial document is unlikely to trip them, but a failed upload is a
    // bad experience for a one-line opt-in.
    response = await client.beta.messages.create({
      ...request,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    // If this account does not have the fallback beta, the request itself is still perfectly
    // valid -- retry it once on the standard endpoint rather than failing the upload.
    const message = String(err?.message ?? '');
    if (isMissingCredentials(err)) {
      throw new Error(NO_CREDENTIALS_MESSAGE);
    }
    if (err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(message)) {
      try {
        response = await client.messages.create(request);
      } catch (retryErr) {
        if (isMissingCredentials(retryErr)) throw new Error(NO_CREDENTIALS_MESSAGE);
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  if (response.stop_reason === 'refusal') {
    throw new Error(
      'The model declined to process this document' +
      (response.stop_details?.category ? ` (category: ${response.stop_details.category})` : '') +
      '. Add the traction points manually instead.'
    );
  }

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) {
    throw new Error(
      response.stop_reason === 'max_tokens'
        ? 'The summary was cut off before it finished. Try a shorter document.'
        : 'The model returned no summary for this document.'
    );
  }

  const parsed = JSON.parse(text);
  const bullets = (parsed.bullets ?? [])
    .map((b) => String(b).trim())
    .filter(Boolean)
    .slice(0, 3); // the prompt asks for 2-3; this is the belt to that braces

  return {
    bullets,
    docKind: parsed.document_type ?? 'Document',
    period: parsed.period && parsed.period !== 'Not stated' ? parsed.period : null,
    hasTractionData: Boolean(parsed.has_traction_data) && bullets.length > 0,
    model: response.model ?? MODEL,
    usage: response.usage ?? null,
    estimatedCostUsd: estimateCost(response.usage),
  };
}
