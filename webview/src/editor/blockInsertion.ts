import { matchInlineScript } from '../../../src/foundation/inlineScript';
import { readMarkdownListPrefix } from '../../../src/foundation/markdownListPrefix';
import { Annotation, EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import { isSuggestionAddress } from '../application/inputSuggestions';
import { indentedCodeBlockAt } from './codeBlockSource';
import { resolveMarkdownStructureAt } from './backgroundMarkdownStructure';
import { markdownInlineSourceNodeNames } from './markdownStructure';
import { scanHtmlTags, type HtmlTagToken } from '../../../src/foundation/htmlSyntax';
export type MarkdownInputContext = 'block' | 'inline' | 'heading' | 'excluded';
export type MarkdownInputContextAt = (state: EditorState, position: number) => MarkdownInputContext;

/** Number of source lines in the new table. The mapped caret identifies its header. */
export const insertedTableLineCount = Annotation.define<number>();

/** Literal comment markers in code cannot affect later prose comment operations. */
export function markdownCodeRanges(tree: Tree): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  tree.iterate({ enter(node) {
    if (/^(?:FencedCode|CodeBlock|InlineCode)$/.test(node.name)) { ranges.push({ from: node.from, to: node.to }); return false; }
  } });
  return ranges;
}

/** Code/HTML/address contexts never execute prose commands, including while syntax is incomplete. */
export function markdownSyntaxContext(state: EditorState, position: number): MarkdownInputContext {
  if (state.readOnly) return 'excluded';
  if (indentedCodeBlockAt(state, position)) return 'excluded';
  const line = state.doc.lineAt(position), before = state.sliceDoc(line.from, position);
  if (isSuggestionAddress(before)) return 'excluded';
  let context: MarkdownInputContext = 'block';
  let node = syntaxTree(state).resolveInner(position, -1);
  for (;;) {
    if (/^(?:FencedCode|CodeBlock|CodeInfo|CodeText|HTMLBlock|HTMLTag|CommentBlock|ProcessingInstruction)$/.test(node.name)) return 'excluded';
    if (/^(?:InlineCode|Autolink|URL|LinkTitle|LinkLabel)$/.test(node.name) && position > node.from && position < node.to) return 'excluded';
    if (/^(?:Emphasis|StrongEmphasis|Strikethrough|Highlight|Link|Image|Table|TableCell)$/.test(node.name)) context = 'inline';
    if (/^(?:ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)) context = 'heading';
    if (!node.parent) break;
    node = node.parent;
  }
  const offset = position - line.from;
  for (let index = 0; index < offset; index++) {
    if (line.text[index] !== '^' && line.text[index] !== '~') continue;
    const script = matchInlineScript(line.text, index);
    if (script && offset > index && offset < script.to) { context = 'inline'; break; }
    if (script) index = script.to - 1;
  }
  // Incomplete formulas still belong to their editor, rather than to the slash menu.
  if (/\$\$[^$]*$|(?<!\\)\$[^$\n]*$/.test(before)) return 'excluded';
  if (/^[ \t]*(?:>\s*)*\[[^\]]+\]:/.test(line.text)) return 'excluded';
  return context;
}

const atomicTableInsertionSpans = new Set(['InlineMath', 'InlineHTMLCode', 'HTMLTag', 'Comment', 'URL', 'Escape', 'Entity']);
const protectedTableContainers = /^(?:Table|FencedCode|CodeBlock|ATXHeading[1-6]|SetextHeading[12]|HTMLBlock|CommentBlock|ProcessingInstruction|LinkReference)$/;

/** Keep a block split outside the outermost inline construct. At the end of
 * that construct the ordinary input context may still see its left-hand node. */
export function tableInsertionPoint(state: EditorState, position: number, inputContext: MarkdownInputContextAt,
  beforeOpeningContent = true): number | null {
  if (state.readOnly || state.selection.ranges.length !== 1) return null;
  const line = state.doc.lineAt(position);
  const tree = resolveMarkdownStructureAt(state, line.to, 2);
  let outer: { from: number; to: number; openingTo: number } | undefined;
  const include = (from: number, to: number, openingTo: number) => {
    if (from >= position || position > to) return;
    if (!outer || from <= outer.from && to >= outer.to) outer = { from, to, openingTo };
  };
  let paragraph: SyntaxNode | undefined;
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolve(position, side); node; node = node.parent) {
      if (protectedTableContainers.test(node.name)) return null;
      if (node.name === 'InlineMath' && node.from < position && position < node.to) return null;
      if (node.name === 'Paragraph') paragraph = node;
      if (markdownInlineSourceNodeNames.has(node.name) || atomicTableInsertionSpans.has(node.name)) {
        const first = node.firstChild;
        include(node.from, node.to, first?.name.endsWith('Mark') && first.from === node.from ? first.to : node.from);
      }
    }
  }
  if (paragraph && paragraph.to - paragraph.from <= 32_768 && state.sliceDoc(paragraph.from, paragraph.to).includes('<')) {
    const tags: (Pick<HtmlTagToken, 'name' | 'from' | 'to'>)[] = [];
    // Pair actual Markdown HTML tokens so literal angle brackets in code are ignored.
    tree.iterate({ from: paragraph.from, to: paragraph.to, enter(node) {
      if (node.name !== 'HTMLTag') return;
      const [tag] = scanHtmlTags(state.sliceDoc(node.from, node.to));
      if (!tag || tag.selfClosing) return;
      if (!tag.closing) tags.push({ name: tag.name, from: node.from, to: node.to });
      else if (tags.at(-1)?.name === tag.name) {
        const open = tags.pop()!;
        include(open.from, node.to, open.to);
      }
    } });
  }
  if (!outer) return inputContext(state, position) === 'block' ? position : null;
  const leadingContext = inputContext(state, outer.from);
  if (leadingContext !== 'block' && leadingContext !== 'inline') return null;
  return beforeOpeningContent && position <= outer.openingTo ? outer.from : outer.to;
}

