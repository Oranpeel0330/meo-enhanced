import { matchInlineScript } from '../../../src/foundation/inlineScript';
import { readMarkdownContainerPrefixes, readMarkdownListPrefix } from '../../../src/foundation/markdownListPrefix';
import { Annotation, countColumn, EditorSelection, type EditorState, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import { isSuggestionAddress } from '../application/inputSuggestions';
import { indentedCodeBlockAt } from './codeBlockSource';
import { resolveMarkdownStructureAt } from './backgroundMarkdownStructure';
import { markdownInlineSourceNodeNames } from './markdownStructure';
import { scanHtmlTags, type HtmlTagToken } from '../../../src/foundation/htmlSyntax';
export type MarkdownInputContext = 'block' | 'inline' | 'heading' | 'excluded';
export type MarkdownInputContextAt = (state: EditorState, position: number) => MarkdownInputContext;
export type MarkdownBlockGuard = (state: EditorState, from: number, to: number) => boolean;

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
  if (isSuggestionAddress(before) || insideContainerPrefix(line, position)) return 'excluded';
  let context: MarkdownInputContext = 'block';
  let node = syntaxTree(state).resolveInner(position, -1);
  for (;;) {
    if (insideStructuralMarker(state, node, position)) return 'excluded';
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
    if (script && offset > index && offset < script.to) { if (context !== 'heading') context = 'inline'; break; }
    if (script) index = script.to - 1;
  }
  // Incomplete formulas still belong to their editor, rather than to the slash menu.
  if (/\$\$[^$]*$|(?<!\\)\$[^$\n]*$/.test(before)) return 'excluded';
  if (/^[ \t]*(?:>\s*)*\[[^\]]+\]:/.test(line.text)) return 'excluded';
  return context;
}

const atomicTableInsertionSpans = new Set(['InlineMath', 'InlineHTMLCode', 'HTMLTag', 'Comment', 'URL', 'Escape', 'Entity']);
const protectedBlockNames = /^(?:Table|FencedCode|CodeBlock|HTMLBlock|CommentBlock|ProcessingInstruction|LinkReference|FootnoteDefinition)$/;
const headingNames = /^(?:ATXHeading[1-6]|SetextHeading[12])$/;
type BlockLine = ReturnType<EditorState['doc']['lineAt']>;

function insideContainerPrefix(line: BlockLine, position: number): boolean {
  const last = readMarkdownContainerPrefixes(line.text).at(-1);
  return !!last && line.from < position && position < line.from + last.to;
}

function insideStructuralMarker(state: EditorState, node: SyntaxNode, position: number): boolean {
  if (node.name === 'HeaderMark') {
    return node.parent?.name.startsWith('SetextHeading') ? position < node.to : node.from < position && position < node.to;
  }
  if (node.name === 'Table') {
    const delimiter = node.getChild('TableDelimiter');
    return !!delimiter && state.doc.lineAt(delimiter.from).number === state.doc.lineAt(position).number;
  }
  return false;
}

export type BlockInsertionLocation = { readonly point: number; readonly tree: Tree };

/** Keep a block split outside the outermost inline construct. At the end of
 * that construct the ordinary input context may still see its left-hand node. */
