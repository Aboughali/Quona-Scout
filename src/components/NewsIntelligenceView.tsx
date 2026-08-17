import { useCallback, useEffect, useState } from 'react';

/** Where the scan runner lives. Today this is the Vite dev-server middleware backed by the
 *  local Node script; pointing it at a deployed serverless function later is a one-line change
 *  and needs no other edits, because the response shape is the same. */
const SCAN_ENDPOINT = '/api/scan';

interface SourceStatus {
  name: string;
  domain: string;
  enabled: boolean;
  sourceType: string;
  accessMethod: string;
  priority: number;
  lastScan: string | null;
  lastSuccess: string | null;
  note?: string;
}

interface SourceResult {
  name: string;
  status: string;
  reason?: string;
  fetched?: number;
  kept?: number;
  skippedDuplicate?: number;
  skippedIrrelevant?: number;
  skippedOld?: number;
}

interface ScanRun {
  startedAt: string;
  finishedAt: string;
  trigger: string;
  findingsAdded: number;
  sourceResults: SourceResult[];
}

interface StatusPayload {
  ok: boolean;
  findingCount: number;
  lastRun: ScanRun | null;
  sources: SourceStatus[];
  error?: string;
}

function fmt(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function NewsIntelligenceView() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [runHint, setRunHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(SCAN_ENDPOINT);
      if (!res.ok) throw new Error(`Status endpoint returned HTTP ${res.status}`);
      setStatus(await res.json());
      setLoadError(null);
    } catch {
      // The live scan runner is a dev-server endpoint and is intentionally absent from the
      // static production build (see vite.config.ts). This is expected on the deployed site, so
      // the message is framed as a deliberate limitation rather than an error -- the historical
      // news dataset shown on each company profile does not depend on it.
      setLoadError(
        'Live web scanning is disabled in this deployed prototype — it runs only in the local development environment. ' +
        'The historical News & Intelligence dataset below and on each company profile is served from the build and is fully available.'
      );
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function runScanNow() {
    setRunning(true);
    setRunError(null);
    setRunHint(null);
    setRunLog([]);
    try {
      const res = await fetch(SCAN_ENDPOINT, { method: 'POST' });
      const body = await res.json();
      setRunLog(body.log ?? []);
      if (!body.ok) {
        setRunError(body.error ?? 'Scan failed.');
        setRunHint(body.hint ?? null);
      }
      await refresh();
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const enabled = status?.sources.filter((s) => s.enabled) ?? [];
  const disabled = status?.sources.filter((s) => !s.enabled) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-h)]">News &amp; Intelligence</h2>
          <p className="text-xs text-[var(--text-dim)] max-w-2xl">
            Phase 1: Apify collects raw articles from the configured sources into an append-only findings store.
            Nothing here writes to company data yet — company matching, funding extraction and the approval queue
            arrive in Phase 2. Scheduling is deliberately off; runs are manual only.
          </p>
        </div>
        <button
          onClick={runScanNow}
          disabled={running || !!loadError}
          className="text-xs px-3 py-1.5 rounded-md bg-[var(--accent)] text-[#0b0c10] font-semibold disabled:opacity-40"
        >
          {running ? 'Scanning…' : loadError ? 'Live Scan Unavailable' : 'Run Web Scan Now'}
        </button>
      </div>

      {loadError && (
        <div className="border rounded-md p-3 text-xs" style={{ borderColor: 'var(--moderate)', color: 'var(--moderate)' }}>
          {loadError}
        </div>
      )}

      {runError && (
        <div className="border rounded-md p-3 text-xs space-y-1" style={{ borderColor: 'var(--weak)' }}>
          <p style={{ color: 'var(--weak)' }} className="font-medium">Scan failed: {runError}</p>
          {runHint && <p className="text-[var(--text-dim)]">{runHint}</p>}
        </div>
      )}

      {status && (
        <div className="grid grid-cols-3 gap-3">
          <div className="border border-[var(--border)] rounded-md p-3">
            <div className="text-xs text-[var(--text-dim)]">Raw findings stored</div>
            <div className="text-2xl font-semibold text-[var(--text-h)]">{status.findingCount.toLocaleString()}</div>
          </div>
          <div className="border border-[var(--border)] rounded-md p-3">
            <div className="text-xs text-[var(--text-dim)]">Sources enabled</div>
            <div className="text-2xl font-semibold text-[var(--text-h)]">
              {enabled.length}<span className="text-xs font-normal text-[var(--text-dim)]"> of {status.sources.length}</span>
            </div>
          </div>
          <div className="border border-[var(--border)] rounded-md p-3">
            <div className="text-xs text-[var(--text-dim)]">Last run</div>
            <div className="text-sm font-medium text-[var(--text-h)]">{fmt(status.lastRun?.finishedAt ?? null)}</div>
            {status.lastRun && (
              <div className="text-xs text-[var(--text-dim)]">{status.lastRun.findingsAdded} findings added</div>
            )}
          </div>
        </div>
      )}

      {runLog.length > 0 && (
        <div className="border border-[var(--border)] rounded-md p-3">
          <h3 className="text-xs font-semibold text-[var(--text-h)] uppercase mb-1.5">Run log</h3>
          <pre className="text-[11px] text-[var(--text-dim)] whitespace-pre-wrap">{runLog.join('\n')}</pre>
        </div>
      )}

      {status?.lastRun && status.lastRun.sourceResults.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-h)] mb-2">Last run by source</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-[var(--text-dim)] border-b border-[var(--border)]">
                  <th className="py-1.5 pr-3">Source</th><th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">Fetched</th><th className="py-1.5 pr-3">Kept</th>
                  <th className="py-1.5 pr-3">Filtered out</th>
                </tr>
              </thead>
              <tbody>
                {status.lastRun.sourceResults.map((r) => (
                  <tr key={r.name} className="border-b border-[var(--border)]">
                    <td className="py-1.5 pr-3 text-[var(--text-h)]">{r.name}</td>
                    <td className="py-1.5 pr-3" style={{ color: r.status === 'ok' ? 'var(--strong)' : r.status === 'error' ? 'var(--weak)' : 'var(--text-dim)' }}>
                      {r.status}{r.reason ? ` — ${r.reason}` : ''}
                    </td>
                    <td className="py-1.5 pr-3">{r.fetched ?? '—'}</td>
                    <td className="py-1.5 pr-3">{r.kept ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-[var(--text-dim)]">
                      {r.skippedDuplicate ?? 0} dup · {r.skippedIrrelevant ?? 0} off-topic · {r.skippedOld ?? 0} old
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {status && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-h)] mb-2">Configured sources</h3>
          <p className="text-xs text-[var(--text-dim)] mb-2">
            Edit <code>config/news_sources.json</code> to add, remove or disable a source — no code changes needed.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-[var(--text-dim)] border-b border-[var(--border)]">
                  <th className="py-1.5 pr-3">Source</th><th className="py-1.5 pr-3">Type</th>
                  <th className="py-1.5 pr-3">Access</th><th className="py-1.5 pr-3">Last success</th>
                </tr>
              </thead>
              <tbody>
                {enabled.map((s) => (
                  <tr key={s.name} className="border-b border-[var(--border)]">
                    <td className="py-1.5 pr-3 text-[var(--text-h)]">{s.name}</td>
                    <td className="py-1.5 pr-3 text-[var(--text-dim)]">{s.sourceType}</td>
                    <td className="py-1.5 pr-3 text-[var(--text-dim)]">{s.accessMethod}</td>
                    <td className="py-1.5 pr-3 text-[var(--text-dim)]">{fmt(s.lastSuccess)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {disabled.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-[var(--text-h)] uppercase mb-1.5">
                Disabled — not accessible without a paid licence
              </h4>
              <div className="space-y-1.5">
                {disabled.map((s) => (
                  <div key={s.name} className="border border-[var(--border)] rounded p-2 text-xs">
                    <span className="text-[var(--text-h)] font-medium">{s.name}</span>
                    <p className="text-[var(--text-dim)] mt-0.5">{s.note}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
