import { createPreviewController } from '../webview/src/helpers/preview';
import { createCodePaletteWebviewAdapter } from '../webview/src/adapters/codePaletteWebviewAdapter';
import { setShikiTheme } from '../webview/src/helpers/shikiHighlighter';
import { createEditor } from '../webview/src/editor';
import {
  initializeMermaidEditorRuntime,
  loadMermaidRuntime,
  normalizeMermaidDiagramText,
  renderMermaidRuntime
} from '../webview/src/helpers/mermaidDiagram';
import { createMermaidDiagramRenderPool } from '../webview/src/editor/mermaidDiagramRenderPool';
import type { MermaidDiagramRenderResources } from '../webview/src/application/mermaidDiagramRenderResources';
import { createMermaidDiagramPresentationApplication } from '../webview/src/application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from '../webview/src/adapters/mermaidDiagramPresentationRuntime';
import { createMermaidDiagramPresentationEffectAdapter } from '../webview/src/editor/mermaidDiagramPresentationAdapter';
import { createMermaidDiagramPresentationFactory } from '../webview/src/editor/mermaidDiagramPresentation';
import { createPreviewMermaidRenderer, readPreviewMermaidWarmupSources } from '../webview/src/helpers/previewMermaid';
import { createPreviewViewport } from '../webview/src/helpers/previewViewport';
import { getViewportController } from '../webview/src/helpers/viewportController';

(window as typeof window & { __loadMermaidRuntime: typeof loadMermaidRuntime }).__loadMermaidRuntime = loadMermaidRuntime;
(window as any).__isMermaidEditorScrolling = (editor: ReturnType<typeof createEditor>) =>
  getViewportController(editor.view)?.isUserScrolling() ?? false;

