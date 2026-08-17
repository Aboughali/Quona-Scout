/** Automatic research architecture (case brief Parts 5, 6, 10).
 *
 *  This app is a static frontend with no backend and no configured API keys -- it cannot
 *  reach Crunchbase, a search API, or any other live web-research source at runtime. Per
 *  explicit instruction ("DO NOT fake web automation"), this module never fabricates a
 *  researched value. Every automatic research attempt honestly resolves to
 *  "insufficient-evidence" and names what's missing, while the rest of the pipeline
 *  (company creation, round save, investor onboarding, scoring, funnel recompute) is fully
 *  wired to actually USE a real result the moment one is available.
 *
 *  To make this real: implement `runCompanyResearch`/`runInvestorResearch` against a backend
 *  that can call out to the web (e.g. a small server endpoint using a search API + an LLM to
 *  extract structured fields, or a Crunchbase/Africa-the-Big-Deal data API), each returning
 *  ResearchResult with status 'complete' and a message summarizing what was found + sourced.
 *  Nothing else in the app needs to change -- every caller already persists whatever
 *  ResearchResult comes back through the existing field-edit engine.
 */

export type ResearchStatus = 'researching' | 'complete' | 'insufficient-evidence' | 'error';

export interface ResearchResult {
  status: ResearchStatus;
  message: string;
  startedAt: string;
  completedAt: string;
}

export const RESEARCH_NOT_CONFIGURED_MESSAGE =
  'No web-research backend is configured for this deployment -- no search/data API is connected. ' +
  'Automatic research cannot run; add a backend (see Methodology) to enable it.';

export function researchingPlaceholder(): ResearchResult {
  return { status: 'researching', message: 'Researching…', startedAt: new Date().toISOString(), completedAt: '' };
}

async function noResearchBackendAvailable(): Promise<ResearchResult> {
  const startedAt = new Date().toISOString();
  // The await keeps this genuinely asynchronous (a real backend call would be too) so the
  // UI's "researching..." state is honest rather than a fake delay for show.
  await Promise.resolve();
  return { status: 'insufficient-evidence', message: RESEARCH_NOT_CONFIGURED_MESSAGE, startedAt, completedAt: new Date().toISOString() };
}

export async function runCompanyResearch(_companyName: string): Promise<ResearchResult> {
  return noResearchBackendAvailable();
}

export async function runInvestorResearch(_investorName: string): Promise<ResearchResult> {
  return noResearchBackendAvailable();
}
