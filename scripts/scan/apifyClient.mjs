/**
 * Minimal Apify REST client.
 *
 * Deliberately uses plain `fetch` rather than the apify-client SDK: the surface needed is two
 * endpoints, and keeping it dependency-free means this module drops into a serverless function
 * later with no install step. The token is ONLY ever read from the environment by the caller
 * and passed in -- it is never read from disk here, never logged, and never returned.
 */

const APIFY_BASE = 'https://api.apify.com/v2';

/** Actors chosen per access method. See config/news_sources.json for why each source uses one. */
export const ACTORS = {
  /** Clean article text from JS-rendered pages, with boilerplate stripped.
   *  Verified to exist in the Apify store (apify/website-content-crawler, ~39M runs). */
  crawler: 'apify~website-content-crawler',
};

// NOTE: there is deliberately no RSS Actor here. Apify publishes no official RSS scraper, and
// RSS is plain XML over HTTP -- see scripts/scan/rssReader.mjs, which fetches feeds natively
// at zero cost. Apify is used only for sources that genuinely need a browser.

export class ApifyError extends Error {
  constructor(message, { status, actorId, runId } = {}) {
    super(message);
    this.name = 'ApifyError';
    this.status = status;
    this.actorId = actorId;
    this.runId = runId;
  }
}

/**
 * Runs an Actor to completion and returns its dataset items.
 * `timeoutSecs` bounds the Apify-side run; `memoryMbytes` bounds cost.
 */
export async function runActor(token, actorId, input, { timeoutSecs = 180, memoryMbytes = 1024 } = {}) {
  if (!token) throw new ApifyError('No Apify token supplied');

  const url =
    `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${timeoutSecs}&memory=${memoryMbytes}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    throw new ApifyError(`Network error calling Apify: ${cause.message}`, { actorId });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Never echo the URL back -- it carries the token.
    throw new ApifyError(
      `Apify actor ${actorId} failed with HTTP ${res.status}. ${body.slice(0, 400)}`,
      { status: res.status, actorId }
    );
  }

  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

/** Cheap credential check so the UI can tell "bad token" apart from "source is down". */
export async function verifyToken(token) {
  if (!token) return { ok: false, reason: 'APIFY_TOKEN is not set' };
  try {
    const res = await fetch(`${APIFY_BASE}/users/me?token=${encodeURIComponent(token)}`);
    if (res.status === 401) return { ok: false, reason: 'APIFY_TOKEN was rejected (401)' };
    if (!res.ok) return { ok: false, reason: `Apify returned HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, username: body?.data?.username ?? null };
  } catch (cause) {
    return { ok: false, reason: `Could not reach Apify: ${cause.message}` };
  }
}
