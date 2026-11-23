import { EditorSelection, Transaction, type EditorState, type StateEffect, type SelectionRange } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine, selectParentSyntax, isolateHistory } from '@codemirror/commands';
import { selectNextOccurrence } from '@codemirror/search';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import { parseDelimitedTable, markdownTableFromCells } from '../application/delimitedTable';
import { inlineCodeMarkers, planInlineWrapper } from '../application/symbolInput';
import { isCodeInput } from './pasteAssistance';
import type { EditorCommandId } from '../../../src/foundation/editingPreferences';
import { readMarkdownListPrefix } from '../../../src/foundation/markdownListPrefix';

import { markdownCodeRanges, protectedMarkdownEdit, type MarkdownBlockGuard } from './blockInsertion';
import { planHtmlCommentToggle } from '../application/htmlCommentInput';
import { beginHtmlCommentTemplate } from './htmlCommentEditing';
import { addAutomaticSymbolPair } from './typingAssistance';
import { supersedeLiveInputDerivedWork, usesLargeDocumentDerivedWorkBudget } from './liveInputDerivedWork';
import { resolveMarkdownStructureAt } from './backgroundMarkdownStructure';
import { isCompleteMarkdownStructure } from './markdownStructure';
import { planCodeComments, type CodeCommentLanguage } from './codeComments';

const selectionHistory = new WeakMap<EditorView, { after: EditorSelection; before: EditorSelection[] }>();
// Programmatic edits share the existing toolbar caret-continuity path in both modes.
const annotation = Transaction.userEvent.of('input.toolbar');
function selectedLines(view: EditorView) {
  const { state } = view;
  const numbers = new Set<number>();
  for (const selection of state.selection.ranges) {
    const first = state.doc.lineAt(selection.from).number;
    const last = state.doc.lineAt(selection.to > selection.from ? selection.to - 1 : selection.to).number;
    for (let number = first; number <= last; number++) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b).map(number => state.doc.line(number));
}

