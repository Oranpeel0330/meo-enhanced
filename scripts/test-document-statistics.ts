import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createDocumentStatisticsIndex as createIndex, type StatisticsBlockCache } from '../webview/src/adapters/documentStatisticsIndex';
import { createDocumentStatisticsReporter } from '../webview/src/adapters/documentStatistics';
import { maximumStatisticsBlockLength, maximumStatisticsDocumentLength } from '../webview/src/application/documentStatisticsWork';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { DocInput } from '@codemirror/language';
import { ChangeSet, Text } from '@codemirror/state';
import { TreeFragment, type ChangedRange } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import { inlineMarkdownExtensions } from '../webview/src/helpers/inlineMarkdownParser';
import { decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { DocumentTextSnapshot } from '../src/foundation/documentSnapshot';
import { statisticsCases } from './document-statistics-cases';

const grammar = (markdownLanguage.parser as MarkdownParser).configure(inlineMarkdownExtensions);
const createDocumentStatisticsIndex = (text: string) => {
  const doc = Text.of(text.split('\n'));
  const index = createIndex(doc, grammar.parse(new DocInput(doc)));
  assert.ok(index, 'statistics fixture must fit the automatic budget');
  return index;
};
const stats = (text: string) => createDocumentStatisticsIndex(text)([], 1);
for (const c of statisticsCases) assert.equal(stats(c.source).words, c.words, c.name);
assert.equal(stats('[链接][id]\n\n[id]: https://example.test').words, 2, 'reference label and definition are hidden');
let combinations = 0;
for (const left of statisticsCases) for (const right of statisticsCases) {
  const source = `| A | B |\n| --- | --- |\n| ${left.source} | ${right.source} |`;
  const body = source.indexOf('\n', source.indexOf('\n') + 1) + 1;
  const index = createDocumentStatisticsIndex(source);
  assert.equal(index([], 1).words, 2 + left.words + right.words, `${left.name} + ${right.name}: total`);
  assert.equal(index([{ from: body, to: source.length }], 3).selectedWords, left.words + right.words, `${left.name} + ${right.name}: selected`);
  combinations++;
}
const formatted = createDocumentStatisticsIndex('he**ll**o');
assert.equal(formatted([{from:2,to:4}],1).selectedWords,0,'formatting alone is not a word');
assert.equal(formatted([{from:0,to:2},{from:4,to:6},{from:8,to:9}],1).selectedWords,1,'one word across formatting, multiple selections');
const entityWord = createDocumentStatisticsIndex('caf&#233;');
assert.equal(entityWord([{from:3,to:9}],1).selectedWords,1,'entity source maps to its visible word');
const wiki = '[[target\\|别名]]';
assert.equal(createDocumentStatisticsIndex(wiki)([{from:2,to:8}],1).selectedWords,0,'hidden wiki target is excluded');
assert.equal(createDocumentStatisticsIndex('')([{from:0,to:0}],1,true).hasSelection,true,'empty rectangular cells remain a selection');
assert.equal(stats('').words, 0);
assert.equal(stats('Hello世界 café don’t 123 😀').words, 6);
assert.equal(stats('# **你好** [world](https://example.test "hidden title")').words, 3);
assert.equal(stats('---\ntitle: hidden\n---\n正文').words, 2);
assert.equal(stats('```typescript\nconst value = 1\n```').words, 3);
assert.equal(stats('| A | B |\n| --- | --- |\n| 中文 | world |').words, 5);
assert.equal(stats('<div class="hidden">Hello 世界</div>\n<!-- hidden -->').words, 3);
assert.equal(stats('a\r\nb\nc\r').lines, 4);
assert.equal(stats('𠀀😀').characters, 2);
const text = '**Hello** [world](https://example.test) 中文';
const index = createDocumentStatisticsIndex(text);
assert.equal(index([{ from: 3, to: 5 }, { from: 4, to: 6 }], 1).selectedWords, 1, 'overlapping selections count a word once');
assert.equal(index([{ from: text.indexOf('https'), to: text.indexOf(')') }], 1).selectedWords, 0, 'selected link destination stays excluded');
assert.equal(index([{ from: 0, to: text.length }], 1).selectedWords, 4);
assert.equal(index([], null).line, null);
assert.equal(decodeWebviewToHostMessage({ type: 'documentStatistics', statistics: stats(text) })?.type, 'documentStatistics');
assert.equal(decodeWebviewToHostMessage({ type: 'documentStatistics', statistics: { ...stats(text), line: 999 } }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'documentStatistics', statistics: { ...stats(text), selectedWords: Infinity } }), null);
const limited = { lines: 862_457, line: 1322, wordCountStatus: 'limited' } as const;
assert.deepEqual(decodeWebviewToHostMessage({ type: 'documentStatistics', statistics: limited }),
  { type: 'documentStatistics', statistics: limited });
