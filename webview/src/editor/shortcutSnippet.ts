import { snippet } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

type Part = string | { field: number; initial?: string };
const finalField = 100;

function documentName(documentId: string): string {
  try {
    return decodeURIComponent(new URL(documentId).pathname.split('/').at(-1) ?? '');
  } catch {
    return documentId.split(/[\\/]/).at(-1) ?? '';
  }
}

function parseTemplate(template: string, variables: Readonly<Record<string, string>>): Part[] {
  const tokens = /\\([$\\}])|\$\{(?:(\d{1,2})(?::([^{}\r\n]*))?|([A-Z_][A-Z_0-9]*))\}|\$(\d{1,2})(?!\d)|\$([A-Z_][A-Z_0-9]*)/g;
  const parts: Part[] = [];
  let offset = 0;
  for (const match of template.matchAll(tokens)) {
    parts.push(template.slice(offset, match.index));
    const [raw, escaped, field, initial, variable, shortField, shortVariable] = match;
    const name = variable ?? shortVariable;
    if (escaped) parts.push(escaped);
    else if (name) parts.push(variables[name] ?? raw);
    else parts.push({ field: Number(field ?? shortField) || finalField, initial });
    offset = match.index + raw.length;
  }
  parts.push(template.slice(offset));
  return parts;
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

export function insertShortcutSnippet(view: EditorView, template: string, documentId: string): boolean {
  if (!view.hasFocus || view.state.readOnly || view.compositionStarted) return false;
  const now = new Date();
  const padded = (value: number) => String(value).padStart(2, '0');
  const filename = documentName(documentId);
  const variables = {
    CURRENT_YEAR: String(now.getFullYear()),
    CURRENT_MONTH: padded(now.getMonth() + 1),
    CURRENT_DATE: padded(now.getDate()),
    CURRENT_HOUR: padded(now.getHours()),
    CURRENT_MINUTE: padded(now.getMinutes()),
    CURRENT_SECOND: padded(now.getSeconds()),
    TM_FILENAME: filename,
    TM_FILENAME_BASE: filename.replace(/(?<=.)\.[^.]*$/, '')
  };
  const { state } = view;
  const partsFor = (from: number, to: number) => parseTemplate(template, {
    ...variables, TM_SELECTED_TEXT: state.sliceDoc(from, to)
  });
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
