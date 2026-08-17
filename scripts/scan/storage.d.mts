/** Types for the file-backed scan storage adapter (storage.mjs). */
export interface ScanSourceConfig {
  name: string; domain: string; enabled: boolean; sourceType: string;
  accessMethod: string; priority: number;
  lastScan: string | null; lastSuccess: string | null; note?: string;
  [key: string]: unknown;
}
export interface ScanConfig { defaults: Record<string, unknown>; sources: ScanSourceConfig[]; [key: string]: unknown }

export type Finding = Record<string, unknown>;
export type Signal = Record<string, unknown>;

/** Thrown when a write would lose data. Let it propagate: the live file is left untouched. */
export class DataLossError extends Error {
  name: 'DataLossError';
  details: Record<string, unknown>;
}
/** Thrown when a store on disk cannot be trusted. Never downgraded to an empty array. */
export class CorruptStoreError extends Error {
  name: 'CorruptStoreError';
  filePath: string;
}

/** Paths are resolved per call so QUONA_DATA_ROOT can redirect the whole store (tests). */
export function configPath(): string;
export function findingsPath(): string;
export function scanLogPath(): string;
export function signalsPath(): string;
export function autoBackupDir(): string;

export function loadConfig(): Promise<ScanConfig>;
export function saveConfig(config: ScanConfig): Promise<void>;

/** Throws CorruptStoreError on malformed/empty/unreadable input. Missing file -> []. */
export function loadFindings(): Promise<Finding[]>;
export function loadSignals(): Promise<Signal[]>;
export function loadScanRuns(): Promise<Record<string, unknown>[]>;

export interface WriteReport {
  ok: true; existingCount: number; proposedCount: number;
  added: number; retained: number; dropped: number;
  destructive?: boolean; backup?: string | null;
}

export function identityOf(finding: Finding): string;
export function assertNoFindingsLost(existing: Finding[], proposed: Finding[], opts?: { operation?: string }): WriteReport;
export function writeFindingsGuarded(proposed: Finding[], opts?: { operation?: string; allowDestructive?: boolean }): Promise<WriteReport>;
export function appendFindings(findings: Finding[]): Promise<WriteReport & { total: number; duplicates: number }>;
export function rewriteFindingsInPlace(mapFn: (f: Finding, i: number) => Finding, opts?: { operation?: string }): Promise<WriteReport>;

/** REMOVED -- always throws. Use appendFindings / rewriteFindingsInPlace / promoteStagingRun. */
export function saveFindings(...args: unknown[]): Promise<never>;

export function backupBeforeWrite(filePath: string): Promise<string | null>;
export function atomicWriteJson(filePath: string, data: unknown, opts?: { expectCount?: number | null }): Promise<string>;

export function signalEventKey(sig: Signal): string;
/** Union merge: stored signals always survive, user decisions are never reset. */
export function mergeSignals(incoming: Signal[]): Promise<{ signals: Signal[]; existingCount: number; finalCount: number; backup: string | null }>;

export function appendScanRun(run: Record<string, unknown>): Promise<number>;
export function recordSourceResults(config: ScanConfig, results: Record<string, unknown>[]): Promise<void>;

/** Backfill run summary appended to the scan log by backfillCli.mjs. */
export interface BackfillRun {
  runId: string;
  startedAt: string; finishedAt: string; trigger: 'backfill'; dryRun: boolean;
  scope: 'watchlist' | 'stage4' | 'all' | 'explicit-ids';
  findingsStaged: number;
  findingsAdded: number;
  existingFindings: number;
  duplicates: number;
  rejected: number;
  sourcesScanned: string[];
  stagingSucceeded: boolean;
  validationSucceeded: boolean | null;
  promoted: boolean;
  finalLiveFindingCount: number;
  sourceResults: { name: string; requests: number; kept: number; errors: number; status: string }[];
  stats: Record<string, unknown>;
}