assert.equal(decodeWebviewToHostMessage({ type: 'documentStatistics', statistics: { ...limited, line: 862_458 } }), null);

const items: any[] = [];
mock.module('vscode', () => ({ MarkdownString: class { constructor(readonly value: string) {} },
  StatusBarAlignment: { Right: 2 }, workspace: { onDidChangeConfiguration() { return { dispose() {} }; } }, window: { createStatusBarItem() {
  const item = { visible: false, disposed: false, text: '', tooltip: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; this.visible = false; } };
  items.push(item); return item;
} } }));
const { createVscodeDocumentStatistics } = await import('../src/host/vscodeDocumentStatistics');
const panel = () => ({ active: true, listener: () => {}, onDidChangeViewState(listener: () => void) { this.listener = listener; return { dispose() {} }; } });
const a = panel(), b = panel(); b.active = false;
const first = createVscodeDocumentStatistics(a as never, () => 'zh-CN');
const second = createVscodeDocumentStatistics(b as never, () => 'en');
first.update(index([], 1)); second.update(stats('Another document'));
assert.equal(items[0].visible, true); assert.equal(items[1].visible, false);
assert.equal(items[0].text, '1/1行，0/4字');
first.update(index([{ from: 3, to: 5 }], 1));
assert.equal(items[0].text, '1/1行，1/4字');
assert.match(items[0].tooltip.value, /^当前第 1 行，共 1 行  \n当前选中 1 字，共 4 字\n\*\*\*\n行数按源码换行计算。/);
a.active = false; b.active = true; a.listener(); b.listener();
assert.equal(items[0].visible, false); assert.equal(items[1].visible, true);
assert.equal(items[1].text, '1/1 line, 0/2 words');
assert.match(items[1].tooltip.value, /^Current line 1, 1 line total  \n0 words selected, 2 words total\n\*\*\*\nLines follow source line breaks\./);
second.update(index([{ from: 3, to: 5 }], 1));
assert.match(items[1].tooltip.value, /\n1 word selected, 4 words total\n/);
second.update(index([], null));
assert.equal(items[1].text, '—/1 line, —/4 words');
assert.match(items[1].tooltip.value, /^Preview mode, 1 line total  \nSelection count unavailable, 4 words total/);
second.update(limited);
assert.equal(items[1].text, '1,322/862,457 lines, —/— words');
assert.match(items[1].tooltip.value, /^Current line 1,322, 862,457 lines total  \nWord count unavailable/);
a.active = true; a.listener(); first.update(limited);
assert.equal(items[0].text, '1,322/862,457行，—/—字');
second.update(null); assert.equal(items[1].visible, false);
first.dispose(); second.dispose(); assert.ok(items.every(i => i.disposed));
const large = createDocumentStatisticsIndex('Hello 世界\n'.repeat(20_000));
assert.equal(large([], 1).words, 60_000);
assert.equal(large([{ from: 0, to: 5 }], 1).selectedWords, 1);
const prefix = '字'.repeat(16_383) + '\r\n';
const mixed = `${prefix}he**ll**o𠀀\r\n`;
const mixedIndex = createDocumentStatisticsIndex(mixed);
const wordStart = prefix.length;
assert.deepEqual(mixedIndex([
  { from: wordStart, to: wordStart + 2 },
  { from: wordStart + 4, to: wordStart + 6 },
  { from: wordStart + 9, to: wordStart + 11 }
], 2), {
  words: 16_385, selectedWords: 2, hasSelection: true, lines: 3, line: 2, characters: mixed.length - 1
}, 'formatted words are deduplicated and supplementary characters counted');

