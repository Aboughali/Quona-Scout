import { useMemo, useState } from 'react';
import type { Company } from '../types';
import {
  classifyFintechSegment,
  classifyGeography,
  countBy,
  FINTECH_SEGMENTS,
  GEO_SEGMENTS,
  type SegmentCount,
} from '../lib/segments';

/** Brand-adjacent categorical palette: chartreuse and Quona blue lead, then hues chosen to stay
 *  distinguishable at small sizes on white. Grey is reserved for the residual bucket. */
const SERIES_COLORS = ['#d3f87b', '#7cc4f5', '#1f5c96', '#f0a04b', '#a78bfa', '#34d399', '#f472b6'];
const RESIDUAL_COLOR = '#cdd5c6';

function colorFor(label: string, i: number): string {
  return label.startsWith('Other') || label === 'Single market' ? RESIDUAL_COLOR : SERIES_COLORS[i % SERIES_COLORS.length];
}

/** Vertical bars with the value called out above each -- the fastest read for 3-4 categories. */
function BarChart({ data, onSelect, selected }: { data: SegmentCount<string>[]; onSelect: (l: string | null) => void; selected: string | null }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-3 h-[168px] px-1">
      {data.map((d, i) => {
        const heightPct = (d.count / max) * 100;
        const isDim = selected != null && selected !== d.label;
        return (
          <button
            key={d.label}
            onClick={() => onSelect(selected === d.label ? null : d.label)}
            className="flex-1 flex flex-col items-center justify-end h-full group"
            title={`${d.label}: ${d.count} (${(d.share * 100).toFixed(1)}%)`}
          >
            <span className="text-[13px] font-extrabold text-[var(--text-h)] mb-1 tabular-nums">{d.count}</span>
            <span
              className="w-full rounded-t-lg"
              style={{
                height: `${Math.max(heightPct, d.count > 0 ? 3 : 0)}%`,
                minHeight: d.count > 0 ? 4 : 0,
                background: colorFor(d.label, i),
                opacity: isDim ? 0.35 : 1,
                transition: 'height 420ms cubic-bezier(0.4,0,0.2,1), opacity 160ms ease',
              }}
            />
            <span className="text-[10px] text-[var(--text-dim)] mt-1.5 text-center leading-tight font-medium">{d.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Donut + legend. Uses stroke-dasharray on a single circle so each slice is one cheap element. */
function DonutChart({ data, onSelect, selected }: { data: SegmentCount<string>[]; onSelect: (l: string | null) => void; selected: string | null }) {
  const R = 54;
  const C = 2 * Math.PI * R;
  const shown = data.filter((d) => d.count > 0);
  const total = shown.reduce((s, d) => s + d.count, 0);

  let offset = 0;
  const arcs = shown.map((d) => {
    const originalIndex = data.findIndex((x) => x.label === d.label);
    const frac = total ? d.count / total : 0;
    const arc = { ...d, dash: frac * C, offset, color: colorFor(d.label, originalIndex) };
    offset += frac * C;
    return arc;
  });

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg width="132" height="132" viewBox="0 0 132 132" className="shrink-0">
        <g transform="rotate(-90 66 66)">
          {arcs.map((a) => {
            const isDim = selected != null && selected !== a.label;
            return (
              <circle
                key={a.label}
                cx="66"
                cy="66"
                r={R}
                fill="none"
                stroke={a.color}
                strokeWidth="17"
                strokeDasharray={`${Math.max(0, a.dash - 1.5)} ${C}`}
                strokeDashoffset={-a.offset}
                style={{ opacity: isDim ? 0.3 : 1, transition: 'opacity 160ms ease, stroke-dasharray 420ms cubic-bezier(0.4,0,0.2,1)' }}
              />
            );
          })}
        </g>
        <text x="66" y="62" textAnchor="middle" className="fill-[var(--text-h)]" style={{ fontSize: 20, fontWeight: 800 }}>
          {total}
        </text>
        <text x="66" y="78" textAnchor="middle" className="fill-[var(--text-dim)]" style={{ fontSize: 9, fontWeight: 600 }}>
          companies
        </text>
      </svg>

      <div className="flex-1 min-w-[190px] space-y-0.5">
        {data.map((d, i) => {
          const isDim = selected != null && selected !== d.label;
          return (
            <button
              key={d.label}
              onClick={() => onSelect(selected === d.label ? null : d.label)}
              className="w-full flex items-center gap-2 text-left px-1.5 py-[3px] rounded-md hover:bg-[var(--bg-soft)]"
              style={{ opacity: isDim ? 0.45 : 1 }}
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colorFor(d.label, i) }} />
              <span className="text-[11px] text-[var(--text)] flex-1 truncate">{d.label}</span>
              <span className="text-[11px] font-bold text-[var(--text-h)] tabular-nums">{d.count}</span>
              <span className="text-[10px] text-[var(--text-dim)] tabular-nums w-9 text-right">
                {(d.share * 100).toFixed(0)}%
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Two breakdowns of whatever population the selected stage currently holds. Because the
 * companies passed in are the stage-active set, these re-segment automatically as you move
 * through the funnel -- Stage 1 shows all 828, the watchlist shows only its survivors.
 */
export function StageCharts({ companies, stageLabel }: { companies: Company[]; stageLabel: string }) {
  const [geoFocus, setGeoFocus] = useState<string | null>(null);
  const [subFocus, setSubFocus] = useState<string | null>(null);

  const geo = useMemo(() => countBy(companies, GEO_SEGMENTS, classifyGeography), [companies]);
  const sub = useMemo(() => countBy(companies, FINTECH_SEGMENTS, classifyFintechSegment), [companies]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="q-card p-4">
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-[13px] font-bold text-[var(--text-h)]">Geography</h3>
          <span className="text-[10px] text-[var(--text-dim)]">{stageLabel} · {companies.length} companies</span>
        </div>
        <p className="text-[10px] text-[var(--text-dim)] mb-2">Same test as Stage 4: Egypt and South Africa auto-pass; others need 3+ African markets.</p>
        <BarChart data={geo} onSelect={setGeoFocus} selected={geoFocus} />
      </div>

      <div className="q-card p-4">
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-[13px] font-bold text-[var(--text-h)]">Fintech sub-sector</h3>
          <span className="text-[10px] text-[var(--text-dim)]">{stageLabel}</span>
        </div>
        <p className="text-[10px] text-[var(--text-dim)] mb-2">
          From the researched sub-sector where recorded, otherwise inferred from the business description.
        </p>
        <DonutChart data={sub} onSelect={setSubFocus} selected={subFocus} />
      </div>
    </div>
  );
}
