import { countColumn, EditorSelection, EditorState, findColumn, type ChangeSpec, type Line, type SelectionRange } from '@codemirror/state';
import { toggleBlockComment } from '@codemirror/commands';
import { IterMode, type SyntaxNode, type Tree } from '@lezer/common';
import { getCodeBlockSourceLines, indentedCodeBlockAt } from './codeBlockSource';

export type CodeCommentTokens = { readonly line?: string; readonly block?: { readonly open: string; readonly close: string } };
export type CodeCommentLanguage = (state: EditorState, info: string) => CodeCommentTokens | undefined;

type CodeLine = ReturnType<typeof getCodeBlockSourceLines>[number];
type CodeSelection = { range: SelectionRange; first: Line; last: Line; start: CodeLine };
type CodeBlockSelections = { block: SyntaxNode; selections: CodeSelection[] };

function lineComments(state: EditorState, { block, selections }: CodeBlockSelections, token: string): ChangeSpec[] {
  const selectedLines = new Map<number, boolean>();
  for (const { first, last } of selections) {
    for (let number = first.number; number <= last.number; number++) {
      selectedLines.set(number, selectedLines.get(number) === true || first.number === last.number);
    }
  }
  const rows: Array<{ line: Line; source: CodeLine; firstText: number; indent: number; commented: boolean }> = [];
  let minIndent = Infinity;
  for (const [number, includeBlank] of selectedLines) {
    const line = state.doc.line(number), [source] = getCodeBlockSourceLines(state, block, number);
    if (!source || source.isFence) continue;
    const prefix = source.prefixTo - line.from;
    const firstText = prefix + (/^[ \t]*/.exec(line.text.slice(prefix))?.[0].length ?? 0);
    if (!includeBlank && firstText === line.length) continue;
    const indent = countColumn(line.text, state.tabSize, firstText) - source.prefixColumns + source.payloadInset;
    if (firstText < line.length) minIndent = Math.min(minIndent, indent);
    rows.push({ line, source, firstText, indent, commented: line.text.startsWith(token, firstText) });
  }
  const uncomment = rows.every(row => row.commented);
  return rows.map(({ line, source, firstText, indent }) => {
    if (uncomment) {
      const end = firstText + token.length;
      return { from: line.from + firstText, to: line.from + end + (line.text[end] === ' ' ? 1 : 0) };
    }
    const column = source.prefixColumns - source.payloadInset + Math.min(indent, minIndent);
    const offset = Math.max(source.prefixTo - line.from, findColumn(line.text, column, state.tabSize));
    return { from: line.from + offset, insert: token + ' ' };
  });
}

function blockComments(state: EditorState, { block, selections }: CodeBlockSelections, tokens: CodeCommentTokens, lines: boolean): ChangeSpec[] | null {
  const ranges = selections.map(({ range, first, last, start }) => {
    if (!lines) return range;
    const indent = /^[ \t]*/.exec(first.text.slice(start.prefixTo - first.from))?.[0].length ?? 0;
    return EditorSelection.range(start.prefixTo + indent, last.to);
  });
  // Reuse the delimiter and whitespace rules without consulting the Markdown
  // language at physical line start or building another syntax tree.
  const target = EditorState.create({ doc: state.doc, selection: EditorSelection.create(ranges),
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.languageData.of(() => [{ commentTokens: tokens }])] });
  const edits: ChangeSpec[] = [];
  let safe = true;
  toggleBlockComment({ state: target, dispatch(transaction) {
    transaction.changes.iterChanges((from, to, _start, _end, insert) => {
      // Existing block comments can use a newline as delimiter padding. Keep
      // that newline and any container prefix on the adjacent source line.
      if (from < to && state.sliceDoc(from, from + 1) === '\n') from++;
      if (from < to && state.sliceDoc(to - 1, to) === '\n') to--;
      const line = state.doc.lineAt(from), [source] = getCodeBlockSourceLines(state, block, line.number);
      if (!source || source.isFence || from < source.prefixTo || to > source.to) safe = false;
      else edits.push({ from, to, insert });
    });
  } });
  return safe ? edits : null;
}

/** Plan fenced code comments in Markdown source coordinates. A selection that
 * touches both prose and code, or a fence delimiter, is left intact. */
export function planCodeComments(state: EditorState, tree: Tree, lines: boolean, language: CodeCommentLanguage):
  ChangeSpec[] | 'blocked' | 'unsupported' | null {
  const groups = new Map<number, CodeBlockSelections>();
  let prose = false;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from), last = state.doc.lineAt(lines && !range.empty ? range.to - 1 : range.to);
    const blocks: SyntaxNode[] = [];
    let insideInlineCode = false;
    tree.iterate({ from: first.from, to: last.to, mode: IterMode.IgnoreMounts, enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        if (node.from <= last.to && node.to >= first.from) blocks.push(node.node);
        return false;
      }
      if (!lines && node.name === 'InlineCode' && (node.from < range.from && range.from < node.to
          || node.from < range.to && range.to < node.to)) insideInlineCode = true;
    } });
    if (insideInlineCode || blocks.length > 1) return 'blocked';
    const block = blocks[0] ?? indentedCodeBlockAt(state, first.from, tree);
    if (!block) { prose = true; continue; }
    const [start] = getCodeBlockSourceLines(state, block, first.number);
    const [end] = getCodeBlockSourceLines(state, block, last.number);
    if (!start || !end || start.isFence || end.isFence || !lines && range.from < start.prefixTo
        || !lines && range.to < end.prefixTo) return 'blocked';
    let group = groups.get(block.from);
    if (!group) groups.set(block.from, group = { block, selections: [] });
    group.selections.push({ range, first, last, start });
  }
  if (!groups.size) return null;
  if (prose) return 'blocked';

  const edits: ChangeSpec[] = [];
  for (const group of groups.values()) {
    const info = group.block.getChild('CodeInfo');
    const name = info ? state.sliceDoc(info.from, info.to).trimStart().split(/\s/, 1)[0] : undefined;
    const tokens = name ? language(state, name) : undefined;
    if (!tokens) return 'unsupported';
    if (lines && tokens.line) edits.push(...lineComments(state, group, tokens.line));
    else if (tokens.block) {
      const blockEdits = blockComments(state, group, tokens, lines);
      if (!blockEdits) return 'blocked';
      edits.push(...blockEdits);
    } else return 'unsupported';
  }
  return edits;
}
