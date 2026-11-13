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

type MermaidPreloadWindow = { readonly from: number; readonly to: number; readonly anchor: number };
type MermaidPreloadReading = {
  isActive(): boolean;
  /** Undefined retains ordinary document warming; null means not ready/visible. */
  readWindow(): MermaidPreloadWindow | null | undefined;
  afterUserScroll(operation: () => void): () => void;
};

export type MermaidDocumentPreloader = {
  schedule(state: EditorState): void;
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

export function collectDocumentMermaidSources(state: EditorState, window?: MermaidPreloadWindow): readonly MermaidSource[] {
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

/** Owns bounded, deduplicated Mermaid warming for one Live Editor. */
export function createMermaidDocumentPreloader(
  consumer: MermaidDiagramPresentationConsumer,
  onBatchAvailable: () => void,
  isUserScrolling: () => boolean = () => false,
  reading?: MermaidPreloadReading
): MermaidDocumentPreloader {
  let latestState: EditorState | null = null;
  let timer: number | null = null;
  let generation = 0;
  let disposed = false;
  let inputQuietUntil = 0;
  let pendingBatch: AbortController | null = null;
  let cancelScrollWait: (() => void) | null = null;
  let rescheduleAfterBatch = false;

  const run = (): void => {
    timer = null;
    if (disposed || !latestState) return;
    if (reading && isUserScrolling()) {
      cancelScrollWait = reading.afterUserScroll(() => { cancelScrollWait = null; run(); });
      return;
    }
    const window = reading?.readWindow();
    if (window === null) return;
    const runGeneration = generation;
    const batch = pendingBatch = new AbortController();
    const identity = getMermaidEditorPresentationIdentity();
    const sources = collectDocumentMermaidSources(latestState, window);
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
    if (!replace && pendingBatch && latestState?.doc === state.doc && reading?.isActive()) {
      latestState = state;
      rescheduleAfterBatch = true;
      return;
    }
    cancelScrollWait?.();
    cancelScrollWait = null;
    pendingBatch?.abort();
    pendingBatch = null;
    rescheduleAfterBatch = false;
    const documentChanged = latestState !== null && latestState.doc !== state.doc;
    if (documentChanged) inputQuietUntil = performance.now() + 200;
    latestState = state;
    generation += 1;
    if (timer !== null) window.clearTimeout(timer);
    // Split edits submit visible work after 80ms. Warming an unrelated diagram
    // sooner can monopolize the serial renderer before that request exists.
    // Keep opening warm-up fast, but wait for an input pause after edits.
    timer = window.setTimeout(run, Math.max(40, inputQuietUntil - performance.now()));
  };

  const unsubscribeThemeRefresh = consumer.subscribeThemeRefresh(() => {
    if (latestState) schedule(latestState, true);
  });

  return {
    schedule,
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
      unsubscribeThemeRefresh();
    }
  };
}