/** Relocating a typed slash command consumes the query where it was typed and
 * inserts the block in the same undoable transaction at the safe boundary. */
export function tableBlockInsertion(state: EditorState, from: number, to: number, block: string, caret: number,
  inputContext: MarkdownInputContextAt) {
  const point = tableInsertionPoint(state, from, inputContext, from === to);
  if (point === null || point > from && point < to) return null;
  if (point === from || from === to) {
    const plan = blockInsertion(state, point, point === from ? to : point, block, caret, 'block');
    return plan && { ...plan, point };
  }
  const plan = blockInsertion(state, point, point, block, caret, 'block');
  if (!plan) return null;
  const positionAt = (offset: number) => plan.positionAt(offset) - (to - from);
  return { ...plan, point, positionAt, transaction: {
    changes: [{ from, to }, plan.transaction.changes!],
    selection: EditorSelection.cursor(positionAt(caret))
  } satisfies TransactionSpec };
}

/** Replaces a query, or inserts after a preserved selection. The editor supplies the context at `from`. */
export function blockInsertion(state: EditorState, from: number, to: number, block: string, caret: number, context: MarkdownInputContext): {
  transaction: TransactionSpec;
  positionAt: (offset: number) => number;
  lineCount: number;
} | null {
  if (state.selection.ranges.length !== 1 || context !== 'block') return null;
  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(to).number !== line.number) return null;
  const rawPrefix = /^[ \t]*(?:>[ \t]*)*/.exec(line.text)?.[0] ?? '';
  const list = readMarkdownListPrefix(line.text, rawPrefix.length);
  const marker = list && list.toOffset > list.markerEndOffset ? line.text.slice(rawPrefix.length, list.toOffset) : '';
  const insidePrefix = from < line.from + rawPrefix.length + marker.length;
  const firstPrefix = insidePrefix ? '' : rawPrefix + marker;
  const baseLength = marker && list ? (list.taskBracketStart ?? list.toOffset) - rawPrefix.length : 0;
  let continuation = insidePrefix ? '' : rawPrefix + ' '.repeat(baseLength);
  // A continuation line already carries its list indentation; the syntax tree owns the hierarchy.
  let node = syntaxTree(state).resolveInner(from, -1);
  while (node.parent && node.name !== 'ListItem') node = node.parent;
  if (!insidePrefix && !marker && node.name === 'ListItem') {
    const opening = state.doc.lineAt(node.from).text;
    const quote = /^[ \t]*(?:>[ \t]*)*/.exec(opening)?.[0] ?? '';
    const openingList = readMarkdownListPrefix(opening, quote.length);
    if (openingList && openingList.toOffset > openingList.markerEndOffset) {
      continuation = quote + ' '.repeat((openingList.taskBracketStart ?? openingList.toOffset) - quote.length);
    }
  }
  const left = state.sliceDoc(line.from + firstPrefix.length, from);
  const right = state.sliceDoc(to, line.to);
  const emptyLeft = !left.trim();
  const lines = block.split('\n');
  // An empty task marker stays on its own line so it cannot become part of a table header.
  const emptyTask = emptyLeft && !insidePrefix && list?.taskMarker !== undefined;
  const prefix = emptyLeft && !emptyTask ? firstPrefix : continuation;
  const rendered = lines.map((text, index) => (index ? continuation : prefix) + text).join('\n');
  const before = emptyTask ? firstPrefix + '\n' + continuation + '\n' : emptyLeft ? (line.number > 1 && state.doc.line(line.number - 1).text.trim() ? continuation + '\n' : '') : '\n' + continuation + '\n';
  let after = right.trim() ? '\n' + continuation + '\n' + continuation : '';
  if (!after && line.to < state.doc.length) {
    const next = state.doc.line(line.number + 1);
    if (next.text.trim()) after = '\n' + continuation;
  }
  const changeFrom = emptyLeft ? line.from : from;
  const positionAt = (offset: number) => changeFrom + before.length + offset + prefix.length + (block.slice(0, offset).match(/\n/g)?.length ?? 0) * continuation.length;
  return { transaction: { changes: { from: changeFrom, to, insert: before + rendered + after }, selection: EditorSelection.cursor(positionAt(caret)) },
    positionAt, lineCount: lines.length };
}