const mermaidResources = createMermaidDiagramRenderPool({
  initialize: initializeMermaidEditorRuntime,
  render: renderMermaidRuntime
});
(window as any).__probePreviewIdleCache = async () => {
  const runtime = await loadMermaidRuntime(), original = runtime.render;
  const frame = document.createElement('iframe'); frame.style.height = '400px'; document.body.append(frame);
  const doc = frame.contentDocument!; doc.documentElement.dataset.meoPreviewResourceBudget = 'bounded';
  const source = `flowchart LR; A[IdleCache-${Date.now()}]-->B`;
  doc.body.innerHTML = `<div style="height:2000px"></div><div class="meo-export-mermaid" style="height:120px" data-source-b64="${btoa(source)}"></div>`
    + `<div class="meo-export-mermaid" style="height:120px" data-source-b64="${btoa(source + '\nB-->C')}"></div>`;
  let renders = 0, interacting = false;
  runtime.render = (async (id: string) => { renders++; return { svg: `<svg id="${id}" viewBox="0 0 100 30"><rect width="100" height="30"/></svg>` }; }) as typeof runtime.render;
  const renderer = createPreviewMermaidRenderer(mermaidResources, (error: unknown) => { throw error; }, () => interacting, {
    isPointerActive: () => false,
    readWarmupSources: async () => [{ documentIndex: 0, source }]
  });
  let approach: Promise<void> | undefined;
  try {
    await renderer.render(doc, 'dark');
    const idle = { renders, painted: doc.querySelectorAll('.is-rendered svg').length };
    if (renders !== 1) return { idle };
    doc.scrollingElement!.scrollTop = 1300;
    interacting = true;
    let accepted!: () => void;
    const firstCommit = new Promise<void>(resolve => { accepted = resolve; });
    approach = renderer.render(doc, 'dark', undefined, () => true, (mutate: () => void) => { mutate(); accepted(); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([firstCommit, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('A cold neighbour blocked the cached approach')), 1000);
      })]);
    } finally { clearTimeout(deadline); }
    return { idle, approach: { renders, painted: doc.querySelectorAll('.is-rendered svg').length } };
  } finally {
    interacting = false; renderer.dispose(); await approach?.catch(() => {});
    runtime.render = original; frame.remove();
  }
};
(window as any).__probePreviewWindowCache = async () => {
  const frame = document.createElement('iframe'); frame.style.height = '400px'; document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = '<main style="font:16px/24px Arial"></main>';
  const root = doc.querySelector<HTMLElement>('main')!;
  const source = 'flowchart LR; A[WindowCache]-->B', graphIndex = 45;
  const blocks = Array.from({ length: 150 }, (_, index) => ({ index, sourceLine: index + 1, sourceEndLine: index + 1,
    kind: index === graphIndex ? 'fence' : 'paragraph_open', sourceCharacters: 40 }));
  const requests: number[][] = [];
  const viewport = createPreviewViewport(root, { id: 'idle-cache-window', anchorLine: 1, blocks, headings: [], chunks: [] }, {
    async request(_id, operation) {
      if (operation.kind !== 'blocks') throw new Error('Only bounded block reads are expected');
      requests.push([...operation.indices]);
      return { kind: 'blocks', chunks: operation.indices.map(index => ({ index, hasMermaid: index === graphIndex,
        html: index === graphIndex ? `<div class="meo-export-mermaid" data-source-b64="${btoa(source)}"></div>`
          : `<p style="height:32px;margin:0">Paragraph ${index}</p>` })) };
    },
    mutate: run => run(), changed() {}, error(error) { throw error; }, reveal() {}, async writeClipboard() {}
  });
  try {
    for (let index = 0; index < 8; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const before = root.querySelectorAll('[data-meo-preview-block]').length;
    const chunks = await viewport.prepareReadingCache(() => true);
    const sources = readPreviewMermaidWarmupSources(doc, chunks);
    const after = root.querySelectorAll('[data-meo-preview-block]').length;
    return { before, after, source: sources[0]?.source, identity: sources[0]?.documentIndex,
      cacheRequests: requests.filter(indices => indices.includes(graphIndex)), graphMounted: !!root.querySelector('.meo-export-mermaid') };
  } finally { viewport.dispose(); frame.remove(); }
};
(window as any).__probePreviewCachedBatch = async () => {
  const runtime = await loadMermaidRuntime(), originalRender = runtime.render, originalInitialize = runtime.initialize;
  const frame = document.createElement('iframe'); frame.style.height = '400px'; document.body.append(frame);
  const doc = frame.contentDocument!; doc.documentElement.dataset.meoPreviewResourceBudget = 'bounded';
  const sources = Array.from({ length: 6 }, (_, index) => `flowchart LR; A[Cached-${Date.now()}-${index}]-->B`);
  const reset = () => { doc.body.innerHTML = sources.map(source =>
    `<div class="meo-export-mermaid" style="height:40px" data-source-b64="${btoa(source)}"></div>`).join(''); };
  const painted = () => doc.querySelectorAll('.meo-export-mermaid.is-rendered svg').length;
  let initializes = 0, renders = 0, groups = 0, interacting = false, settled = false;
  runtime.initialize = ((...args: Parameters<typeof runtime.initialize>) => { initializes++; return originalInitialize.apply(runtime, args); }) as typeof runtime.initialize;
  runtime.render = (async (id: string) => { renders++; return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 100 30"><rect width="100" height="30"/></svg>`
  }; }) as typeof runtime.render;
  const resources = { ...mermaidResources, acquireGroup() { groups++; return mermaidResources.acquireGroup(); } };
  const renderer = createPreviewMermaidRenderer(resources, error => { throw error; }, () => interacting);
  const releases: Array<() => void> = [], batches: number[] = [];
  let operation: Promise<void> | null = null;
  const frames = async (count = 3) => { for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame); };
  try {
    reset(); await renderer.render(doc, 'dark');
    reset(); initializes = renders = groups = 0; interacting = true;
    operation = renderer.render(doc, 'dark', undefined, () => true, mutate => new Promise<void>(resolve => {
      releases.push(() => { const before = painted(); mutate(); batches.push(painted() - before); resolve(); });
    })).then(() => { settled = true; });
    await frames();
    const held = { waitingCommits: releases.length, painted: painted(), groups };
    interacting = false;
    const deadline = performance.now() + 5_000;
    while (!releases.length && !settled) {
      if (performance.now() > deadline) throw Error('Cached Preview results did not reach their owner');
      await frames();
    }
    const prepared = { initializes, renders, groups, waitingCommits: releases.length, painted: painted(), settled };
    interacting = true;
    releases.shift()?.();
    await frames();
    const resumedGesture = { painted: painted(), waitingCommits: releases.length };
    interacting = false;
    while (!settled) {
      for (const release of releases.splice(0)) release();
      if (performance.now() > deadline) throw Error('Cached Preview results did not settle');
      await frames();
    }
    const accepted = { batches: [...batches], painted: painted() };
    reset(); doc.documentElement.style.setProperty('--meo-mermaid-node-background', '#123456');
    const beforeMiss = groups, beforeRender = renders;
    await renderer.render(doc, 'dark');
    const changedTheme = { painted: painted(), groups: groups - beforeMiss, renders: renders - beforeRender };
    doc.documentElement.style.removeProperty('--meo-mermaid-node-background');
    reset(); settled = false;
    operation = renderer.render(doc, 'dark', undefined, () => true, mutate => new Promise<void>(resolve => {
      releases.push(() => { mutate(); resolve(); });
    })).then(() => { settled = true; });
    await frames(); renderer.dispose();
    for (const release of releases.splice(0)) release();
    await operation;
    return { held, prepared, resumedGesture, accepted, changedTheme, retiredPainted: painted() };
  } finally {
    interacting = false; renderer.dispose(); for (const release of releases) release();
    await operation?.catch(() => {});
    runtime.render = originalRender; runtime.initialize = originalInitialize; frame.remove();
  }
};
(window as any).__probePreviewGestureBatch = async () => {
  const runtime = await loadMermaidRuntime(), original = runtime.render;
  const frame = document.createElement('iframe'); frame.style.height = '400px'; document.body.append(frame);
  const doc = frame.contentDocument!; doc.documentElement.dataset.meoPreviewResourceBudget = 'bounded';
  doc.body.innerHTML = [0, 1].map(index => `<div class="meo-export-mermaid" style="height:100px" data-source-b64="${btoa(`flowchart LR; A[Gesture-${Date.now()}-${index}]-->B`)}"></div>`).join('');
  let interacting = false, started = 0, completed = 0, notices = 0;
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(() => new Promise<void>(resolve => releases.push(resolve)));
  runtime.render = (async (id: string) => {
    const index = started++; await gates[index]; completed++;
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 100 60"><rect width="100" height="60"/></svg>` };
  }) as typeof runtime.render;
  const renderer = createPreviewMermaidRenderer(mermaidResources, error => { throw error; }, () => interacting);
  const operation = renderer.render(doc, 'dark', () => notices++);
  const wait = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5_000;
    while (!predicate()) {
      if (performance.now() > deadline) throw Error('Gesture batch did not reach its boundary');
      await new Promise(requestAnimationFrame);
    }
  };
  const painted = () => doc.querySelectorAll('.meo-export-mermaid.is-rendered svg').length;
  try {
    await wait(() => started === 1);
    interacting = true; releases[0]!(); await wait(() => completed === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    const between = { started, painted: painted() };
    interacting = false; await wait(() => started === 2);
    interacting = true; releases[1]!(); await wait(() => completed === 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    const beforeCommit = { painted: painted(), notices };
    interacting = false; await operation;
    return { between, beforeCommit, after: { painted: painted(), notices } };
  } finally {
    interacting = false; for (const release of releases) release(); renderer.dispose();
    await operation.catch(() => {}); runtime.render = original; frame.remove();
  }
};
(window as any).__probePreviewCommitBatches = async () => {
  const runtime = await loadMermaidRuntime(), original = runtime.render;
  const frame = document.createElement('iframe'); frame.style.height = '400px'; document.body.append(frame);
  const doc = frame.contentDocument!; doc.documentElement.dataset.meoPreviewResourceBudget = 'bounded';
  doc.body.innerHTML = Array.from({ length: 6 }, (_, index) => `<div class="meo-export-mermaid" style="height:40px" data-source-b64="${btoa(`flowchart LR; A[Batch-${Date.now()}-${index}]-->B`)}"></div>`).join('');
  runtime.render = (async (id: string) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 100 30"><rect width="100" height="30"/></svg>` })) as typeof runtime.render;
  const batches: number[] = [];
  const renderer = createPreviewMermaidRenderer(mermaidResources, error => { throw error; });
  const painted = () => doc.querySelectorAll('.meo-export-mermaid.is-rendered svg').length;
  try {
    await renderer.render(doc, 'dark', undefined, () => true, async mutate => {
      // A prepared batch can wait for the reading owner's next admitted frame.
      // render() must retain it and settle only after the accepted DOM commit.
      const before = painted();
      await new Promise(requestAnimationFrame);
      mutate(); batches.push(painted() - before);
    });
    return { batches, painted: painted() };
  } finally { renderer.dispose(); runtime.render = original; frame.remove(); }
};
const mermaidPresentationFactory = createMermaidDiagramPresentationFactory({
  resources: mermaidResources,
  createHandle(view, consumer) {
    const application = createMermaidDiagramPresentationApplication();
    const executor = createMermaidDiagramPresentationEffectAdapter({
      view,
      resources: consumer,
      normalizeSource: normalizeMermaidDiagramText
    });
    const runtime = createMermaidDiagramPresentationRuntime({ application, executor });
    return {
      present(source, themeKey, configKey) {
        runtime.dispatch({ type: 'present', source, themeKey, configKey });
      },
      externalDocumentPresented() {
        runtime.dispatch({ type: 'externalDocumentPresented' });
      },
      whenIdle: () => runtime.whenCurrentPresentationSettles(),
      dispose: () => runtime.dispose()
    };
  }
});

let previewRenderGate: Promise<void> | null = null;
(window as typeof window & { __holdPreviewMermaid?: () => void; __releasePreviewMermaid?: () => void })
  .__holdPreviewMermaid = () => {
    (window as typeof window & { __previewMermaidGateStarted?: boolean }).__previewMermaidGateStarted = false;
    previewRenderGate = new Promise<void>(resolve => {
      (window as typeof window & { __releasePreviewMermaid?: () => void }).__releasePreviewMermaid = () => {
        previewRenderGate = null;
        resolve();
      };
    });
  };
const previewMermaidResources: MermaidDiagramRenderResources = {
  ...mermaidResources,
  acquireGroup() {
    const consumer = mermaidResources.acquireGroup();
    return {
      ...consumer,
      runExclusive<T>(operation: () => Promise<T>, priority?: 'high' | 'normal') {
        const testWindow = window as typeof window & { __previewMermaidRequests?: number };
        testWindow.__previewMermaidRequests = (testWindow.__previewMermaidRequests ?? 0) + 1;
        const gate = previewRenderGate;
        if (!gate) return consumer.runExclusive(operation, priority);
        return consumer.runExclusive(async () => {
          (window as typeof window & { __previewMermaidGateStarted?: boolean }).__previewMermaidGateStarted = true;
          await gate;
          return operation();
        }, priority);
      }
    };
  }
};

const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
  const consumer = mermaidResources.acquireGroup();
  try {
    return await consumer.runExclusive(operation);
  } finally {
    consumer.end();
  }
};

const codePaletteAdapter = createCodePaletteWebviewAdapter({
  setShikiTheme(theme) {
    setShikiTheme(theme, 'preview');
  }
});

const previewMessages: unknown[] = [];
type SharedMermaidEditorOptions = Omit<
  Parameters<typeof createEditor>[0],
  'mermaidDiagramPresentationFactory' | 'onApplyTransaction'
> & { onApplyChanges?: (text: string) => void };
const controller = createPreviewController({
  vscode: { postMessage(message) { previewMessages.push(message); } },
  uiLanguage: 'en',
  getEditorAppearance: () => 'dark',
  isCurrentText: (text: string) => {
    const current = (window as typeof window & { __previewCurrentText?: string }).__previewCurrentText;
    return current === undefined || current === text;
  },
  getCodePalette: (appearance) => codePaletteAdapter.resolve(undefined, appearance).preview,
  applyCodeTheme: (appearance) => {
    setShikiTheme(codePaletteAdapter.resolve(undefined, appearance).sourceTheme, 'preview');
  },
  mermaidRenderResources: previewMermaidResources,
  onRendered: () => {
    (window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt = performance.now();
  }
});
document.body.append(controller.host);
(window as typeof window & { __previewController?: typeof controller }).__previewController = controller;
(window as typeof window & { __previewMessages?: unknown[] }).__previewMessages = previewMessages;
(window as typeof window & {
  __createSharedMermaidEditor?: (options: SharedMermaidEditorOptions) => ReturnType<typeof createEditor>;
}).__createSharedMermaidEditor = (options) => createEditor({
  ...options,
  onApplyTransaction: edit => options.onApplyChanges?.(edit.after.toString()),
  mermaidDiagramPresentationFactory: mermaidPresentationFactory
});
(window as typeof window & { __renderEditorMermaid?: (source: string) => HTMLElement }).__renderEditorMermaid = (source) => {
  const host = document.createElement('div');
  host.className = 'editor-host';
  document.body.appendChild(host);
  (window as typeof window & {
    __createSharedMermaidEditor?: (options: SharedMermaidEditorOptions) => ReturnType<typeof createEditor>;
  }).__createSharedMermaidEditor?.({
    parent: host,
    text: `\`\`\`mermaid\n${source}\n\`\`\``,
    initialMode: 'live',
    onApplyChanges() {}
  });
  return host;
};
(window as typeof window & { __renderLiveMermaid?: () => Promise<string> }).__renderLiveMermaid = () =>
  runExclusive(async () => {
    const mermaid = await loadMermaidRuntime();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: { darkMode: true, primaryColor: '#20252b', primaryTextColor: '#d8dee9' }
    });
    const result = await mermaid.render('meo-live-before-preview', 'flowchart LR\n  Live --> Preview');
    return result.svg;
  });
(window as typeof window & { __probeInvalidMermaidCleanup?: () => Promise<boolean> })
  .__probeInvalidMermaidCleanup = async () => {
    try {
      await renderMermaidRuntime('meo-invalid-cleanup-probe', 'this is invalid mermaid');
    } catch {
      // Invalid syntax is expected; only leaked runtime DOM is under test.
    }
    return Boolean(
      document.getElementById('dmeo-invalid-cleanup-probe')
      || document.body.textContent?.includes('Syntax error in text')
    );
  };
(window as typeof window & { __queueSlowLiveOperations?: (count: number, delayMs: number) => void })
  .__queueSlowLiveOperations = (count, delayMs) => {
    for (let index = 0; index < count; index += 1) {
      void runExclusive(() => new Promise((resolve) => window.setTimeout(resolve, delayMs)));
    }
  };
