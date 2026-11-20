import type { Text } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { Parser } from 'htmlparser2';
import { parseWikiReference } from '../../../src/foundation/wikiReference';
import type { DocumentStatistics } from '../../../src/protocol/documentStatistics';
import { maximumStatisticsBlockLength, maximumStatisticsBlocks, type StatisticsSelection } from '../application/documentStatisticsWork';

type Block = {
  from: number;
  to: number;
  first: SyntaxNode | null;
  nodeCount: number;
};
type BlockSummary = { words: number; characters: number; breaks: number };
export type StatisticsBlockCache = WeakMap<Tree, { suffix: string; summary: BlockSummary }>;
export type StatisticsResponse = Readonly<{ id: number; statistics: DocumentStatistics | null; reset?: true }>;

// Each CJK character is a word. Combining marks extend a word; keycap emoji
// cannot start or continue numeric words.
const cjk = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]';
const excluded = cjk + '|[0-9]\\uFE0F?\\u20E3';
const wordStart = '(?:(?!' + excluded + ')[\\p{L}\\p{N}])';
const wordContinuation = '(?:(?!' + excluded + ')[\\p{L}\\p{M}\\p{N}])';
const words = new RegExp(cjk + '\\p{M}*|' + wordStart + wordContinuation + "*(?:['’]" + wordStart + wordContinuation + '*)*', 'gu');

function frontmatterEnd(doc: Text): number {
  if (doc.lines < 3 || !/^(?:\uFEFF)?---\r?$/.test(doc.line(1).text)) return 0;
  let offset = doc.line(3).from;
  for (const line of doc.iterLines(3)) {
    const to = offset + line.length;
    const hasBreak = to < doc.length;
    if (/^(?:---|\.\.\.)$/.test(hasBreak && line.endsWith('\r') ? line.slice(0, -1) : line)) {
      return to + Number(hasBreak);
    }
    offset = to + 1;
  }
  return 0;
}

// Use the complete Markdown tree. Only a retained newline between siblings
// proves that removing inline markup cannot join words across this cut.
function* statisticsBlocks(doc: Text, tree: Tree, hiddenPrefix: number): Iterable<Block> {
  let from = 0, first = tree.topNode.firstChild, last: SyntaxNode | null = null, nodeCount = 0;
  for (let node = first; node; node = node.nextSibling) {
    if (last && node.from >= hiddenPrefix && node.from > last.to && doc.sliceString(node.from - 1, node.from) === '\n') {
      yield { from, to: node.from, first, nodeCount };
      from = node.from; first = node; nodeCount = 0;
    }
    last = node;
    nodeCount++;
  }
  yield { from, to: doc.length, first, nodeCount };
}

function projectBlock(text: string, block: Block, hiddenPrefix: number, mapSource: boolean) {
  const replacements: (StatisticsSelection & { value: string })[] = [];
  const replace = (from: number, to: number, value = '') => replacements.push({ from, to, value });
  let decoded = '';
  let decoder: Parser | undefined;
  const entity = (from: number, to: number) => {
    decoder ??= new Parser({ ontext(value) { decoded += value; } }, { decodeEntities: true });
    decoded = ''; decoder.reset(); decoder.end(text.slice(from, to)); replace(from, to, decoded);
  };
  const html = (from: number, to: number) => {
    for (const match of text.slice(from, to).matchAll(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>|&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi)) {
      const start = from + match.index, end = start + match[0].length;
      if (match[0][0] === '&') entity(start, end);
      else replace(start, end, /^<\/?(?:br|p|div|li|td|tr|h[1-6]|hr)\b/i.test(match[0]) ? ' ' : '');
    }
  };
  if (block.from < hiddenPrefix) replace(0, hiddenPrefix - block.from, ' ');
  let node = block.first;
  for (let i = 0; i < block.nodeCount && node; i++, node = node.nextSibling) {
    node.cursor().iterate(syntax => {
      const from = syntax.from - block.from, to = syntax.to - block.from, name = syntax.name;
      if (name === 'HTMLBlock' || name === 'HTMLTag') { html(from, to); return false; }
      if (name === 'Entity') { entity(from, to); return false; }
      if (name === 'Escape') { replace(from, from + 1); return false; }
      if (name === 'Link' || name === 'Image') {
        const wiki = parseWikiReference(text, from) ?? (from > 0 ? parseWikiReference(text, from - 1) : null);
        if (wiki && (wiki.to === to || wiki.to === to + 1)) {
          const start = wiki.from + (wiki.embed ? 3 : 2), end = wiki.to - 2;
          const pipe = text.indexOf('|', start);
          if (pipe >= start && pipe < end) {
            if (wiki.embed || !text.slice(pipe + 1, end).trim()) replace(pipe - (text[pipe - 1] === '\\' ? 1 : 0), end);
            else replace(start, pipe + 1);
          }
        }
      }
      if (name.endsWith('Mark') || ['CodeInfo', 'LinkTitle', 'LinkLabel', 'LinkReference', 'Comment', 'CommentBlock', 'ProcessingInstruction'].includes(name)
        || name === 'URL' && syntax.node.parent?.name !== 'Autolink') {
        replace(from, to); return false;
      }
    });
  }
  replacements.sort((a, b) => a.from - b.from || b.to - a.to);
  const chunks: string[] = [];
  const runs: (StatisticsSelection & { start: number; end: number; atomic: boolean })[] = [];
  let length = 0, cursor = 0;
  const append = (from: number, to: number, value: string, atomic = false) => {
    if (!value) return;
    chunks.push(value);
    if (mapSource) runs.push({ from, to, start: length, end: length + value.length, atomic });
    length += value.length;
  };
  for (const replacement of replacements) {
    if (replacement.to <= cursor) continue;
    if (replacement.from > cursor) append(cursor, replacement.from, text.slice(cursor, replacement.from));
    append(Math.max(cursor, replacement.from), replacement.to, replacement.value, true);
    cursor = replacement.to;
  }
  append(cursor, text.length, text.slice(cursor));
  return { visible: chunks.join(''), runs };
}

