/*
Confirm full-file queries through the editor before scanning large files.
*/
import type { EditorUi } from './EditorUi';
import type { Metadata, Query } from './protocol';
import { t } from './Locale';

export async function confirmQuery(metadata: Pick<Metadata, 'bytes' | 'rows'> | undefined, query: Query, ui: EditorUi): Promise<boolean> {
  const expensive = (metadata?.bytes ?? 0) >= 20 * 1024 * 1024 || (metadata?.rows ?? 0) >= 100000;
  if (!expensive || (!query.sort && !query.filters.length)) return true;
  return await ui.prompt({ kind: 'choice', layout: 'actions', title: t('Sorting or filtering this large file may take a long time.'), detail: t('The full file will be scanned. Your saved row order will stay the same.'), choices: [{ id: 'continue', label: t('Continue') }] }) === 'continue';
}
