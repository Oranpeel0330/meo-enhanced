import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import type { MermaidDiagramRenderRequest } from '../webview/src/application/mermaidDiagramRenderResources';
import { createDocumentReadingPreparation, preloadMermaidDocumentBatch } from '../webview/src/helpers/documentReadingPreparation';

const request = (index: number): MermaidDiagramRenderRequest => ({
  rawSource: `graph TD\nA${index}-->B${index}`,
  normalizedSource: `graph TD\nA${index}-->B${index}`,
  themeKey: 'dark',
  configKey: 'editor-v1',
  priority: 'normal'
});

const requests = Array.from({ length: 40 }, (_, index) => request(index));
const preloaded: string[] = [];
let refreshCount = 0;
await preloadMermaidDocumentBatch(
  {
    async preload(item) {
      preloaded.push(item.rawSource);
    }
  },
  requests,
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(preloaded.length, requests.length);
assert.equal(
  refreshCount,
  1,
  'one Mermaid warm-up batch must never dispatch one whole-editor refresh per diagram'
);

await preloadMermaidDocumentBatch(
  { async preload() {} },
  [],
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(refreshCount, 1, 'an empty warm-up batch must not request a refresh');

let cachedPreloadCount = 0;
await preloadMermaidDocumentBatch(
  {
    getCached: () => ({ ok: true, svg: '<svg/>' }),
    async preload() { cachedPreloadCount += 1; }
  },
  requests.slice(0, 2),
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(cachedPreloadCount, 0, 'cached diagrams should not be warmed again');
assert.equal(refreshCount, 1, 'cached diagrams should not refresh the whole Live document');

await preloadMermaidDocumentBatch(
  {
    getCached: (item) => item.rawSource === requests[0]!.rawSource
      ? { ok: true, svg: '<svg/>' } : null,
    async preload() { cachedPreloadCount += 1; }
  },
  requests.slice(0, 2),
  () => true,
  () => { refreshCount += 1; }
);
assert.equal(cachedPreloadCount, 1, 'only an uncached diagram should be warmed');
assert.equal(refreshCount, 2, 'newly warmed diagrams still refresh mounted presentation');

let active = true;
let stoppedPreloadCount = 0;
await preloadMermaidDocumentBatch(
  {
    async preload() {
      stoppedPreloadCount += 1;
      active = false;
    }
  },
  requests,
  () => active,
  () => { refreshCount += 1; }
);
assert.equal(stoppedPreloadCount, 1);
assert.equal(refreshCount, 2, 'a disposed warm-up batch must not request a stale refresh');

let yielded = false;
let countBeforeInput = 0;
await preloadMermaidDocumentBatch({
  async preload() {
    countBeforeInput += 1;
    if (countBeforeInput === 1) setTimeout(() => { yielded = true; }, 0);
    else assert.ok(yielded, 'Input tasks must run between completed diagram preloads');
  }
}, requests.slice(0, 2), () => true, () => {});

// Engines without cooperative DOM preparation retain the viewport's idle gate.
let scrolling = true, resume!: () => void, paused!: () => void, scrollPreloads = 0;
const waiting = new Promise<void>(resolve => { paused = resolve; });
const duringScroll = preloadMermaidDocumentBatch({ async preload() { scrollPreloads++; } },
  [{ ...request(0), rawSource: 'sequenceDiagram\nA->>B: hello' }], () => true, () => {}, undefined, () => scrolling,
  () => new Promise<void>(resolve => { resume = () => { scrolling = false; resolve(); }; paused(); }));
await waiting;
assert.equal(scrollPreloads, 0, 'an indivisible cold engine must wait for the viewport to release scrolling');
resume();
await duringScroll;
assert.equal(scrollPreloads, 1, 'one viewport notification resumes the pending batch');
await preloadMermaidDocumentBatch({ async preload() { scrollPreloads++; } },
  requests.slice(0, 1), () => true, () => {}, undefined, () => true);
assert.equal(scrollPreloads, 2, 'cooperative graphs can prepare without waiting for wheel quiet');

const source = Array.from({ length: 4 }, (_, index) => `![Near ${index}](near-${index}.png)\n\n`).join('')
  + 'Distant section\n\n![Far](far.png)';
const state = EditorState.create({ doc: source, extensions: [markdown()] });
assert.ok(ensureSyntaxTree(state, state.doc.length, 1_000));
const timers = new Map<number, () => void>(), delays: number[] = [];
let nextTimer = 0;
const savedWindow = (globalThis as any).window;
const savedDocument = (globalThis as any).document, savedComputedStyle = (globalThis as any).getComputedStyle;
(globalThis as any).document = { documentElement: {}, body: {} };
(globalThis as any).getComputedStyle = () => ({ fontFamily: 'monospace', backgroundColor: '#ffffff', getPropertyValue: () => '' });
(globalThis as any).window = {
  setTimeout(callback: () => void, delay: number) { delays.push(delay); timers.set(++nextTimer, callback); return nextTimer; },
  clearTimeout(id: number) { timers.delete(id); }
};
const imageRequests: string[] = [], imageReleases: (() => void)[] = [];
let readingActive = true;
const preparation = createDocumentReadingPreparation({
  getCached: () => null, preload: async () => {}, subscribeThemeRefresh: () => () => {}
}, () => {}, () => true, {
  isActive: () => readingActive, readWindow: () => null,
  readContentWindow: () => ({ from: 0, to: source.indexOf('Distant section'), anchor: 0 }),
  afterUserScroll: () => () => {}
}, {
  source: (current, node) => current.doc.sliceString(node.from, node.to),
  preload: value => { imageRequests.push(value); return new Promise<void>(resolve => imageReleases.push(resolve)); }
});
try {
  preparation.schedule(state);
  const firstTimer = nextTimer;
  for (let index = 0; index < 100; index++) preparation.schedule(state);
  assert.equal(nextTimer, firstTimer, 'geometry notifications coalesce without moving the admission deadline');
  assert.equal(timers.size, 1);
  const fire = () => { const [id, callback] = timers.entries().next().value!; timers.delete(id); callback(); };
  fire();
  assert.equal(imageRequests.length, 2, 'only two image preparations may be pending');
  preparation.schedule(state); fire();
  assert.equal(imageRequests.length, 2, 'scrolling does not duplicate or expand in-flight preparation');
  readingActive = false; preparation.schedule(state); fire();
  readingActive = true; preparation.schedule(state); fire();
  assert.equal(imageRequests.length, 2, 'hidden/reveal does not start new work or duplicate retained requests');
  assert.ok(!imageRequests.some(value => value.includes('far.png')), 'a complete tree does not authorize preparation beyond its reading window');
  preparation.schedule(state.update({ changes: { from: 0, insert: 'Edited\n\n' } }).state);
  assert.ok(delays.at(-1)! >= 190, 'new input retains its quiet window');
  preparation.dispose();
  imageReleases.forEach(release => release());
  for (let index = 0; index < 8; index++) await Promise.resolve();
  assert.equal(timers.size, 0, 'retired async work cannot wake a disposed document');

  const graphState = EditorState.create({ doc: '```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\ngraph TD\nC-->D\n```', extensions: [markdown()] });
  assert.ok(ensureSyntaxTree(graphState, graphState.doc.length, 1_000));
  const readyGraphs = new Set<string>(), graphReleases: (() => void)[] = [];
  let graphCalls = 0, cacheReads = 0;
  const graphs = createDocumentReadingPreparation({
    getCached(request) { cacheReads++; return readyGraphs.has(request.rawSource) ? { ok: true, svg: '<svg/>' } : null; },
    async preload(request) {
      graphCalls++;
      await new Promise<void>(resolve => graphReleases.push(resolve));
      readyGraphs.add(request.rawSource);
    },
    subscribeThemeRefresh: () => () => {}
  }, () => {}, () => false, {
    isActive: () => true, readWindow: () => undefined, readContentWindow: () => null, afterUserScroll: () => () => {}
  });
  const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const microtasks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
  try {
    graphs.schedule(graphState); fire(); await turn();
    assert.equal(graphCalls, 1);
    graphs.schedule(graphState);
    graphReleases.shift()!(); await microtasks();
    fire(); await turn(); await turn();
    assert.equal(graphCalls, 2, 'a retained but interrupted batch must continue to its uncached diagrams');
    graphReleases.shift()!(); await microtasks();
    const readsAfterCompletion = cacheReads;
    graphs.schedule(graphState); fire(); await turn();
    assert.equal(cacheReads, readsAfterCompletion, 'ordinary geometry changes must not rescan a completed whole-document warm-up');
    readyGraphs.clear(); graphs.resourceContextChanged(); fire(); await turn();
    assert.equal(graphCalls, 3, 'external resource invalidation retires the completion receipt');
  } finally { graphs.dispose(); graphReleases.forEach(release => release()); }
} finally {
  preparation.dispose(); (globalThis as any).window = savedWindow;
  (globalThis as any).document = savedDocument; (globalThis as any).getComputedStyle = savedComputedStyle;
}

console.log('Document reading preparation: Mermaid yielding, bounded images, shared deadline, input quiet and retirement passed');