function toggleLines(view: EditorView, command: EditorCommandId, protectedRange: MarkdownBlockGuard): boolean {
  let lines = selectedLines(view);
  const headings = command.startsWith('heading') ? 'allow' : 'setext';
  if (view.state.selection.ranges.some(range => {
    const first = view.state.doc.lineAt(range.from);
    const last = view.state.doc.lineAt(range.empty ? range.to : range.to - 1);
    return protectedMarkdownEdit(view.state, first.from, last.to, protectedRange, headings);
  })) return false;
  const heading = /^heading([1-6])$/.exec(command);
  const setextByLine = new Map<number, SyntaxNode>();
  if (command.startsWith('heading')) {
    const seen = new Set<number>();
    lines = lines.filter(line => {
      let node = syntaxTree(view.state).resolveInner(line.to, -1);
      while (node.parent && !node.name.startsWith('SetextHeading')) node = node.parent;
      if (!node.name.startsWith('SetextHeading')) return true;
      if (seen.has(node.from)) return false;
      seen.add(node.from); setextByLine.set(line.from, node); return true;
    });
  }
  const targetPrefix = command === 'bullet' ? '- ' : command === 'ordered' ? '1. ' : command === 'taskList' ? '- [ ] ' : command === 'quote' ? '> ' : heading ? '#'.repeat(Number(heading[1])) + ' ' : '';
  const ownMarker = command === 'quote' ? /^\s*>\s?/ : heading ? new RegExp('^\\s*#{' + heading[1] + '} ') : null;
  const remove = lines.every(line => {
    const setext = setextByLine.get(line.from);
    if (setext) return Number(setext.name.slice(-1)) === Number(heading?.[1]);
    const list = readMarkdownListPrefix(line.text);
    if (list && list.toOffset > list.markerEndOffset) {
      if (command === 'bullet') return list.bullet !== undefined && list.taskMarker === undefined;
      if (command === 'ordered') return list.orderedNumber !== undefined;
      if (command === 'taskList') return list.taskMarker !== undefined;
    }
    return ownMarker?.test(line.text) ?? false;
  });
  let ordinal = 0;
  const contentOffsets = new Map<number, number>();
  const convertedHeadings: { from: number; to: number; contentFrom: number; contentTo: number; prefix: string }[] = [];
  const singleLineHeading = (text: string) => text.replace(/\n[ \t]*(?:>[ \t]*)*/g, ' ');
  const changes = lines.map(line => {
    const setext = setextByLine.get(line.from);
    if (setext) {
      const content = { from: setext.from, to: view.state.doc.lineAt(setext.lastChild!.from).from - 1 };
      let level = remove ? 0 : Number(heading?.[1]);
      if (command === 'headingUp' || command === 'headingDown') {
        level = Math.max(0, Math.min(6, Number(setext.name.slice(-1)) + (command === 'headingDown' ? 1 : -1)));
      }
      const prefix = level ? '#'.repeat(level) + ' ' : '';
      // Heading commands replace the whole two-line form, including its underline.
      convertedHeadings.push({ from: setext.from, to: setext.to, contentFrom: content.from, contentTo: content.to, prefix });
      return { from: setext.from, to: setext.to, insert: prefix + singleLineHeading(view.state.sliceDoc(content.from, content.to)) };
    }
    if (command === 'taskDone') {
      const task = readMarkdownListPrefix(line.text);
      if (!task || task.taskBracketStart === undefined) return { from: line.from, insert: '' };
      const from = line.from + task.taskBracketStart + 1;
      return { from, to: from + 1, insert: task.taskMarker === ' ' ? 'x' : ' ' };
    }
    const indentation = /^\s*/.exec(line.text)![0];
    const list = readMarkdownListPrefix(line.text);
    const existingLength = list && list.toOffset > list.markerEndOffset ? list.toOffset - indentation.length
      : /^(?:#{1,6}\s+|>\s?)/.exec(line.text.slice(indentation.length))?.[0].length ?? 0;
    let prefix = remove ? '' : command === 'ordered' ? `${++ordinal}. ` : targetPrefix;
    if (command === 'headingUp' || command === 'headingDown') {
      const level = /^(#{1,6})\s/.exec(line.text.slice(indentation.length))?.[1].length ?? 0;
      const next = Math.max(0, Math.min(6, level + (command === 'headingDown' ? 1 : -1)));
      prefix = next ? '#'.repeat(next) + ' ' : '';
    }
    contentOffsets.set(line.from, indentation.length + prefix.length);
    return { from: line.from + indentation.length, to: line.from + indentation.length + existingLength, insert: prefix };
  });
  const changeSet = view.state.changes(changes);
  if (changeSet.empty) return true;
  // Complete block markers and their Live widgets must appear together. A
  // caret at an inserted prefix belongs after it, at the original body text.
  const transaction = view.state.update({
    changes: changeSet,
    selection: EditorSelection.create(view.state.selection.ranges.map(range => {
      const mapped = range.map(changeSet, command === 'taskDone' ? -1 : 1);
      if (!range.empty) return mapped;
      const heading = convertedHeadings.find(value => range.head >= value.from && range.head <= value.to);
      if (heading) {
        const beforeCaret = view.state.sliceDoc(heading.contentFrom, Math.min(range.head, heading.contentTo));
        return EditorSelection.cursor(changeSet.mapPos(heading.from, -1) + heading.prefix.length + singleLineHeading(beforeCaret).length, range.assoc);
      }
      const line = view.state.doc.lineAt(range.head);
      const offset = contentOffsets.get(line.from);
      if (offset === undefined) return mapped;
      const contentStart = changeSet.mapPos(line.from, -1) + offset;
      return mapped.head < contentStart ? EditorSelection.cursor(contentStart, range.assoc) : mapped;
    }), view.state.selection.mainIndex),
    effects: usesLargeDocumentDerivedWorkBudget(view.state) ? [] : supersedeLiveInputDerivedWork(),
    annotations: [Transaction.userEvent.of('input.toolbar.block'), isolateHistory.of('full')]
  });
  view.dispatch(transaction);
  return true;
}

function wrapInlineMath(view: EditorView): boolean {
  const open = '$', close = '$';
  view.dispatch({ ...view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    let from = range.from, to = range.to, insert = open + text + close, wrapped = true;
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) { insert = text.slice(open.length, -close.length); wrapped = false; }
    else if (view.state.sliceDoc(Math.max(0, from - open.length), from) === open && view.state.sliceDoc(to, to + close.length) === close) { from -= open.length; to += close.length; insert = text; wrapped = false; }
    const first = from + (wrapped ? open.length : 0), last = from + insert.length - (wrapped ? close.length : 0);
    return { changes: { from, to, insert }, range: range.anchor > range.head ? EditorSelection.range(last, first) : EditorSelection.range(first, last) };
  }), annotations: annotation });
  return true;
}

function structuralLineSelection(view: EditorView): SelectionRange | null {
  const current = view.state.selection.main;
  let node = syntaxTree(view.state).resolveInner(current.head, -1);
  while (node.parent) {
    if (['Table', 'FencedCode'].includes(node.name) && node.from <= current.from && node.to >= current.to) {
      return EditorSelection.range(node.from, node.to);
    }
    node = node.parent;
  }
  return null;
}

