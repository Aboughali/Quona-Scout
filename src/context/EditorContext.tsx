import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { CommentaryNote, Company, CompanyFieldStates, EditConfidence, FieldState, RoundRecord } from '../types';
import {
  addCommentary,
  addSource,
  applyFieldOverride,
  buildBackup,
  getFieldState,
  loadCommentary,
  loadEdits,
  loadManualCompanies,
  loadUserName,
  persistBackup,
  revertField,
  saveCommentary,
  saveEdits,
  saveManualCompanies,
  saveUserName,
  uid,
  type BackupFile,
  type CommentaryStore,
  type EditsStore,
} from '../lib/editStore';
import {
  addTraction,
  loadTraction,
  removeTraction,
  saveTraction,
  type TractionEntry,
  type TractionStore,
} from '../lib/traction';

interface EditorContextValue {
  userName: string;
  setUserName: (name: string) => void;
  edits: EditsStore;
  commentary: CommentaryStore;
  getField: (companyId: string, fieldPath: string, originalValue: unknown, originalSource: string) => FieldState;
  overrideField: (
    companyId: string,
    fieldPath: string,
    originalValue: unknown,
    originalSource: string,
    input: { newValue: unknown; reason: string; source: string; evidenceUrl?: string; confidence?: EditConfidence }
  ) => void;
  revertFieldValue: (companyId: string, fieldPath: string, originalValue: unknown, originalSource: string) => void;
  addFieldSource: (
    companyId: string,
    fieldPath: string,
    originalValue: unknown,
    originalSource: string,
    source: { label: string; url?: string; confidence: EditConfidence }
  ) => void;
  addNote: (companyId: string, note: Omit<CommentaryNote, 'id' | 'author' | 'date'> & { date?: string }) => void;
  getNotes: (companyId: string) => CommentaryNote[];
  /** Companies created via "+ Add Company", concatenated onto the static gold-sheet list in
   *  App.tsx so they flow through the same funnel/table/drawer with zero special-casing. */
  manualCompanies: Company[];
  addManualCompany: (company: Company) => void;
  /** Data-quality reconciliation (case brief Part 1/7/31): folds `sourceId` into `targetId`,
   *  reassigning every field edit, round, and commentary note rather than deleting anything.
   *  Only a manually-added duplicate can be merged away this way -- an ETL-sourced record is
   *  static data, and post-identity-fix there should never be an ETL-vs-ETL duplicate to merge
   *  in the first place (see scripts/etl.py). Returns ok:false with an explanation otherwise. */
  mergeCompanies: (sourceId: string, targetId: string) => { ok: boolean; message: string };
  /** Traction evidence per company -- uploaded documents (with their AI-written bullets) and
   *  hand-entered metrics. Persisted next to the other investor-judgment layers. */
  getTractionEntries: (companyId: string) => TractionEntry[];
  addTractionEntry: (entry: Omit<TractionEntry, 'addedBy' | 'addedAt'> & { addedAt?: string }) => void;
  removeTractionEntry: (companyId: string, entryId: string) => void;
  /** Snapshots everything the Investor Judgment system currently persists (field edits,
   *  commentary, the editing-as name, manually-added companies, traction) into one downloadable
   *  backup object. */
  exportBackup: () => BackupFile;
  /** Replaces the entire current edit/commentary/userName state with a previously-exported
   *  backup -- both in localStorage and in the live React state, so the UI updates immediately
   *  without needing a manual reload. */
  importBackup: (backup: BackupFile) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [edits, setEdits] = useState<EditsStore>(() => loadEdits());
  const [commentary, setCommentary] = useState<CommentaryStore>(() => loadCommentary());
  const [userName, setUserNameState] = useState<string>(() => loadUserName());
  const [manualCompanies, setManualCompanies] = useState<Company[]>(() => loadManualCompanies());
  const [traction, setTraction] = useState<TractionStore>(() => loadTraction());

  const setUserName = useCallback((name: string) => {
    setUserNameState(name);
    saveUserName(name);
  }, []);

  const getField = useCallback(
    (companyId: string, fieldPath: string, originalValue: unknown, originalSource: string) =>
      getFieldState(edits, companyId, fieldPath, originalValue, originalSource),
    [edits]
  );

  const overrideField: EditorContextValue['overrideField'] = useCallback(
    (companyId, fieldPath, originalValue, originalSource, input) => {
      setEdits((prev) => {
        const base = getFieldState(prev, companyId, fieldPath, originalValue, originalSource);
        const next = applyFieldOverride(prev, companyId, fieldPath, base, { ...input, user: userName });
        saveEdits(next);
        return next;
      });
    },
    [userName]
  );

  const revertFieldValue: EditorContextValue['revertFieldValue'] = useCallback(
    (companyId, fieldPath, originalValue, originalSource) => {
      setEdits((prev) => {
        const base = getFieldState(prev, companyId, fieldPath, originalValue, originalSource);
        const next = revertField(prev, companyId, fieldPath, base, userName);
        saveEdits(next);
        return next;
      });
    },
    [userName]
  );

  const addFieldSource: EditorContextValue['addFieldSource'] = useCallback(
    (companyId, fieldPath, originalValue, originalSource, source) => {
      setEdits((prev) => {
        const base = getFieldState(prev, companyId, fieldPath, originalValue, originalSource);
        const next = addSource(prev, companyId, fieldPath, base, { ...source, addedBy: userName });
        saveEdits(next);
        return next;
      });
    },
    [userName]
  );

