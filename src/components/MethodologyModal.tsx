export function MethodologyModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-6" onClick={onClose}>
      <div
        className="max-w-2xl w-full max-h-[85vh] overflow-y-auto bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg p-6 space-y-4 text-sm text-[var(--text)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-h)]">Methodology</h2>
          <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text-h)]">✕</button>
        </div>

        <section>
          <h3 className="font-semibold text-[var(--text-h)] mb-1">Intake window</h3>
          <p>Aug 1, 2023 – Aug 12, 2026. Outer frame for every company in the system, not a filter stage.</p>
        </section>

        <section>
          <h3 className="font-semibold text-[var(--text-h)] mb-1">The 6 stages</h3>
          <ol className="list-decimal list-inside space-y-1">
            <li><b>All Raised</b> — every African startup that raised a round in the window, any sector.</li>
            <li><b>Fintech Filter</b> — sector = fintech, or fintech-adjacent (payments, lending, embedded finance, trade finance, financial infrastructure). Adjacent cases are analyst-reviewed, not keyword-auto-passed — see each company's override note.</li>
            <li><b>Stage Check</b> — no Series A or later round on record. Bridge/extension/pre-Series A still count as Seed. Companies with an M&A/acquisition event are hard-excluded (no longer an independent investable target), same logic as the spec's shutdown exclusion.</li>
            <li><b>Geography Check</b> — HQ/team in Egypt or South Africa (auto), or manually-confirmed 3+ African markets (override, always with a note).</li>
            <li><b>Syndicate Check</b> — binary pass/fail: at least one named investor meets the qualitative strong-syndicate rubric. Companies passing this form the final watchlist.</li>
          </ol>
        </section>

        <section>
          <h3 className="font-semibold text-[var(--text-h)] mb-1">Stage 5 binary rubric (this build's operationalization)</h3>
          <p>
            An investor qualifies as a strong anchor for a company if <b>all three</b> hold: (1) local presence — direct
            office/team in the company's country, or pan-African reach as partial credit; (2) not in fund harvest mode —
            follow-on capacity proxy (fund vintage age) is Medium or better; (3) evidenced fintech thesis or co-investment
            reputation — at least one of those two dimensions rated ≥3/5 from real research. Missing evidence fails that
            criterion (conservative reading, documented rather than hidden). This is deliberately simpler than the 0-100
            engine below — that engine is reserved for narrowing the watchlist to 2-3 picks, per spec.
          </p>
        </section>

        <section>
          <h3 className="font-semibold text-[var(--text-h)] mb-1">0-100 syndicate scoring engine</h3>
          <p>
            9 dimensions: 4 High-tier (weight 16 each) — Local Country Presence (deal-relative), Series A Follow-on
            Capacity (fund-vintage proxy), Fintech Portfolio Depth, Co-Investment Reputation; 5 Medium-tier (weight 7.2
            each) — African Market Expertise, Global/Cross-Border Network, Operational Support Bench, Regulatory/Gov
            Relationships, Historical Investment Outcomes. Each rated 1-5 where evidence exists, normalized to 0-1, weighted,
            and averaged over only the dimensions actually scored — never fabricated to fill a blank. Bands: 65-100 Strong,
            40-64 Moderate, 0-39 Weak, Unscored if fewer than 1 High-tier dimension has evidence. A company's overall score
            is the highest score among its named investors.
          </p>
        </section>

        <section>
          <h3 className="font-semibold text-[var(--text-h)] mb-1">Visible judgment, not hidden assumption</h3>
          <p>
            Every override (fintech pivot, Series A reclassification, 3+ markets geography, syndicate judgment) is off by
            default, requires a note when activated, and is always visible on the company record — never folded silently
            into a score. Companies are never deleted when cut; they persist with a visible cut-reason, greyed out at any
            stage view past their cut point (toggle "Show cut companies").
          </p>
        </section>

        <section>
          <h3 className="font-semibold text-[var(--text-h)] mb-1">Investor Judgment / Edit Mode</h3>
          <p>
            Every field on a company record — profile, funding, investors, and all four classification gates — can be
            edited from the profile drawer or directly from a table cell. The original research value is never
            overwritten: each edit is stored as a layer on top (original value, current value, reason, source,
            confidence, evidence link, author, timestamp), and the funnel always recalculates from the current active
            value. "Revert to original" removes the layer and restores the automated value instantly. The full record —
            both AI/research values and investor overrides — is visible in each field's editor and in the company's
            Change History. The "Needs Review" tab surfaces the ambiguous, low-confidence, or unresolved signals worth
            an investor's attention first.
          </p>
        </section>
      </div>
    </div>
  );
}
