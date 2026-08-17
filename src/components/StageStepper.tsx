import { STAGES } from '../lib/funnel';

/**
 * The funnel as a physical narrowing, not a row of equal boxes.
 *
 * Each stage shows its count AND the share of Stage 1 that survives to it, drawn as a
 * chartreuse bar along the bottom edge -- so the shape of the funnel is legible at a glance
 * instead of having to compare five bare figures. The selected stage is the loud one; the
 * rest stay quiet until hovered.
 */
export function StageStepper({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<number, number>;
  selected: number;
  onSelect: (n: number) => void;
}) {
  const total = counts[STAGES[0].n] || 1;

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {STAGES.map((s, i) => {
        const isSelected = s.n === selected;
        const count = counts[s.n] ?? 0;
        const share = Math.max(0, Math.min(1, count / total));
        const isLast = i === STAGES.length - 1;

        return (
          <div key={s.n} className="flex items-stretch gap-2">
            <button
              onClick={() => onSelect(s.n)}
              aria-pressed={isSelected}
              className="q-card q-lift relative overflow-hidden text-left px-4 py-3 min-w-[152px] cursor-pointer"
              style={isSelected ? { borderColor: 'var(--text-h)', boxShadow: 'var(--shadow-md)' } : undefined}
            >
              {/* Survival bar: how much of Stage 1 is still standing at this stage. */}
              <span
                aria-hidden
                className="absolute left-0 bottom-0 h-[3px]"
                style={{
                  width: `${share * 100}%`,
                  background: isSelected ? 'var(--text-h)' : 'var(--accent)',
                  transition: 'width 420ms cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              />
              <div className="flex items-center gap-1.5">
                <span
                  className="w-4 h-4 rounded-full grid place-items-center text-[9px] font-bold"
                  style={{
                    background: isSelected ? 'var(--text-h)' : 'var(--accent)',
                    color: isSelected ? '#fff' : 'var(--text-h)',
                  }}
                >
                  {s.n}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-semibold">
                  {isLast ? 'Watchlist' : `Stage ${s.n}`}
                </span>
              </div>

              <div className="text-[13px] font-bold text-[var(--text-h)] mt-1 leading-tight">{s.label}</div>

              <div className="flex items-baseline gap-1.5 mt-1">
                <span className="text-2xl font-extrabold tracking-tight text-[var(--text-h)] tabular-nums">
                  {count.toLocaleString()}
                </span>
                <span className="text-[10px] text-[var(--text-dim)] font-medium">
                  {(share * 100).toFixed(share < 0.1 ? 1 : 0)}%
                </span>
              </div>
            </button>

            {!isLast && (
              <div aria-hidden className="grid place-items-center text-[var(--border-strong)] select-none">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
