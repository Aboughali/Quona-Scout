import type { EditConfidence, Fund } from '../types';
import { fundEntityId } from './funds';
import { normalizeInvestorName } from './funnel';
import { researchingPlaceholder, runInvestorResearch } from './research';

type OverrideFieldFn = (
  entity: string,
  path: string,
  originalValue: unknown,
  originalSource: string,
  input: { newValue: unknown; reason: string; source: string; evidenceUrl?: string; confidence?: EditConfidence }
) => void;

/** Case brief Part 6/23/27: entering investor names on a funding round must never require a
 *  separate "go add them to the syndicate, then research, then score" pass. For every name
 *  that has no existing fund profile (static research OR a previously investor-created stub),
 *  this auto-creates a minimal profile and kicks off research in the background --
 *  fire-and-forget, never blocks the round save. Investors that already have a profile are
 *  left completely untouched: their existing dimension ratings (including any manual score
 *  override -- Part 29) are reused exactly as-is, never re-researched or overwritten.
 *
 *  Returns the names that were newly onboarded, for UI feedback. */
export function onboardNewInvestors(names: string[], fundIndex: Map<string, Fund>, overrideField: OverrideFieldFn): string[] {
  const created: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    const key = normalizeInvestorName(trimmed);
    if (!key || seen.has(key) || fundIndex.has(key)) continue;
    seen.add(key);
    created.push(trimmed);

    const entity = fundEntityId(trimmed);
    overrideField(entity, 'displayName', trimmed, 'Investor-added', {
      newValue: trimmed,
      reason: 'Auto-created from round investor list',
      source: 'System — automatic onboarding',
    });
    overrideField(entity, 'research.investor', null, 'Not yet researched', {
      newValue: researchingPlaceholder(),
      reason: 'Automatic research started',
      source: 'System — automatic research',
    });

    runInvestorResearch(trimmed).then((result) => {
      overrideField(entity, 'research.investor', null, 'Not yet researched', {
        newValue: result,
        reason: 'Automatic research completed',
        source: 'System — automatic research',
      });
    });
  }
  return created;
}