function summarizeBlock(doc: Text, block: Block, hiddenPrefix: number): BlockSummary {
  const text = doc.sliceString(block.from, block.to);
  let count = 0;
  for (const _word of projectBlock(text, block, hiddenPrefix, false).visible.matchAll(words)) count++;
  let breaks = 0, characters = text.length;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 13 || unit === 10) {
      breaks++;
      if (unit === 13 && text.charCodeAt(i + 1) === 10) i++;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { characters--; i++; }
    }
  }
  return { words: count, characters, breaks };
}

function selectedBlockWords(doc: Text, block: Block, hiddenPrefix: number, selections: readonly StatisticsSelection[],
  firstSelection: number): number {
  const { visible, runs } = projectBlock(doc.sliceString(block.from, block.to), block, hiddenPrefix, true);
  let selected = 0, runIndex = 0, selectionIndex = firstSelection;
  for (const match of visible.matchAll(words)) {
    const end = match.index + match[0].length;
    while (runs[runIndex] && runs[runIndex]!.end <= match.index) runIndex++;
    for (let i = runIndex; runs[i] && runs[i]!.start < end; i++) {
      const run = runs[i]!;
      const from = block.from + (run.atomic ? run.from : run.from + Math.max(0, match.index - run.start));
      const to = block.from + (run.atomic ? run.to : run.from + Math.min(run.end, end) - run.start);
      while (selections[selectionIndex] && selections[selectionIndex]!.to <= from) selectionIndex++;
      if (selections[selectionIndex] && selections[selectionIndex]!.from < to) { selected++; break; }
    }
  }
  return selected;
}

/** Derived summaries only. The worker owns the immutable document and tree. */
export function createDocumentStatisticsIndex(doc: Text, tree: Tree, cache: StatisticsBlockCache = new WeakMap()) {
  const hiddenPrefix = frontmatterEnd(doc);
  const blocks: (Block & { words: number })[] = [];
  let lines = 1, characters = 0, totalWords = 0;
  for (const block of statisticsBlocks(doc, tree, hiddenPrefix)) {
    if (block.to - block.from > maximumStatisticsBlockLength || blocks.length === maximumStatisticsBlocks) return null;
    // Reuse only a complete, unchanged syntax block with the same edge text.
    const node = block.first;
    const key = node && block.nodeCount === 1 && node.from === block.from && block.from >= hiddenPrefix
      && block.to - node.to <= 64 ? node.tree : null;
    const suffix = key && node ? doc.sliceString(node.to, block.to) : '';
    const previous = key ? cache.get(key) : undefined;
    const summary = previous?.suffix === suffix ? previous.summary : summarizeBlock(doc, block, hiddenPrefix);
    if (key && summary !== previous?.summary) cache.set(key, { suffix, summary });
    lines += summary.breaks; characters += summary.characters; totalWords += summary.words;
    blocks.push({ ...block, words: summary.words });
  }
  return (selections: readonly StatisticsSelection[], line: number | null,
    hasSelection = selections.some(selection => selection.to > selection.from)): DocumentStatistics => {
    const ranges = selections.filter(({ from, to }) => to > from).sort((a, b) => a.from - b.from || b.to - a.to);
    let selectedWords = 0, index = 0;
    if (ranges.length) for (const block of blocks) {
      while (ranges[index] && ranges[index]!.to <= block.from) index++;
      const selection = ranges[index];
      if (!selection) break;
      if (selection.from >= block.to || block.words === 0) continue;
      selectedWords += selection.from <= block.from && selection.to >= block.to ? block.words
        : selectedBlockWords(doc, block, hiddenPrefix, ranges, index);
    }
    return { words: totalWords, selectedWords, hasSelection, lines, line, characters };
  };
}
