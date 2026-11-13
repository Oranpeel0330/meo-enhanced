import type { EditorState } from '@codemirror/state';
import { resolvedSyntaxTree } from './markdownSyntax';
import {
  getFencedCodeContent,
  getMermaidEditorPresentationIdentity,
  normalizeMermaidDiagramText
} from './mermaidDiagram';
import type { MermaidDiagramRenderRequest } from '../application/mermaidDiagramRenderResources';
import type { MermaidDiagramPresentationConsumer } from '../editor/mermaidDiagramPresentation';
import { markdownStructureAvailable } from '../editor/markdownStructure';
import { getShikiTokens, requestShikiTokens, resolveShikiLang, subscribeShikiRefresh } from './shikiHighlighter';
import type { SyntaxNodeRef } from '@lezer/common';

type DocumentReadingWindow = { readonly from: number; readonly to: number; readonly anchor: number };
type DocumentReadingSurface = {
  isActive(): boolean;
  /** Undefined retains ordinary document warming; null means not ready/visible. */
  readWindow(): DocumentReadingWindow | null | undefined;
  readContentWindow(): DocumentReadingWindow | null;
  afterUserScroll(operation: () => void): () => void;
};

export type DocumentReadingPreparation = {
  schedule(state: EditorState): void;
  resourceContextChanged(): void;
  dispose(): void;
};

type MermaidSource = {
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly source: string;
};

function codeInfo(state: EditorState, node: any): string | null {
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeInfo') {
      return state.doc.sliceString(child.from, child.to).trim().toLowerCase();
    }
  }
  return null;
}

export function collectDocumentMermaidSources(state: EditorState, window?: DocumentReadingWindow): readonly MermaidSource[] {
  const sources: MermaidSource[] = [];
  const seen = new Set<string>();
  const tree = resolvedSyntaxTree(state, window ? 0 : 50);
  if (window && !markdownStructureAvailable(state, tree)) return sources;
  tree.iterate({
    from: window?.from,
    to: window?.to,
    enter(node: any) {
      if (node.name !== 'FencedCode' || codeInfo(state, node) !== 'mermaid') return;
      // A giant graph still belongs to its visible renderer, rather than
      // copying/rendering an unbounded source during speculative warming.
      if (window && node.to - node.from > 32_768) return false;
      const source = getFencedCodeContent(state, node);
      if (!source.trim() || seen.has(source)) return;
      seen.add(source);
      sources.push({ line: state.doc.lineAt(node.from).number, from: node.from, to: node.to, source });
      return false;
    }
  });
  if (window) sources.sort((a, b) => Math.max(0, window.anchor - a.to, a.from - window.anchor)
    - Math.max(0, window.anchor - b.to, b.from - window.anchor));
  return sources;
}

/**
 * Starts at both document edges so ordinary forward reading and an immediate
 * outline jump to the end both benefit before background work reaches the
 * middle of a long Document.
 */
export function orderMermaidPreloads(
  sources: readonly MermaidSource[]
): readonly MermaidSource[] {
  const ordered: MermaidSource[] = [];
  for (let left = 0, right = sources.length - 1; left <= right; left += 1, right -= 1) {
    ordered.push(sources[right]);
    if (left !== right) ordered.push(sources[left]);
  }
  return ordered;
}

export async function preloadMermaidDocumentBatch(
  consumer: Pick<MermaidDiagramPresentationConsumer, 'preload'>
    & Partial<Pick<MermaidDiagramPresentationConsumer, 'getCached'>>,
  requests: readonly MermaidDiagramRenderRequest[],
  isActive: () => boolean,
  onBatchAvailable: () => void,
  signal?: AbortSignal,
  isUserScrolling: () => boolean = () => false,
  waitForScroll?: () => Promise<void>
): Promise<void> {
  let completed = false;
  for (const request of requests) {
    // A cached or synchronously completed render must not turn the whole
    // document warm-up into one uninterrupted task.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!isActive()) return;
    if (consumer.getCached?.(request)) continue;
    // Background graphs share the Webview thread with native scrolling. Yield
    // between jobs; visible graph requests still use the high-priority path.
    while (isUserScrolling()) {
      if (waitForScroll) await waitForScroll();
      else await new Promise<void>(resolve => setTimeout(resolve, 50));
      if (!isActive() || signal?.aborted) return;
    }
    if (signal?.aborted) return;
    await consumer.preload(request, signal);
    if (!isActive()) return;
    completed = true;
  }
  // Preloaded results are content-addressed and offscreen widgets consume them
  // when mounted. One trailing refresh is sufficient for already-mounted
  // decorations; refreshing after every diagram rebuilds the whole Live tree.
  if (completed) onBatchAvailable();
}

