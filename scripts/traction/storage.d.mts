/** Types for the file-backed traction storage adapter (storage.mjs). */
export function safeFileName(fileName?: string): string;
export function uid(): string;
export function saveUpload(
  companyId: string,
  fileName: string,
  buffer: Buffer
): Promise<{ id: string; storedAs: string; relPath: string; sizeBytes: number }>;
/** Returns an absolute path only when it resolves inside data/traction; null otherwise. */
export function resolveStoredFile(relPath: string): string | null;
export function loadUploadLog(): Promise<Record<string, unknown>[]>;
export function appendUploadLog(record: Record<string, unknown>): Promise<number>;
export const TRACTION_DIR: string;
export const UPLOAD_LOG_PATH: string;
