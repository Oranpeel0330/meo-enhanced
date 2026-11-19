import { snippet } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { parseShortcutSnippet, shortcutSnippetFinalField as finalField, shortcutSnippetSupportsTable, type ShortcutSnippetPart } from '../../../src/application/shortcutSnippet';

type Part = string | { field: number; initial?: string };

function documentName(documentId: string): string {
  try {
    return decodeURIComponent(new URL(documentId).pathname.split('/').at(-1) ?? '');
  } catch {
    return documentId.split(/[\\/]/).at(-1) ?? '';
  }
}

function defaultsFor(parts: readonly Part[]): ReadonlyMap<number, string> {
  const defaults = new Map<number, string>();
  for (const part of parts) {
    if (typeof part !== 'string' && part.initial !== undefined && !defaults.has(part.field)) {
      defaults.set(part.field, part.initial);
    }
  }
  return defaults;
}

const escapeBraces = (value: string): string => value.replace(/[{}]/g, '\\$&');

function snippetVariables(documentId: string): Readonly<Record<string, string>> {
  const now = new Date();
  const padded = (value: number) => String(value).padStart(2, '0');
  const filename = documentName(documentId);
  return {
    CURRENT_YEAR: String(now.getFullYear()),
    CURRENT_MONTH: padded(now.getMonth() + 1),
    CURRENT_DATE: padded(now.getDate()),
    CURRENT_HOUR: padded(now.getHours()),
    CURRENT_MINUTE: padded(now.getMinutes()),
    CURRENT_SECOND: padded(now.getSeconds()),
    TM_FILENAME: filename,
    TM_FILENAME_BASE: filename.replace(/(?<=.)\.[^.]*$/, '')
  };
}

function expandSnippet(parts: readonly ShortcutSnippetPart[], variables: Readonly<Record<string, string>>, selection: string): Part[] {
  return parts.map(part => typeof part === 'string' || 'field' in part ? part
    : part.variable === 'TM_SELECTED_TEXT' ? selection : variables[part.variable] ?? part.raw);
}

export function expandTableShortcutSnippet(template: string, documentId: string, selection: string): { text: string; caret: number } | null {
  const parts = parseShortcutSnippet(template);
  if (!shortcutSnippetSupportsTable(parts)) return null;
  let text = '';
  let finalCursor: number | undefined;
  for (const part of expandSnippet(parts, snippetVariables(documentId), selection)) {
    if (typeof part === 'string') text += part;
    else finalCursor = text.length;
  }
  return { text, caret: finalCursor ?? text.length };
}

export type SourceCellSnippetEdit = { from: number; to: number; text: string; caret: number };

export function insertSourceCellSnippet(view: EditorView, plan: SourceCellSnippetEdit): void {
  view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.text }, selection: EditorSelection.cursor(plan.caret),
    annotations: [Transaction.userEvent.of('input.snippet'), isolateHistory.of('full')], scrollIntoView: true });
}

export function insertShortcutSnippet(view: EditorView, template: string, documentId: string): boolean {
  if (!view.hasFocus || view.state.readOnly || view.compositionStarted) return false;
  const variables = snippetVariables(documentId);
  const templateParts = parseShortcutSnippet(template);
  const { state } = view;
  const partsFor = (from: number, to: number) => expandSnippet(templateParts, variables, state.sliceDoc(from, to));
  const annotations = [Transaction.userEvent.of('input.snippet'), isolateHistory.of('full')];
  const { main, ranges } = state.selection;
  const parts = partsFor(main.from, main.to);
  if (ranges.length === 1 && parts.some(part => typeof part !== 'string')) {
    const defaults = defaultsFor(parts);
    const body = parts.map(part => typeof part === 'string' ? escapeBraces(part)
      : '${' + part.field + ':' + escapeBraces(defaults.get(part.field) ?? '') + '}').join('');
    const end = parts.some(part => typeof part !== 'string' && part.field === finalField) ? '' : '${100}';
    snippet(body + end)({
      state,
      dispatch: transaction => view.dispatch({
        changes: transaction.changes,
        selection: transaction.selection,
        effects: transaction.effects,
        annotations,
        scrollIntoView: true
      })
    }, null, main.from, main.to);
    return true;
  }

  view.dispatch({
    ...state.changeByRange(range => {
      const parts = partsFor(range.from, range.to);
      const defaults = defaultsFor(parts);
      const insert = parts.map(part => typeof part === 'string' ? part : defaults.get(part.field) ?? '').join('');
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length)
      };
    }),
    annotations,
    scrollIntoView: true
  });
  return true;
}
