/** Types for the scan entry point (cli.mjs). */
export interface ScanSourceResult {
  name: string; status: string; reason?: string;
  fetched?: number; kept?: number;
  skippedDuplicate?: number; skippedIrrelevant?: number; skippedOld?: number;
}
export interface ScanResult {
  ok: boolean; error?: string; hint?: string;
  startedAt?: string; finishedAt?: string; trigger?: string; dryRun?: boolean;
  findingsAdded: number; sourceResults: ScanSourceResult[];
}
export function executeScan(options?: { log?: (msg: string) => void; dryRun?: boolean; only?: string[] | null }): Promise<ScanResult>;
export function loadEnv(): Promise<void>;
