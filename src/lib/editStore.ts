import type { CommentaryNote, Company, CompanyFieldStates, EditConfidence, FieldEditEntry, FieldState, SourceEntry } from '../types';
import { loadTraction, saveTraction, type TractionStore } from './traction';

const EDITS_KEY = 'quona-scout-field-edits-v1';
const COMMENTARY_KEY = 'quona-scout-commentary-v1';
const USER_KEY = 'quona-scout-user-name-v1';
const MANUAL_COMPANIES_KEY = 'quona-scout-manual-companies-v1';

export type EditsStore = Record<string, CompanyFieldStates>; // companyId -> fieldPath -> FieldState
export type CommentaryStore = Record<string, CommentaryNote[]>; // companyId -> notes

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function loadEdits(): EditsStore {
  try {
    const raw = localStorage.getItem(EDITS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveEdits(store: EditsStore) {
  localStorage.setItem(EDITS_KEY, JSON.stringify(store));
}

export function loadCommentary(): CommentaryStore {
  try {
    const raw = localStorage.getItem(COMMENTARY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveCommentary(store: CommentaryStore) {
  localStorage.setItem(COMMENTARY_KEY, JSON.stringify(store));
}

export function loadUserName(): string {
  try {
    return localStorage.getItem(USER_KEY) || 'Investor';
  } catch {
    return 'Investor';
  }
}

export function saveUserName(name: string) {
  localStorage.setItem(USER_KEY, name);
}

/** Companies created via "+ Add Company" -- a 4th localStorage key, separate from field-edits
 *  because these ARE a baseline (a fully-shaped Company) rather than an edit layered on top of
 *  one. Concatenated with the static companies.json list at render time (see App.tsx). */
export function loadManualCompanies(): Company[] {
  try {
    const raw = localStorage.getItem(MANUAL_COMPANIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveManualCompanies(companies: Company[]) {
  localStorage.setItem(MANUAL_COMPANIES_KEY, JSON.stringify(companies));
}

/** Gets (or lazily initializes) the FieldState for a field, given the original value/source from static data. */
export function getFieldState(
  store: EditsStore,
  companyId: string,
  fieldPath: string,
  originalValue: unknown,
  originalSource: string
): FieldState {
  const existing = store[companyId]?.[fieldPath];
  if (existing) return existing;
  return {
    fieldPath,
    originalValue,
    originalSource,
    currentValue: originalValue,
    isOverridden: false,
    sources: [],
    history: [],
  };
}

export interface OverrideInput {
  newValue: unknown;
  reason: string;
  source: string;
  evidenceUrl?: string;
  confidence?: EditConfidence;
  user: string;
}

export function applyFieldOverride(store: EditsStore, companyId: string, fieldPath: string, base: FieldState, input: OverrideInput): EditsStore {
  const entry: FieldEditEntry = {
    id: uid(),
    timestamp: new Date().toISOString(),
    user: input.user,
    kind: 'override',
    previousValue: base.currentValue,
    newValue: input.newValue,
    reason: input.reason,
    source: input.source,
    evidenceUrl: input.evidenceUrl,
    confidence: input.confidence,
  };
  const nextField: FieldState = {
    ...base,
    currentValue: input.newValue,
    isOverridden: true,
    history: [...base.history, entry],
  };
  return {
    ...store,
    [companyId]: { ...(store[companyId] ?? {}), [fieldPath]: nextField },
  };
}

export function revertField(store: EditsStore, companyId: string, fieldPath: string, base: FieldState, user: string): EditsStore {
  const entry: FieldEditEntry = {
    id: uid(),
    timestamp: new Date().toISOString(),
    user,
    kind: 'revert',
    previousValue: base.currentValue,
    newValue: base.originalValue,
    reason: 'Reverted to original research value',
    source: base.originalSource,
  };
  const nextField: FieldState = {
    ...base,
    currentValue: base.originalValue,
    isOverridden: false,
    history: [...base.history, entry],
  };
  return {
    ...store,
    [companyId]: { ...(store[companyId] ?? {}), [fieldPath]: nextField },
  };
}

export function addSource(store: EditsStore, companyId: string, fieldPath: string, base: FieldState, source: Omit<SourceEntry, 'id' | 'addedAt'>): EditsStore {
  const entry: SourceEntry = { ...source, id: uid(), addedAt: new Date().toISOString() };
  const historyEntry: FieldEditEntry = {
    id: uid(),
    timestamp: entry.addedAt,
    user: source.addedBy,
    kind: 'source-added',
    previousValue: base.currentValue,
    newValue: base.currentValue,
    reason: `Added corroborating source: ${source.label}`,
    source: source.label,
    evidenceUrl: source.url,
    confidence: source.confidence,
  };
  const nextField: FieldState = {
    ...base,
    sources: [...base.sources, entry],
    history: [...base.history, historyEntry],
  };
  return {
    ...store,
    [companyId]: { ...(store[companyId] ?? {}), [fieldPath]: nextField },
  };
}

export function addCommentary(store: CommentaryStore, companyId: string, note: Omit<CommentaryNote, 'id'>): CommentaryStore {
  const entry: CommentaryNote = { ...note, id: uid() };
  const existing = store[companyId] ?? [];
  return { ...store, [companyId]: [...existing, entry] };
}

// ---- Backup / Restore ----
// Everything the Investor Judgment system persists lives in exactly the five localStorage
// keys above (EDITS_KEY, COMMENTARY_KEY, USER_KEY, MANUAL_COMPANIES_KEY, and the traction key
// owned by lib/traction.ts) -- this is the full, authoritative set. A backup is just a snapshot
// of those, bundled into one downloadable JSON file, so it survives a browser data clear, a
// move to a different origin (e.g. deploying this app), or switching machines. Nothing about
// the startup dataset (companies.json/funds.json) or the funnel/scoring logic is touched by
// backup/restore -- this only ever reads/writes the edit layer (and any manually-added
// companies) that sit on top of them.
//
// NOTE on traction: the backup carries each entry's metadata and bullets, not the uploaded
// FILE, which lives on the server under data/traction. Restoring onto a machine without those
// files leaves the cards intact and only the "open original" link dangling.

export const BACKUP_SCHEMA_VERSION = 3;

export interface BackupFile {
  schemaVersion: 1 | 2 | 3;
  exportedAt: string;
  userName: string;
  fieldEdits: EditsStore;
  commentary: CommentaryStore;
  /** Absent on schemaVersion 1 backups taken before "+ Add Company" existed. */
  manualCompanies?: Company[];
  /** Absent on schemaVersion 1-2 backups taken before the Traction section existed. */
  traction?: TractionStore;
}

export function buildBackup(
  edits: EditsStore,
  commentary: CommentaryStore,
  userName: string,
  manualCompanies: Company[],
  traction: TractionStore = loadTraction()
): BackupFile {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    userName,
    fieldEdits: edits,
    commentary,
    manualCompanies,
    traction,
  };
}

export function isValidBackup(data: unknown): data is BackupFile {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.schemaVersion === 'number' &&
    typeof d.fieldEdits === 'object' && d.fieldEdits !== null &&
    typeof d.commentary === 'object' && d.commentary !== null &&
    (d.manualCompanies === undefined || Array.isArray(d.manualCompanies))
  );
}

/** Counts entries in a backup so the UI can show "this will restore N field edits across M
 *  companies/funds and K commentary notes" before overwriting anything. */
export function summarizeBackup(backup: BackupFile) {
  const entities = Object.keys(backup.fieldEdits);
  const fieldCount = entities.reduce((sum, k) => sum + Object.keys(backup.fieldEdits[k]).length, 0);
  const noteCount = Object.values(backup.commentary).reduce((sum, notes) => sum + notes.length, 0);
  const manualCompanyCount = backup.manualCompanies?.length ?? 0;
  const tractionCount = Object.values(backup.traction ?? {}).reduce((sum, entries) => sum + entries.length, 0);
  return { entityCount: entities.length, fieldCount, noteCount, manualCompanyCount, tractionCount };
}

/** Persists a backup's contents into localStorage, replacing whatever is currently there.
 *  Callers are responsible for also updating in-memory React state (see EditorContext). */
export function persistBackup(backup: BackupFile) {
  saveEdits(backup.fieldEdits);
  saveCommentary(backup.commentary);
  if (backup.userName) saveUserName(backup.userName);
  saveManualCompanies(backup.manualCompanies ?? []);
  saveTraction(backup.traction ?? {});
}
