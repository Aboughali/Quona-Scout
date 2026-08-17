/** Types for the traction entry point (analyse.mjs). */
export type TractionUploadKind = 'pitch-deck' | 'financials' | 'other';
export type TractionAiStatus = 'summarised' | 'no-traction-found' | 'unavailable';

export interface TractionUploadEntry {
  id: string;
  companyId: string;
  kind: TractionUploadKind;
  fileName: string;
  fileSizeBytes: number;
  /** Path under data/traction, resolved by GET /api/traction/file. */
  filePath: string;
  uploadedAt: string;
  bullets: string[];
  aiStatus: TractionAiStatus;
  /** Why there is no usable summary. Null when one was produced. */
  aiNote?: string | null;
  docKind?: string;
  period?: string | null;
  model?: string;
  truncated?: boolean;
  estimatedCostUsd?: number | null;
}

export interface TractionAnalysisResult {
  ok: boolean;
  error?: string;
  /** Present whenever the upload itself succeeded -- including when the summary could not be
   *  produced, in which case aiStatus is 'unavailable' and aiNote says why. */
  entry?: TractionUploadEntry;
}

export function analyseUpload(args: {
  companyId: string;
  companyName?: string;
  fileName: string;
  kind?: TractionUploadKind;
  buffer: Buffer;
  log?: (msg: string) => void;
}): Promise<TractionAnalysisResult>;

export const SUPPORTED_EXTENSIONS: string[];