function structuralLineCommand(view: EditorView, run: (target: EditorView) => boolean): boolean {
  const selection = structuralLineSelection(view);
  if (selection) view.dispatch({ selection });
  return run(view);
}

export function toggleMarkdownComment(view: EditorView, lines: boolean, options: {
  readonly codeLanguage: CodeCommentLanguage;
  blocked(): void;
  prepareHtmlEditing(state: EditorState, tree: Tree): void;
}): boolean {
  if (view.state.readOnly || view.compositionStarted) return false;
  const { state } = view;
  const ranges = state.selection.ranges;
  const upto = state.doc.lineAt(ranges.at(-1)!.to).to;
  const tree = resolveMarkdownStructureAt(state, upto, 8);
  const code = planCodeComments(state, tree, lines, options.codeLanguage);
  if (code === 'blocked') { options.blocked(); return true; }
  if (code === 'unsupported') return false;
  if (code) {
    if (!code.length) return false;
    const changes = state.changes(code);
    view.dispatch({ changes, selection: state.selection.map(changes, lines ? 1 : -1), annotations: [annotation, isolateHistory.of('full')] });
    return true;
  }
  // A proven code selection can be edited while distant syntax settles. The
  // Markdown fallback must wait until the selected range has been parsed.
  if (!isCompleteMarkdownStructure(tree, state.doc.length) && !syntaxTreeAvailable(state, upto)) return false;
  const plan = planHtmlCommentToggle(state.doc.toString(), ranges, lines, markdownCodeRanges(tree));
  if (plan.blocked) { options.blocked(); return true; }
  const changes = state.changes(plan.edits.map(({ from, to, insert }) => ({ from, to, insert })));
  const selections = plan.edits.flatMap(edit => edit.selections).sort((a, b) => a.index - b.index).map(selection => EditorSelection.range(selection.anchor, selection.head));
  const effects: StateEffect<unknown>[] = plan.edits.flatMap(edit => edit.template ? [
    beginHtmlCommentTemplate.of({ ...edit.template, end: edit.template.to + 3 }),
    addAutomaticSymbolPair.of({ from: edit.template.from - 4, to: edit.template.to + 3, open: '<!--', close: '-->' })
  ] : []);
  options.prepareHtmlEditing(state, tree);
  view.dispatch({ changes, selection: EditorSelection.create(selections, Math.min(state.selection.mainIndex, selections.length - 1)), effects,
    annotations: [annotation, isolateHistory.of('full')], scrollIntoView: true });
  view.focus(); return true;
}

function selectedDelimitedCells(view: EditorView): string[][] | null {
  if (isCodeInput(view)) return null;
  const selection = view.state.selection.main;
  const text = view.state.sliceDoc(selection.from, selection.to);
  const tsv = parseDelimitedTable(text, '\t');
  const cells = tsv && tsv[0].length > 1 ? tsv : parseDelimitedTable(text, ',');
  return cells && cells[0].length > 1 ? cells : null;
}

export function canRunCustomEditorCommand(view: EditorView, command: EditorCommandId): boolean {
  const { state } = view;
  if (command === 'convert') return selectedDelimitedCells(view) !== null;
  if (command === 'taskDone') return selectedLines(view).some(line => readMarkdownListPrefix(line.text)?.taskBracketStart !== undefined);
  if (command === 'addCursor') return state.doc.lineAt(state.selection.main.head).number < state.doc.lines;
  if (command === 'shrinkSelection') {
    const record = selectionHistory.get(view);
    return Boolean(record?.after.eq(state.selection) && record.before.length);
  }
  if (command === 'moveUp' || command === 'moveDown') {
    const block = structuralLineSelection(view);
    return (block ? [block] : state.selection.ranges).some(range => command === 'moveUp'
      ? state.doc.lineAt(range.from).number > 1
      : state.doc.lineAt(range.empty ? range.to : range.to - 1).number < state.doc.lines);
  }
  return true;
}