export function blockInsertionLocation(state: EditorState, position: number, inputContext: MarkdownInputContextAt,
  protectedRange: MarkdownBlockGuard, beforeOpeningContent = true): BlockInsertionLocation | null {
  if (state.readOnly || state.selection.ranges.length !== 1) return null;
  const line = state.doc.lineAt(position);
  const tree = resolveMarkdownStructureAt(state, line.to, 2);
  if (protectedRange(state, position, position) || insideContainerPrefix(line, position) || indentedCodeBlockAt(state, position, tree)) return null;
  let outer: { from: number; to: number; openingTo: number } | undefined;
  const include = (from: number, to: number, openingTo: number) => {
    if (from >= position || position > to) return;
    if (!outer || from <= outer.from && to >= outer.to) outer = { from, to, openingTo };
  };
  let paragraph: SyntaxNode | undefined;
  let heading: SyntaxNode | undefined;
  let blockEdge = false;
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolve(position, side); node; node = node.parent) {
      if (insideStructuralMarker(state, node, position)) return null;
      if (protectedBlockNames.test(node.name)) {
        if (node.from < position && position < node.to) return null;
        if (node.name === 'FencedCode' && position === node.to
            && (node.lastChild?.name !== 'CodeMark' || node.lastChild.from === node.from)) return null;
        blockEdge = true;
      }
      if (headingNames.test(node.name)) heading = node;
      if (node.name === 'InlineMath' && node.from < position && position < node.to) return null;
      if (node.name === 'Paragraph') paragraph = node;
      if (markdownInlineSourceNodeNames.has(node.name) || atomicTableInsertionSpans.has(node.name)) {
        const first = node.firstChild;
        include(node.from, node.to, first?.name.endsWith('Mark') && first.from === node.from ? first.to : node.from);
      }
    }
  }
  if (heading) {
    const firstLine = state.doc.lineAt(heading.from), header = heading.firstChild;
    const bodyStart = header?.name === 'HeaderMark' && header.to <= firstLine.to
      ? header.to + (/^[ \t]*/.exec(state.sliceDoc(header.to, firstLine.to))?.[0].length ?? 0) : heading.from;
    return { point: position <= bodyStart ? heading.from : heading.to, tree };
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
  if (!outer) return blockEdge || inputContext(state, position) === 'block' ? { point: position, tree } : null;
  const leadingContext = inputContext(state, outer.from);
  if (leadingContext !== 'block' && leadingContext !== 'inline') return null;
  return { point: beforeOpeningContent && position <= outer.openingTo ? outer.from : outer.to, tree };
}

function blockContainers(tree: Tree, point: number): SyntaxNode[] {
  const owners: SyntaxNode[] = [];
  for (let node: SyntaxNode | null = tree.resolve(point, -1); node; node = node.parent) {
    if (node.name === 'Blockquote' || node.name === 'ListItem') owners.push(node);
  }
  return owners.reverse();
}

/** Match real block ownership even when the current line omits container markers. */
function continuationPrefix(state: EditorState, owners: readonly SyntaxNode[], whitespace: string): string {
  let prefix = '';
  for (const owner of owners) {
    const quote = owner.name === 'Blockquote';
    const mark = owner.getChild(quote ? 'QuoteMark' : 'ListMark');
    if (!mark) continue;
    const line = state.doc.lineAt(mark.from), offset = mark.from - line.from;
    const list = quote ? null : readMarkdownListPrefix(line.text, offset);
    const end = list ? list.taskBracketStart ?? list.toOffset : offset;
    const columns = countColumn(line.text, state.tabSize, end);
    prefix += ' '.repeat(Math.max(0, columns - countColumn(prefix, state.tabSize)));
    if (quote) prefix += '> ';
  }
  return prefix || whitespace;
}

/** A prose transformation may not consume any portion of an existing protected block. */
export function protectedMarkdownEdit(state: EditorState, from: number, to: number, protectedRange: MarkdownBlockGuard,
  headings: 'allow' | 'setext' | 'protect'): boolean {
  if (state.readOnly || protectedRange(state, from, to)) return true;
  const tree = resolveMarkdownStructureAt(state, to, 2);
  if (indentedCodeBlockAt(state, from, tree)) return true;
  let blocked = false;
  tree.iterate({ from, to, enter(node) {
    if (blocked || !(node.from < to && from < node.to)) return false;
    if (protectedBlockNames.test(node.name) || headings === 'protect' && headingNames.test(node.name)
        || headings === 'setext' && node.name.startsWith('SetextHeading')) { blocked = true; return false; }
  } });
  return blocked;
}