// A known formatting boundary and multiple selections across it must keep
// exact totals even as the underlying Markdown tree is reused after an edit.
const blockSource = 'he**ll**o 世界\n\n'.repeat(1024);
const original = Text.of(blockSource.split('\n'));
const originalTree = grammar.parse(new DocInput(original));
let cacheWrites = 0;
const cache: StatisticsBlockCache = new WeakMap();
const remember = cache.set.bind(cache);
cache.set = (key, summary) => { cacheWrites++; return remember(key, summary); };
assert.equal(createIndex(original, originalTree, cache)?.([], 1).words, 3072);
assert.ok(cacheWrites > 1000, 'the grouped fixture must initially populate its block summaries');
const at = original.line(1025).to;
const update = ChangeSet.of({ from: at, insert: ' Added' }, original.length);
const edited = update.apply(original);
const changes: ChangedRange[] = [];
update.iterChangedRanges((fromA, toA, fromB, toB) => changes.push({ fromA, toA, fromB, toB }));
const fragments = TreeFragment.applyChanges(TreeFragment.addTree(originalTree), changes);
const editedTree = grammar.parse(new DocInput(edited), fragments);
cacheWrites = 0;
const updated = createIndex(edited, editedTree, cache);
assert.ok(updated);
assert.ok(cacheWrites > 0 && cacheWrites < 16, 'a local edit must reuse the distant paragraph summaries');
assert.equal(updated([], 513).words, 3073);
const multiSelection = [{ from: 2, to: at + 2 }, { from: at - 1, to: at + 6 }];
assert.deepEqual(updated(multiSelection, 513), createDocumentStatisticsIndex(edited.toString())(multiSelection, 513));
assert.equal(updated([{ from: 0, to: edited.length }], 1).selectedWords, 3073);
const comment = ChangeSet.of([
  { from: original.line(1025).from, insert: '<!--\n' },
  { from: original.line(1027).to, insert: '\n-->' }
], original.length);
const commented = comment.apply(original);
const commentChanges: ChangedRange[] = [];
comment.iterChangedRanges((fromA, toA, fromB, toB) => commentChanges.push({ fromA, toA, fromB, toB }));
const commentTree = grammar.parse(new DocInput(commented), TreeFragment.applyChanges(TreeFragment.addTree(originalTree), commentChanges));
assert.equal(createIndex(commented, commentTree, cache)?.([], 1).words, 3066,
  'a structural edit invalidates the earlier summaries inside the comment');
const singleBlock = Text.of(['x'.repeat(maximumStatisticsBlockLength + 1)]);
assert.equal(createIndex(singleBlock, grammar.parse(new DocInput(singleBlock))), null, 'a giant block must yield');

let sourceCopies = 0, workerLoads = 0;
const oversized = {
  length: maximumStatisticsDocumentLength + 1,
  toString() { sourceCopies++; throw new Error('Oversized statistics must not flatten the document'); }
} as DocumentTextSnapshot;
let oversizedReads = 0;
let oversizedReporter!: ReturnType<typeof createDocumentStatisticsReporter>;
const priorFetch = globalThis.fetch;
const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', { configurable: true,
  value: { body: { dataset: { meoStatisticsWorkerSrc: 'about:blank' } } } });
globalThis.fetch = Object.assign(async () => {
  workerLoads++;
  throw new Error('Oversized statistics must not fetch the worker');
}, { preconnect: priorFetch.preconnect });
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Oversized statistics did not publish its line position')), 2000);
    oversizedReporter = createDocumentStatisticsReporter(() => {
      oversizedReads++;
      return { text: oversized, lines: limited.lines, line: limited.line, selections: [] };
    }, message => {
      clearTimeout(timeout);
      try { assert.deepEqual(message.statistics, limited); resolve(); }
      catch (error) { reject(error); }
    });
    oversizedReporter.schedule();
  });
} finally {
  oversizedReporter.dispose();
  globalThis.fetch = priorFetch;
  if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
  else Reflect.deleteProperty(globalThis, 'document');
}
assert.equal(oversizedReads, 1);
assert.equal(sourceCopies, 0);
assert.equal(workerLoads, 0);
const originalIndexOf = String.prototype.indexOf;
for (const header of ['StatisticsScan', 'StatisticsScan | text']) {
  const paragraph = header + '\n' + 'Hello 世界\n'.repeat(20_000);
  let newlineSearchCharacters = 0;
  try {
    String.prototype.indexOf = function(this: string, search: string, position?: number) {
      if (search === '\n' && this.startsWith('StatisticsScan')) newlineSearchCharacters += this.length;
      return originalIndexOf.call(this, search, position);
    };
    const statistics = createDocumentStatisticsIndex(paragraph)([], 1);
    assert.equal(statistics.words, header.includes('|') ? 60_002 : 60_001);
    assert.ok(newlineSearchCharacters <= paragraph.length * 8,
      `Long prose must not rescan a growing paragraph for a table header: ${newlineSearchCharacters} characters`);
  } finally { String.prototype.indexOf = originalIndexOf; }
}
const reporter = createDocumentStatisticsReporter(() => null, () => { throw new Error('Disposed statistics must not publish'); });
reporter.dispose();
const originalSetTimeout = globalThis.setTimeout;
let scheduledAfterDispose = 0;
try {
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduledAfterDispose++;
    return Reflect.apply(originalSetTimeout, globalThis, args);
  }) as typeof setTimeout;
  reporter.schedule();
  assert.equal(scheduledAfterDispose, 0, 'Presentation teardown must not requeue a disposed statistics reporter');
} finally { globalThis.setTimeout = originalSetTimeout; reporter.dispose(); }
console.log(`Document statistics: ${statisticsCases.length} cases, ${combinations} paired combinations, source selections, protocol, lifecycle and large document passed`);