  const addNote: EditorContextValue['addNote'] = useCallback(
    (companyId, note) => {
      setCommentary((prev) => {
        const next = addCommentary(prev, companyId, {
          ...note,
          author: userName,
          date: note.date ?? new Date().toISOString(),
        });
        saveCommentary(next);
        return next;
      });
    },
    [userName]
  );

  const getNotes = useCallback((companyId: string) => commentary[companyId] ?? [], [commentary]);

  const addManualCompany = useCallback((company: Company) => {
    setManualCompanies((prev) => {
      const next = [...prev, company];
      saveManualCompanies(next);
      return next;
    });
  }, []);

  const getTractionEntries = useCallback((companyId: string) => traction[companyId] ?? [], [traction]);

  const addTractionEntry: EditorContextValue['addTractionEntry'] = useCallback(
    (entry) => {
      setTraction((prev) => {
        // Stamped with the current editor and the moment of filing, so a card always says who
        // put it there -- the same provenance rule the field-edit history follows.
        const next = addTraction(prev, { ...entry, addedBy: userName, addedAt: entry.addedAt ?? new Date().toISOString() });
        saveTraction(next);
        return next;
      });
    },
    [userName]
  );

  const removeTractionEntry: EditorContextValue['removeTractionEntry'] = useCallback((companyId, entryId) => {
    setTraction((prev) => {
      const next = removeTraction(prev, companyId, entryId);
      saveTraction(next);
      return next;
    });
  }, []);

  const mergeCompanies: EditorContextValue['mergeCompanies'] = useCallback(
    (sourceId, targetId) => {
      if (sourceId === targetId) return { ok: false, message: 'Cannot merge a company into itself.' };
      const isSourceManual = manualCompanies.some((c) => c.id === sourceId);
      if (!isSourceManual) {
        return {
          ok: false,
          message: 'Only a manually-added duplicate can be auto-merged. This looks like a static gold-sheet record -- ' +
            'that should not happen after the company-identity fix (see Data Quality page). Flag for manual review instead.',
        };
      }

      const sourceEdits = edits[sourceId] ?? {};
      const targetEdits: CompanyFieldStates = { ...(edits[targetId] ?? {}) };
      let conflicts = 0;
      for (const [path, state] of Object.entries(sourceEdits)) {
        if (path.startsWith('round:')) {
          // Re-key every round from the source onto a fresh id under the target so it can
          // never collide with one of the target's own rounds -- retains the full history.
          const newId = `new-${uid()}`;
          const newPath = `round:${newId}`;
          const currentValue = state.currentValue as RoundRecord | null;
          targetEdits[newPath] = {
            ...state,
            fieldPath: newPath,
            currentValue: currentValue ? { ...currentValue, id: newId } : currentValue,
          };
        } else if (!targetEdits[path]) {
          targetEdits[path] = state;
        } else {
          // Target already has its own edit history for this field -- keep the target's
          // (it's the surviving canonical record) rather than guess which is "right".
          conflicts += 1;
        }
      }
      const nextEdits = { ...edits, [targetId]: targetEdits };
      delete nextEdits[sourceId];
      saveEdits(nextEdits);
      setEdits(nextEdits);

      const sourceNotes = commentary[sourceId] ?? [];
      const targetNotes = commentary[targetId] ?? [];
      const nextCommentary = { ...commentary, [targetId]: [...targetNotes, ...sourceNotes] };
      delete nextCommentary[sourceId];
      saveCommentary(nextCommentary);
      setCommentary(nextCommentary);

      const nextManual = manualCompanies.filter((c) => c.id !== sourceId);
      saveManualCompanies(nextManual);
      setManualCompanies(nextManual);

      // Traction evidence follows the record it describes, re-pointed at the surviving company.
      const sourceTraction = (traction[sourceId] ?? []).map((e) => ({ ...e, companyId: targetId }));
      if (sourceTraction.length) {
        const nextTraction = { ...traction, [targetId]: [...(traction[targetId] ?? []), ...sourceTraction] };
        delete nextTraction[sourceId];
        saveTraction(nextTraction);
        setTraction(nextTraction);
      }

      return {
        ok: true,
        message: conflicts > 0
          ? `Merged. ${conflicts} field(s) had edits on both records -- kept the surviving record's version.`
          : 'Merged -- all rounds, edits, and commentary carried over.',
      };
    },
    [edits, commentary, manualCompanies, traction]
  );

  const exportBackup = useCallback(
    () => buildBackup(edits, commentary, userName, manualCompanies, traction),
    [edits, commentary, userName, manualCompanies, traction]
  );

  const importBackup = useCallback((backup: BackupFile) => {
    persistBackup(backup);
    setEdits(backup.fieldEdits);
    setCommentary(backup.commentary);
    if (backup.userName) setUserNameState(backup.userName);
    setManualCompanies(backup.manualCompanies ?? []);
    setTraction(backup.traction ?? {});
  }, []);

  const value = useMemo(
    () => ({
      userName, setUserName, edits, commentary, getField, overrideField, revertFieldValue, addFieldSource, addNote, getNotes,
      manualCompanies, addManualCompany, mergeCompanies, exportBackup, importBackup,
      getTractionEntries, addTractionEntry, removeTractionEntry,
    }),
    [userName, setUserName, edits, commentary, getField, overrideField, revertFieldValue, addFieldSource, addNote, getNotes,
      manualCompanies, addManualCompany, mergeCompanies, exportBackup, importBackup,
      getTractionEntries, addTractionEntry, removeTractionEntry]
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor must be used within EditorProvider');
  return ctx;
}