export function planMarkdownBlockInsertion(state: EditorState, location: BlockInsertionLocation, block: string, caret: number,
  to = location.point, caretEnd = caret): {
  transaction: TransactionSpec & { changes: NonNullable<TransactionSpec['changes']> };
  positionAt: (offset: number) => number;
  lineCount: number;
} {
  const { point: from, tree } = location;
  const line = state.doc.lineAt(from), lastLine = state.doc.lineAt(to);
  const whitespace = /^[ \t]*/.exec(line.text)?.[0] ?? '';
  const marker = readMarkdownContainerPrefixes(line.text).at(-1);
  const insidePrefix = from < line.from + (marker?.to ?? whitespace.length);
  const firstPrefix = insidePrefix ? '' : line.text.slice(0, marker?.to ?? whitespace.length);
  const continuation = insidePrefix ? '' : continuationPrefix(state, blockContainers(tree, from), whitespace);
  const left = state.sliceDoc(line.from + firstPrefix.length, from);
  const right = state.sliceDoc(to, lastLine.to);
  const emptyLeft = !left.trim();
  const lines = block.split('\n');
  // An empty task marker stays on its own line so it cannot become part of a table header.
  const emptyTask = emptyLeft && !insidePrefix && marker?.kind === 'list' && marker.marker.taskMarker !== undefined;
  // A leading list dash plus another run of dashes would parse as a top-level divider.
  const listDivider = emptyLeft && !emptyTask && !insidePrefix && marker?.kind === 'list' && block === '---';
  const prefix = emptyLeft && !emptyTask && !listDivider ? firstPrefix : continuation;
  const rendered = lines.map((text, index) => (index ? continuation : prefix) + text).join('\n');
  const before = emptyTask ? firstPrefix + '\n' + continuation + '\n' : listDivider ? firstPrefix + '\n' : emptyLeft
    ? (line.number === 1 && block === '---' && !prefix && state.doc.length > 0 || line.number > 1 && state.doc.line(line.number - 1).text.trim() ? continuation + '\n' : '')
    : '\n' + continuation + '\n';
  let after = right.trim() ? '\n' + continuation + '\n' + continuation : '';
  if (!after) {
    if (lastLine.to < state.doc.length && state.doc.line(lastLine.number + 1).text.trim()) after = '\n' + continuation;
    else if (block === '---' && state.doc.length > 0) {
      // Leave the same paragraph space after a divider as the formatting toolbar.
      if (lastLine.to === state.doc.length) after = '\n' + continuation + '\n' + continuation;
      else if (lastLine.number + 1 === state.doc.lines) after = '\n' + continuation;
    }
  }
  const changeFrom = emptyLeft ? line.from : from;
  const positionAt = (offset: number) => changeFrom + before.length + offset + prefix.length + (block.slice(0, offset).match(/\n/g)?.length ?? 0) * continuation.length;
  return { transaction: { changes: { from: changeFrom, to, insert: before + rendered + after }, selection: EditorSelection.range(positionAt(caret), positionAt(caretEnd)) },
    positionAt, lineCount: lines.length };
}

/** Wrapping consumes the selection, so both cuts must already be safe boundaries. */
export function planMarkdownBlockWrap(state: EditorState, selection: SelectionRange, inputContext: MarkdownInputContextAt,
  protectedRange: MarkdownBlockGuard, math: boolean) {
  const { from, to } = selection;
  if (protectedMarkdownEdit(state, from, to, protectedRange, 'protect')) return null;
  const start = blockInsertionLocation(state, from, inputContext, protectedRange);
  const end = blockInsertionLocation(state, to, inputContext, protectedRange);
  if (start?.point !== from || end?.point !== to) return null;
  const first = blockContainers(start.tree, from), last = blockContainers(end.tree, to);
  if (first.length !== last.length || first.some((owner, index) => owner.from !== last[index]?.from || owner.name !== last[index]?.name)) return null;
  const prefix = continuationPrefix(state, first, '');
  const lines = state.sliceDoc(from, to).split('\n');
  const content = lines.map((line, index) => index && prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line).join('\n');
  if (math && /^\s*\$\$\s*$/m.test(content)) return null;
  let fenceLength = 3;
  if (!math) for (const match of content.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = math ? '$$' : '`'.repeat(fenceLength), body = fence.length + 1;
  const endOfBody = math ? body + content.length : body;
  return planMarkdownBlockInsertion(state, start, fence + '\n' + content + '\n' + fence,
    selection.anchor > selection.head ? endOfBody : body, to, selection.anchor > selection.head ? body : endOfBody);
}
