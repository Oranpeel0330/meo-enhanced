import { ChangeSet, Text } from '@codemirror/state';
import { DocInput } from '@codemirror/language';
import { TreeFragment, type ChangedRange } from '@lezer/common';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { createDocumentStatisticsIndex, type StatisticsBlockCache, type StatisticsResponse } from './adapters/documentStatisticsIndex';
import {
  maximumStatisticsChanges, maximumStatisticsDocumentLength, maximumStatisticsSelections,
  type StatisticsRequest
} from './application/documentStatisticsWork';
import { inlineMarkdownExtensions } from './helpers/inlineMarkdownParser';

const grammar = (markdownLanguage.parser as MarkdownParser).configure(inlineMarkdownExtensions);
let doc: Text | undefined;
let fragments: readonly TreeFragment[] = [];
let cache: StatisticsBlockCache = new WeakMap();
let index: ReturnType<typeof createDocumentStatisticsIndex> = null;

function rebuild() {
  if (!doc) throw new Error('Missing statistics document');
  index = null;
  const tree = grammar.parse(new DocInput(doc), fragments);
  fragments = TreeFragment.addTree(tree, fragments);
  index = createDocumentStatisticsIndex(doc, tree, cache);
}

self.onmessage = ({ data }: MessageEvent<StatisticsRequest>) => {
  try {
    if (data.text !== undefined) {
      if (data.text.length > maximumStatisticsDocumentLength) throw new Error('Statistics source exceeds its budget');
      doc = Text.of(data.text.split('\n'));
      fragments = []; cache = new WeakMap();
      rebuild();
    } else if (data.changes) {
      if (!doc || data.changes.length > maximumStatisticsChanges) throw new Error('Invalid statistics changes');
      const length = data.changes.reduce((total, change) => total + change.insert.length - (change.to - change.from), doc.length);
      if (length > maximumStatisticsDocumentLength) throw new Error('Statistics source exceeds its budget');
      const update = ChangeSet.of(data.changes, doc.length);
      if (!update.empty) {
        const ranges: ChangedRange[] = [];
        update.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
        fragments = TreeFragment.applyChanges(fragments, ranges);
        doc = update.apply(doc);
        rebuild();
      }
    }
    const statistics = data.selections.length <= maximumStatisticsSelections ? index?.(data.selections, data.line, data.hasSelection) ?? null : null;
    self.postMessage({ id: data.id, statistics } satisfies StatisticsResponse);
  } catch {
    index = null; doc = undefined; fragments = []; cache = new WeakMap();
    self.postMessage({ id: data.id, statistics: null, reset: true } satisfies StatisticsResponse);
  }
};
