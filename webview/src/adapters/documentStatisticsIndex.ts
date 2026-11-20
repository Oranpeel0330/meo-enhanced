import type { MarkdownParser } from '@lezer/markdown';
import { Parser } from 'htmlparser2';
import { parseWikiReference } from '../../../src/foundation/wikiReference';
import type { DocumentStatistics } from '../../../src/protocol/documentStatistics';

export type StatisticsSelection = { from: number; to: number };
export type StatisticsRequest = {
  id: number; text?: string; selections: StatisticsSelection[]; line: number | null; hasSelection?: boolean;
};

const wordSpanChunkSize = 16_384;
const wordSpanStride = 3;
const wordSpanFrom = 0, wordSpanTo = 1, wordSpanWord = 2;

/** Worker-owned source positions keep partial selections consistent with the total. */
export function createDocumentStatisticsIndex(text: string, grammar: Pick<MarkdownParser, 'parse'>) {
  const replacements: (StatisticsSelection & { value: string })[] = [];
  const replace = (from: number, to: number, value = '') => replacements.push({ from, to, value });
  let decoded = '';
  const decoder = new Parser({ ontext(value) { decoded += value; } }, { decodeEntities: true });
  const entity = (from: number, to: number) => {
    decoded = ''; decoder.reset(); decoder.end(text.slice(from, to)); replace(from, to, decoded);
  };
  const html = (from: number, to: number) => {
    for (const match of text.slice(from, to).matchAll(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z](?:[^>"']|"[^"]*"|'[^']*')*>|&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi)) {
      const start = from + match.index, end = start + match[0].length;
      if (match[0][0] === '&') entity(start, end);
      else replace(start, end, /^<\/?(?:br|p|div|li|td|th|tr|h[1-6]|hr)\b/i.test(match[0]) ? ' ' : '');
    }
  };
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  if (frontmatter) replace(0, frontmatter[0].length, ' ');
  grammar.parse(text).iterate({ enter(node) {
    if (node.name === 'HTMLBlock') {
      html(node.from, node.to);
      return false;
    }
    if (node.name === 'Entity') { entity(node.from, node.to); return false; }
    if (node.name === 'Escape') { replace(node.from, node.from + 1); return false; }
    if (node.name === 'HTMLTag') { html(node.from, node.to); return false; }
    if (node.name === 'Link' || node.name === 'Image') {
      const wiki = parseWikiReference(text, node.from) ?? (node.from > 0 ? parseWikiReference(text, node.from - 1) : null);
      if (wiki && (wiki.to === node.to || wiki.to === node.to + 1)) {
        const start = wiki.from + (wiki.embed ? 3 : 2), end = wiki.to - 2;
        const pipe = text.indexOf('|', start);
        if (pipe >= start && pipe < end) {
          if (wiki.embed || !text.slice(pipe + 1, end).trim()) replace(pipe - (text[pipe - 1] === '\\' ? 1 : 0), end);
          else replace(start, pipe + 1);
        }
      }
    }
    if (node.name.endsWith('Mark') || ['CodeInfo', 'LinkTitle', 'LinkLabel', 'LinkReference', 'Comment', 'CommentBlock', 'ProcessingInstruction'].includes(node.name)
      || node.name === 'URL' && node.node.parent?.name !== 'Autolink') {
      replace(node.from, node.to); return false;
    }
  } });
  replacements.sort((a, b) => a.from - b.from || b.to - a.to);
  const chunks: string[] = [];
  const runs: (StatisticsSelection & { start: number; end: number; atomic: boolean })[] = [];
  let length = 0, cursor = 0;
  const append = (from: number, to: number, value: string, atomic = false) => {
    if (!value) return;
    chunks.push(value); runs.push({ from, to, start: length, end: length + value.length, atomic }); length += value.length;
  };
  for (const replacement of replacements) {
    if (replacement.to <= cursor) continue;
    if (replacement.from > cursor) append(cursor, replacement.from, text.slice(cursor, replacement.from));
    append(Math.max(cursor, replacement.from), replacement.to, replacement.value, true);
    cursor = replacement.to;
  }
  append(cursor, text.length, text.slice(cursor));
  replacements.length = 0;
  const projectedText = chunks.join('');
  chunks.length = 0;
  // CJK text can have a word span for nearly every source character. Packed
  // chunks avoid millions of objects and duplicating the index as it grows.
  const spans: Uint32Array[] = [];
  let spanCount = 0;
  const spanValue = (index: number, field: number) =>
    spans[Math.floor(index / wordSpanChunkSize)]![index % wordSpanChunkSize * wordSpanStride + field]!;
  // Each CJK character is a word; other scripts use letter/number runs.
  const cjk = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]';
  const excluded = `${cjk}|[0-9]\\uFE0F?\\u20E3`;
  const start = `(?:(?!${excluded})[\\p{L}\\p{N}])`;
  const other = `(?:(?!${excluded})[\\p{L}\\p{M}\\p{N}])`;
  // A combining/variation mark extends a letter, but cannot start a word.
  // Keycap emoji contain ASCII digits and must not become numeric words.
  const words = new RegExp(`${cjk}\\p{M}*|${start}${other}*(?:['’]${start}${other}*)*`, 'gu');
  let wordCount = 0, runIndex = 0;
  for (const match of projectedText.matchAll(words)) {
    const end = match.index + match[0].length;
    while (runs[runIndex] && runs[runIndex]!.end <= match.index) runIndex++;
    for (let i = runIndex; runs[i] && runs[i]!.start < end; i++) {
      const run = runs[i]!;
      const from = run.atomic ? run.from : run.from + Math.max(0, match.index - run.start);
      const to = run.atomic ? run.to : run.from + Math.min(run.end, end) - run.start;
      const offset = spanCount % wordSpanChunkSize * wordSpanStride;
      if (offset === 0) spans.push(new Uint32Array(wordSpanChunkSize * wordSpanStride));
      const chunk = spans[spans.length - 1]!;
      chunk[offset + wordSpanFrom] = from;
      chunk[offset + wordSpanTo] = to;
      chunk[offset + wordSpanWord] = wordCount;
      spanCount++;
    }
    wordCount++;
  }
  const tailLength = spanCount % wordSpanChunkSize * wordSpanStride;
  if (tailLength) spans[spans.length - 1] = spans[spans.length - 1]!.slice(0, tailLength);
  runs.length = 0;
  let lines = 1, characters = text.length;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 13 || unit === 10) {
      lines++;
      if (unit === 13 && text.charCodeAt(i + 1) === 10) i++;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { characters--; i++; }
    }
  }
  return (selections: readonly StatisticsSelection[], line: number | null,
    hasSelection = selections.some(s => s.to > s.from)): DocumentStatistics => {
    let selectedWords = 0, previousWord = -1;
    for (const range of [...selections].filter(s => s.to > s.from).sort((a, b) => a.from - b.from)) {
      let low = 0, high = spanCount;
      while (low < high) { const mid = (low + high) >>> 1; if (spanValue(mid, wordSpanTo) <= range.from) low = mid + 1; else high = mid; }
      const start = low;
      low = start; high = spanCount;
      while (low < high) { const mid = (low + high) >>> 1; if (spanValue(mid, wordSpanFrom) < range.to) low = mid + 1; else high = mid; }
      if (low > start) {
        const first = Math.max(spanValue(start, wordSpanWord), previousWord + 1), last = spanValue(low - 1, wordSpanWord);
        selectedWords += Math.max(0, last - first + 1); previousWord = Math.max(previousWord, last);
      }
    }
    return { words: wordCount, selectedWords, hasSelection, lines, line, characters };
  };
}