/** One document/window lifetime for cheap async resources and idle-only graphs.
 * The renderers retain their own caches, concurrency and DOM admission. */
export function createDocumentReadingPreparation(
  consumer: Pick<MermaidDiagramPresentationConsumer, 'preload' | 'getCached' | 'subscribeThemeRefresh'>,
  onBatchAvailable: () => void,
  isUserScrolling: () => boolean = () => false,
  reading?: DocumentReadingSurface,
  images?: {
    source(state: EditorState, node: SyntaxNodeRef): string;
    preload(source: string): Promise<void>;
  }
): DocumentReadingPreparation {
  let latestState: EditorState | null = null;
  let timer: number | null = null;
  let generation = 0;
  let disposed = false;
  let inputQuietUntil = 0;
  let pendingBatch: AbortController | null = null;
  let cancelScrollWait: (() => void) | null = null;
  let rescheduleAfterBatch = false;
  const preparedImages = new Set<string>();
  const pendingImages = new Map<string, Promise<void>>();
  let ordinaryWarmDocument: EditorState['doc'] | null = null;

  const prepareContent = (state: EditorState, range: DocumentReadingWindow): void => {
    const tree = resolvedSyntaxTree(state, 0);
    if (!markdownStructureAvailable(state, tree)) return;
    const sources: { from: number; to: number; kind: 'code' | 'image'; source: string; language?: string }[] = [];
    let from = range.from, to = range.to;
    const constrain = (start: number, end: number) => {
      // Unmounted oversized fences can have very different wrapped geometry.
      // Do not spend preparation beyond a block whose cost/height is unknown.
      if (start >= range.anchor) to = Math.min(to, start);
      else if (end <= range.anchor) from = Math.max(from, end);
      else { from = Math.max(from, start); to = Math.min(to, end); }
    };
    tree.iterate({ from: range.from, to: range.to, enter(node) {
      if (node.name === 'FencedCode') {
        if (node.to - node.from > 8_192) { constrain(node.from, node.to); return false; }
        const language = resolveShikiLang(codeInfo(state, node));
        if (language && language !== 'mermaid') {
          const source = getFencedCodeContent(state, node);
          if (source.split('\n', 129).length > 128) constrain(node.from, node.to);
          else sources.push({ kind: 'code', source, language, from: node.from, to: node.to });
        }
        return false;
      }
      if (node.name === 'Image' && images) {
        if (node.to - node.from > 32_768) return false;
        const source = images.source(state, node);
        if (source) sources.push({ kind: 'image', source, from: node.from, to: node.to });
        return false;
      }
    } });
    sources.sort((a, b) => Math.max(0, range.anchor - a.to, a.from - range.anchor)
      - Math.max(0, range.anchor - b.to, b.from - range.anchor));
    const current = () => !disposed && latestState?.doc === state.doc && (reading?.isActive() ?? true);
    let codes = 0;
    for (const item of sources) {
      if (item.from < from || item.to > to) continue;
      if (item.kind === 'code') {
        if (getShikiTokens(item.language!, item.source) || codes >= 2) continue;
        codes++;
        // First-use compilation stays in the existing Worker. A missing Worker
        // keeps the main-thread fallback behind the original gesture boundary.
        requestShikiTokens(item.language!, item.source, 'editor', current, 'background',
          () => isUserScrolling() && !(typeof document !== 'undefined' && document.body.dataset.meoShikiWorkerSrc));
      } else if (images && !preparedImages.has(item.source) && !pendingImages.has(item.source) && pendingImages.size < 2) {
        const operation = images.preload(item.source).catch(() => undefined).finally(() => {
          if (pendingImages.get(item.source) !== operation) return;
          pendingImages.delete(item.source);
          if (!current()) return;
          preparedImages.add(item.source);
          while (preparedImages.size > 32) preparedImages.delete(preparedImages.values().next().value!);
          schedule(state);
        });
        pendingImages.set(item.source, operation);
      }
    }
  };

  const run = (): void => {
    timer = null;
    if (disposed || !latestState || reading?.isActive() === false) return;
    const contentWindow = reading?.readContentWindow();
    if (contentWindow) prepareContent(latestState, contentWindow);
    if (pendingBatch) return;
    if (reading && isUserScrolling()) {
      cancelScrollWait = reading.afterUserScroll(() => { cancelScrollWait = null; run(); });
      return;
    }
    const window = reading?.readWindow();
    if (window === null) return;
    if (!window && ordinaryWarmDocument === latestState.doc) return;
    const runGeneration = generation;
    const batch = pendingBatch = new AbortController();
    const identity = getMermaidEditorPresentationIdentity();
    const sources = collectDocumentMermaidSources(latestState, window);
    const ordinaryDocument = !window && markdownStructureAvailable(latestState) ? latestState.doc : null;
    const ordered = window ? sources.filter(({ source }) => !consumer.getCached({
      rawSource: source, normalizedSource: normalizeMermaidDiagramText(source), ...identity
    })).slice(0, 2) : orderMermaidPreloads(sources);
    const requests = ordered.map(({ source }) => ({
      rawSource: source,
      normalizedSource: normalizeMermaidDiagramText(source),
      themeKey: identity.themeKey,
      configKey: identity.configKey,
      priority: 'normal' as const
    }));
    void preloadMermaidDocumentBatch(
      consumer,
      requests,
      () => !disposed && generation === runGeneration && !rescheduleAfterBatch && (reading?.isActive() ?? true),
      window ? () => {} : onBatchAvailable,
      batch.signal,
      isUserScrolling,
      reading ? () => new Promise<void>(resolve => {
        const finish = () => { cancel(); batch.signal.removeEventListener('abort', finish); resolve(); };
        const cancel = reading.afterUserScroll(finish);
        batch.signal.addEventListener('abort', finish, { once: true });
      }) : undefined
    ).finally(() => {
      if (pendingBatch !== batch) return;
      pendingBatch = null;
      if (ordinaryDocument && !rescheduleAfterBatch && !disposed && generation === runGeneration
        && (reading?.isActive() ?? true)) ordinaryWarmDocument = ordinaryDocument;
      if (rescheduleAfterBatch && !disposed && latestState) {
        rescheduleAfterBatch = false;
        schedule(latestState);
      }
    });
  };

  const schedule = (state: EditorState, replace = false): void => {
    if (disposed) return;
    // Geometry/publication updates do not change this source. Let an admitted
    // render finish into the shared cache, then select the newest window. An
    // abort here can discard its only waiter just before a visible leaf joins.
    const retained = !replace && pendingBatch && latestState?.doc === state.doc && reading?.isActive();
    if (retained) {
      rescheduleAfterBatch = true;
    } else {
      pendingBatch?.abort();
      pendingBatch = null;
      rescheduleAfterBatch = false;
      generation += 1;
    }
    cancelScrollWait?.();
    cancelScrollWait = null;
    const documentChanged = latestState !== null && latestState.doc !== state.doc;
    if (documentChanged) inputQuietUntil = performance.now() + 200;
    if (documentChanged || replace || reading?.isActive() === false) {
      preparedImages.clear();
      ordinaryWarmDocument = null;
    }
    if (documentChanged || replace) pendingImages.clear();
    latestState = state;
    if (timer !== null && !replace && !documentChanged) return;
    if (timer !== null) window.clearTimeout(timer);
    // Split edits submit visible work after 80ms. Warming an unrelated diagram
    // sooner can monopolize the serial renderer before that request exists.
    // Keep opening warm-up fast, but wait for an input pause after edits.
    timer = window.setTimeout(run, Math.max(40, inputQuietUntil - performance.now()));
  };

  const unsubscribeThemeRefresh = consumer.subscribeThemeRefresh(() => {
    if (latestState) schedule(latestState, true);
  });
  const unsubscribeTokens = subscribeShikiRefresh(() => { if (latestState) schedule(latestState); });

  return {
    schedule,
    resourceContextChanged() { if (latestState) schedule(latestState, true); },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelScrollWait?.();
      cancelScrollWait = null;
      pendingBatch?.abort();
      pendingBatch = null;
      generation += 1;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      latestState = null;
      preparedImages.clear(); pendingImages.clear();
      unsubscribeThemeRefresh();
      unsubscribeTokens();
    }
  };
}
