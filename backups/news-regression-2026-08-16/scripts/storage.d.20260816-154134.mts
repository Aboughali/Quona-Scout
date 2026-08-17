/** Types for the file-backed scan storage adapter (storage.mjs). */
export interface ScanSourceConfig {
  name: string; domain: string; enabled: boolean; sourceType: string;
  accessMethod: string; priority: number;
  lastScan: string | null; lastSuccess: string | null; note?: string;
  [key: string]: unknown;
}
export interface ScanConfig { defaults: Record<string, unknown>; sources: ScanSourceConfig[]; [key: string]: unknown }
export function loadConfig(): Promise<ScanConfig>;
export function saveConfig(config: ScanConfig): Promise<void>;
export function loadFindings(): Promise<Record<string, unknown>[]>;
export function appendFindings(findings: Record<string, unknown>[]): Promise<number>;
export function loadScanRuns(): Promise<Record<string, unknown>[]>;
export function appendScanRun(run: Record<string, unknown>): Promise<void>;
export function recordSourceResults(config: ScanConfig, results: Record<string, unknown>[]): Promise<void>;
export const CONFIG_PATH: string;
export const FINDINGS_PATH: string;
export const SCAN_LOG_PATH: string;

/** Backfill run summary appended to the scan log by backfillCli.mjs. */
export interface BackfillRun {
  startedAt: string; finishedAt: string; trigger: 'backfill'; dryRun: boolean;
  scope: 'watchlist' | 'stage4' | 'all';
  findingsAdded: number;
  sourceResults: { name: string; requests: number; kept: number; errors: number; status: string }[];
  stats: Record<string, unknown>;
}