export function runEditorCommand(view: EditorView, command: EditorCommandId, protectedRange: MarkdownBlockGuard): boolean {
  if (/^heading/.test(command) || ['bullet', 'ordered', 'taskList', 'taskDone', 'quote'].includes(command)) return toggleLines(view, command, protectedRange);
  if (command === 'inlineMath') return wrapInlineMath(view);
  const lineCommands = { moveUp: moveLineUp, moveDown: moveLineDown, copyUp: copyLineUp, copyDown: copyLineDown, deleteLine };
  if (command in lineCommands) return structuralLineCommand(view, lineCommands[command as keyof typeof lineCommands]);
  if (command === 'blankAbove' || command === 'blankBelow') {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const above = command === 'blankAbove';
    const from = above ? line.from : line.to;
    view.dispatch({ changes: { from, insert: '\n' }, selection: EditorSelection.cursor(above ? from : from + 1), annotations: annotation });
    return true;
  }
  if (command === 'convert') {
    const cells = selectedDelimitedCells(view);
    if (!cells) return false;
    const selection = view.state.selection.main;
    const insert = markdownTableFromCells(cells);
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: EditorSelection.cursor(selection.from + insert.length), annotations: annotation });
    return true;
  }
  if (command === 'expandSelection') {
    const before = view.state.selection;
    const record = selectionHistory.get(view);
    const history = record?.after.eq(before) ? record.before : [];
    const changed = selectParentSyntax(view);
    if (changed) selectionHistory.set(view, { after: view.state.selection, before: [...history, before] });
    return changed;
  }
  if (command === 'shrinkSelection') {
    const record = selectionHistory.get(view);
    if (!record?.after.eq(view.state.selection) || !record.before.length) return false;
    const before = record.before.pop()!;
    view.dispatch({ selection: before });
    selectionHistory.set(view, { after: before, before: record.before });
    return true;
  }
  if (command === 'nextOccurrence') return selectNextOccurrence(view);
  if (command === 'skipOccurrence') {
    const before = view.state.selection;
    if (!selectNextOccurrence(view)) return false;
    const next = view.state.selection.main;
    const ranges = before.ranges.filter((_, index) => index !== before.mainIndex);
    view.dispatch({ selection: EditorSelection.create([...ranges, next]) });
    return true;
  }
  if (command === 'addCursor') {
    const ranges = view.state.selection.ranges.slice();
    const main = view.state.selection.main;
    const line = view.state.doc.lineAt(main.head);
    if (line.number === view.state.doc.lines) return false;
    const below = view.state.doc.line(line.number + 1);
    ranges.push(EditorSelection.cursor(below.from + Math.min(main.head - line.from, below.length)));
    view.dispatch({ selection: EditorSelection.create(ranges, ranges.length - 1) });
    return true;
  }
  if (command === 'splitCursors') {
    const ranges: SelectionRange[] = [];
    for (const range of view.state.selection.ranges) {
      const first = view.state.doc.lineAt(range.from), last = view.state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1));
      for (let number = first.number; number <= last.number; number++) {
        const line = view.state.doc.line(number);
        ranges.push(EditorSelection.cursor(Math.min(line.to, range.to)));
      }
    }
    view.dispatch({ selection: EditorSelection.create(ranges) });
    return true;
  }
  return false;
}

class SecondaryCursor extends WidgetType {
  toDOM() { const element = document.createElement('span'); element.className = 'meo-secondary-cursor'; return element; }
}
const secondaryCursor = new SecondaryCursor();
export const secondarySelections = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) { if (update.selectionSet || update.docChanged) this.decorations = this.build(update.view); }
  build(view: EditorView) {
    const ranges = view.state.selection.ranges.flatMap((range, index) => index === view.state.selection.mainIndex ? [] : [
      ...(!range.empty ? [Decoration.mark({ class: 'meo-secondary-selection' }).range(range.from, range.to)] : []),
      Decoration.widget({ widget: secondaryCursor, side: 1 }).range(range.head)
    ]);
    return Decoration.set(ranges, true);
  }
}, { decorations: plugin => plugin.decorations });

/** All ranges share one transaction and history entry. */
export function formatMultipleSelections(view: EditorView, action: string): boolean {
  const markers: Record<string, [string, string]> = { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], lineover: ['~~', '~~'], highlight: ['==', '=='], underline: ['<u>', '</u>'], kbd: ['<kbd>', '</kbd>'] };
  if (!markers[action] && action !== 'inlineCode' && !['link', 'wikiLink', 'image'].includes(action)) return false;
  const changes = view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    let open: string, close: string;
    if (action === 'inlineCode') ({ open, close } = inlineCodeMarkers(text));
    else if (['link', 'wikiLink', 'image'].includes(action)) { open = action === 'wikiLink' ? '[[' : action === 'image' ? '![' : '['; close = action === 'wikiLink' ? ']]' : '](url)'; }
    else [open, close] = markers[action];
    const plan = planInlineWrapper(text, view.state.sliceDoc(Math.max(0, range.from - open.length), range.from), view.state.sliceDoc(range.to, range.to + close.length), open, close);
    const from = range.from - plan.removeBefore;
    const anchor = from + plan.selectedFrom, head = from + plan.selectedTo;
    return { changes: { from, to: range.to + plan.removeAfter, insert: plan.insert }, range: range.anchor > range.head ? EditorSelection.range(head, anchor) : EditorSelection.range(anchor, head) };
  });
  view.dispatch({ ...changes, annotations: annotation }); return true;
}
