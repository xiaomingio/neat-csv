/*
File purpose: Define messages shared by the engine, extension host, and editor webview.
*/
import type { Language } from './Locale';
export type SaveOptions = { edits: boolean; sort: boolean; filters: boolean; encoding?: string; columns?: number[] };
export type SaveDecision = SaveChoice | { discard: true };
export type SaveChoice = { options: SaveOptions; saveAs: boolean };
export type HistoryVersion = { id: string; created: string; bytes: number; hasHeader: boolean; format?: FileFormat; source?: string };
export type VersionList = { versions: HistoryVersion[]; bytes: number; totalBytes: number };
export const TEXT_WINDOW_RECORDS = 10000;
export const TEXT_WINDOW_BYTES = 1024 * 1024;
export type TextPage = {
  draftError?: string; start: number; count: number; total: number; text: string; revision: number; delimiter: string; newline: string };
export type TextEdit = { start: number; count: number; text: string; revision: number };
export type TextEditResult = { before: string; beforeState?: { text: string; cells: CellEdit[] }; page: TextPage; changes: number; error?: string };
export type CellEdit = { row: number; col: number; value: string };
export type Filter =
  | { col: number; type?: 'text'; text: string }
  | { col: number; type: 'regex'; text: string }
  | { col: number; type: 'values'; values: string[] }
  | { col: number; type: 'number'; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'; value: number; max?: number }
  | { col: number; type: 'empty' | 'notEmpty' };
export type Query = { filters: Filter[]; sort: { col: number; direction: 1 | -1; numeric: boolean | 'auto' } | null };
export type RowRange = { start: number; count: number };
export type SelectionStats = { count: number; numericCount: number; nonEmptyCount: number; min: number | null; max: number | null; sum: number; average: number | null };
export type Metadata = { headers: string[]; rows: number; bytes: number; scanned: number; complete: boolean; delimiter: string; newline: string; hasHeader: boolean; encoding?: string; modifiedHeaders?: number[]; insertedColumns?: number[]; pinnedRows?: number[] };
export type RowPinsResult = { rows: number[]; visibleRows: number[]; total: number };
export type FileFormat = { encoding: string; delimiter?: string };
/** Row and column IDs are zero-based source coordinates; selections use view row indices. */
export type SelectedCell = { row: number; col: number };
export type CellSelection = { start: number; count: number; columns: number[]; ranges?: RowRange[]; cells?: SelectedCell[] };
export type SearchOptions = { text: string; columns?: number[]; caseSensitive?: boolean; regex?: boolean; after?: { row: number; col: number }; limit?: number; selection?: CellSelection };
export type SearchResult = { matches: { row: number; col: number; value: string }[]; total: number; truncated: boolean };
export type CheckOptions = { kind: 'duplicates' | 'missing' | 'ragged'; columns?: number[]; limit?: number; after?: { row: number; col?: number } };
export type CheckResult = { issues: { row: number; col?: number; value?: string }[]; total: number; truncated: boolean };
export type DistinctResult = { values: { value: string; count: number }[]; total: number };
export type ChangeOperation =
  | { kind: 'cells'; edits: CellEdit[] }
  | { kind: 'paste'; row: number; columns: number[]; text: string }
  | { kind: 'fill'; selection: CellSelection; value: string }
  | { kind: 'replace'; search: SearchOptions; replacement: string; selection?: CellSelection }
  | { kind: 'insertRows'; at: number; count: number }
  | { kind: 'deleteRows'; rows: number[] }
  | { kind: 'moveRow'; row: number; before: number }
  | { kind: 'renameColumn'; col: number; name: string }
  | { kind: 'moveColumn'; col: number; before: number }
  | { kind: 'insertColumn'; at: number; name: string }
  | { kind: 'deleteColumns'; columns: number[] };
export type ChangeResult = { before: string; after: string; changes: number; metadata: Metadata };
export type LocateResult = { row: number; index: number | null };
export type Page = { rows: { id: number; values: string[]; modified: number[]; inserted?: boolean }[]; total: number; start: number; insertedColumns?: number[]; pinnedRows?: number[] };
export type EngineRequest =
  | { method: 'open'; path: string; hasHeader?: boolean; format?: FileFormat }
  | { method: 'configure'; format: FileFormat }
  | { method: 'change'; operation: ChangeOperation }
  | { method: 'restore'; token: string }
  | { method: 'search'; options: SearchOptions }
  | { method: 'check'; options: CheckOptions }
  | { method: 'distinct'; col: number }
  | { method: 'locate'; row: number }
  | { method: 'textPage'; start: number; count: number }
  | { method: 'textEdit'; edit: TextEdit }
  | { method: 'page'; start: number; count: number }
  | { method: 'query'; query: Query }
  | { method: 'pinRows'; rows: number[] }
  | { method: 'copy' | 'stats'; includeHeaders?: boolean; start: number; count: number; columns: number[]; ranges?: RowRange[]; cells?: SelectedCell[] }
  | { method: 'edit'; edit: CellEdit }
  | { method: 'save'; target?: string; options?: SaveOptions }
  | { method: 'reload' };
export type EngineResult = Metadata | Page | TextPage | TextEditResult | SelectionStats | ChangeResult | SearchResult | CheckResult | DistinctResult | LocateResult | RowPinsResult | { value: string; changes?: number } | { total: number } | string | null;
export type WorkerRequest = EngineRequest & { id: number };
export type WorkerResponse = { id: number; result?: EngineResult; error?: string } | { event: 'metadata'; data: Metadata } | { event: 'error'; message: string };
export type HostPrompt = {
  id: number; title: string; message?: string; detail?: string; kind: 'choice' | 'input' | 'form'; layout?: 'actions' | 'list';
  choices?: { id: string; label: string; description?: string }[];
  value?: string; placeholder?: string; input?: { kind: 'text' | 'number'; min?: number; max?: number };
  fields?: { id: string; label: string; type: 'text' | 'number' | 'checkbox'; value: string | boolean; min?: number; max?: number; required?: boolean; pattern?: string }[];
  validationMessage?: string; confirmLabel?: string;
};
export type PromptValue = string | Record<string, string | boolean> | null;
export type HostMessage =
  | { type: 'prompt'; prompt: HostPrompt }
  | { type: 'language'; language: Language }
  | { type: 'guide'; seen: boolean }
  | { type: 'savePrompt'; saveAs: boolean; allowDiscard?: boolean }
  | { type: 'textState'; page: TextPage; error?: string }
  | { type: 'textRestore'; start: number }
  | { type: 'viewReset' }
  | { type: 'metadata'; data: Metadata }
  | { type: 'response'; id: number; result?: unknown; error?: string }
  | { type: 'changed'; changes: number; canUndo?: boolean; canRedo?: boolean }
  | { type: 'error'; message: string };
export type ClientMessage = { id: number } & (
  | { type: 'promptChoice'; promptId: number; value: PromptValue }
  | { type: 'export'; columns: number[]; encoding?: string }
  | { type: 'saveAs' }
  | { type: 'backupSettings' }
  | { type: 'clipboardRead' }
  | { type: 'clipboardWrite'; text: string }
  | { type: 'language'; language: Language }
  | { type: 'configure'; format: FileFormat }
  | { type: 'change'; operation: ChangeOperation }
  | { type: 'search'; options: SearchOptions }
  | { type: 'check'; options: CheckOptions }
  | { type: 'distinct'; col: number }
  | { type: 'locate'; row: number }
  | { type: 'ready' | 'guideSeen' }
  | { type: 'textPage'; start: number; count: number }
  | { type: 'textEdit'; edit: TextEdit }
  | { type: 'page'; start: number; count: number }
  | { type: 'query'; query: Query }
  | { type: 'pinRows'; rows: number[] }
  | { type: 'confirmQuery'; query: Query }
  | { type: 'header'; enabled: boolean }
  | { type: 'openLink'; url: string }
  | { type: 'copy' | 'stats'; includeHeaders?: boolean; start: number; count: number; columns: number[]; ranges?: RowRange[]; cells?: SelectedCell[] }
  | { type: 'edit'; edit: CellEdit }
  | { type: 'saveChoice'; choice: SaveDecision | null }
  | { type: 'versions'; scope?: 'file' | 'all' }
  | { type: 'recover'; version: string; saveAs: boolean; source?: string }
  | { type: 'clearVersions'; scope: 'file' | 'all' }
  | { type: 'save' | 'undo' | 'redo' }
);
