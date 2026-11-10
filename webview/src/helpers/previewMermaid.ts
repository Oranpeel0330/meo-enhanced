import { syncPreviewRenderedActions } from './previewBlockActions';
import { readingPreparationRange, readingResourceDistance } from '../application/readingWindow';
import type { EditorAppearance } from '../../../src/protocol/editorCommands';
import { getGithubMermaidConfig } from '../../../src/preview/githubMermaid';
import { getMermaidColorVariables, getMermaidPalette } from '../../../src/shared/mermaidPalette';
import { getPreviewMermaidResourceIndex, getPreviewViewportResources, hasBoundedPreviewResources } from './previewViewportResources';

type PreviewAppearance = Exclude<EditorAppearance, 'auto'>;
import {
  MermaidDiagramResourceUnavailableError,
  type MermaidDiagramRenderResources
} from '../application/mermaidDiagramRenderResources';
import {
  loadMermaidRuntime,
  renderMermaidSvgInDocument,
  isDisplayMathDiagram,
  normalizeMermaidDiagramText,
  restoreMermaidEditorTheme
} from './mermaidDiagram';

const PREVIEW_MERMAID_CACHE_LIMIT = 100;
const previewMermaidSvgCache = new Map<string, string>();

function isNearPreviewViewport(block: HTMLElement, frameDocument: Document): boolean {
  if (!hasBoundedPreviewResources(frameDocument)) return true;
  const height = frameDocument.defaultView?.innerHeight ?? 0;
  const bounds = block.getBoundingClientRect();
  const band = readingPreparationRange(0, height);
  return bounds.height > 0 && bounds.bottom >= band.from && bounds.top <= band.to;
}

type PreviewMermaidPalette = ReturnType<typeof getMermaidPalette> & { background: string };
type PreviewMermaidContext = {
  appearance: PreviewAppearance; preset: string; revision: string;
  palette: PreviewMermaidPalette; themeKey: string;
};
type PreparedDiagram = { block: HTMLElement; source: string; svg: string };
type PreviewMermaidCommit = (mutate: () => void) => void | Promise<void>;

function previewMermaidContext(document: Document, appearance: PreviewAppearance): PreviewMermaidContext {
  const palette = readPreviewMermaidPalette(document, appearance);
  return { appearance, preset: document.documentElement.dataset.meoPreviewPreset ?? 'default',
    revision: document.documentElement.dataset.meoPreviewPresetRevision ?? '', palette, themeKey: JSON.stringify(palette) };
}

function pendingMermaidBlocks(document: Document, context: PreviewMermaidContext) {
  const height = document.defaultView?.innerHeight ?? 0;
  return (getPreviewViewportResources(document, 'mermaid')
    ?? Array.from(document.querySelectorAll<HTMLElement>('.meo-export-mermaid[data-source-b64]')))
    .filter(block => !block.classList.contains('is-rendered')
      || block.dataset.meoPreviewMermaidAppearance !== context.appearance
      || (block.dataset.meoPreviewMermaidPreset ?? 'default') !== context.preset
      || (block.dataset.meoPreviewMermaidPresetRevision ?? '') !== context.revision
      || block.dataset.meoPreviewMermaidTheme !== context.themeKey)
    .map((block, index) => ({ block, documentIndex: getPreviewMermaidResourceIndex(document, block) ?? index }))
    .filter(({ block }) => isNearPreviewViewport(block, document))
    .map(entry => ({ ...entry, distance: readingResourceDistance(entry.block.getBoundingClientRect(), 0, height) }))
    .sort((left, right) => left.distance - right.distance);
}

function previewMermaidCacheKey(context: PreviewMermaidContext, index: number, source: string): string {
  const { palette } = context;
  return [context.preset, context.revision, context.appearance, palette.background, palette.nodeBackground,
    palette.secondaryBackground, palette.tertiaryBackground, palette.clusterBackground, palette.foreground,
    palette.border, palette.line, ...palette.chartColors, palette.chartTextColor, `block:${index}`, source].join('\n');
}

async function commitPreviewMermaidResults(document: Document, context: PreviewMermaidContext,
  ready: readonly PreparedDiagram[], errors: readonly HTMLElement[], onRendered: (() => void) | undefined,
  isCurrent: () => boolean, commit: PreviewMermaidCommit): Promise<void> {
  if (!isCurrent() || !ready.length && !errors.length) return;
  await commit(() => {
    if (!isCurrent()) return;
    for (const { block, source, svg } of ready) {
      if (!block.isConnected) continue;
      block.classList.toggle('is-math', isDisplayMathDiagram(source));
      block.classList.add('is-rendered'); block.classList.remove('is-error');
      delete block.dataset.meoPreviewMermaidPending;
      block.dataset.meoPreviewMermaidAppearance = context.appearance;
      block.dataset.meoPreviewMermaidPreset = context.preset;
      block.dataset.meoPreviewMermaidPresetRevision = context.revision;
      block.dataset.meoPreviewMermaidTheme = context.themeKey;
      const copyActions = block.querySelector(':scope > .meo-preview-code-actions');
      const languageLabel = block.querySelector(':scope > .meo-export-code-language-label');
      block.innerHTML = `<div class="meo-export-mermaid-svg">${svg}</div>`;
      if (languageLabel) block.prepend(languageLabel);
      if (copyActions) block.append(copyActions);
    }
    for (const block of errors) { block.classList.add('is-error'); delete block.dataset.meoPreviewMermaidPending; }
    syncPreviewRenderedActions(document); onRendered?.();
  });
}

/** Cached SVGs use no mutable Mermaid engine state. Their existing reading
 * owner still admits every bounded DOM batch and retires stale completions. */
async function renderCachedMermaidBlocks(document: Document, appearance: PreviewAppearance,
  onRendered: (() => void) | undefined, isCurrent: () => boolean, commit: PreviewMermaidCommit, isInteracting: () => boolean
): Promise<boolean> {
  const context = previewMermaidContext(document, appearance);
  const blocks = pendingMermaidBlocks(document, context), ready: PreparedDiagram[] = [];
  for (const { block, documentIndex } of blocks) {
    const source = decodeBase64Utf8(block.dataset.sourceB64 ?? '');
    const key = previewMermaidCacheKey(context, documentIndex, source), svg = previewMermaidSvgCache.get(key);
    // Keep mixed cold/warm work in its original distance order and engine lease.
    if (!svg) return false;
    cachePreviewMermaidSvg(key, svg); ready.push({ block, source, svg });
  }
  const size = hasBoundedPreviewResources(document) ? 2 : Math.max(1, ready.length);
  for (let index = 0; index < ready.length && isCurrent(); index += size) {
    if (!await waitForPreviewGesture(document, isCurrent, isInteracting)) return true;
    await commitPreviewMermaidResults(document, context, ready.slice(index, index + size), [], onRendered, isCurrent, commit);
  }
  return ready.length === blocks.length;
}

export function createPreviewMermaidRenderer(
  resources: MermaidDiagramRenderResources,
  reportError: (error: unknown) => void = () => undefined,
  isInteracting: () => boolean = () => false
) {
  let activeGroup: ReturnType<MermaidDiagramRenderResources['acquireGroup']> | null = null;
  let latestRenderGeneration = 0;
  let renderTail: Promise<void> = Promise.resolve();

  const render = (
    frameDocument: Document,
    appearance: PreviewAppearance,
    onDiagramRendered?: () => void,
    isCurrent: () => boolean = () => true,
    commit: PreviewMermaidCommit = (mutate) => mutate()
  ): Promise<void> => {
    const renderGeneration = latestRenderGeneration + 1;
    latestRenderGeneration = renderGeneration;
    activeGroup?.end();
    const preset = frameDocument.documentElement.dataset.meoPreviewPreset ?? 'default';
    const revision = frameDocument.documentElement.dataset.meoPreviewPresetRevision ?? '';
    // A preserved SVG can outlive a theme change with the same appearance.
    let themeKey: string | undefined;
    const hasPendingBlocks = (getPreviewViewportResources(frameDocument, 'mermaid') ?? Array.from(frameDocument.querySelectorAll<HTMLElement>(
      '.meo-export-mermaid[data-source-b64]'
    ))).some((block) => isNearPreviewViewport(block, frameDocument) && (
      !block.classList.contains('is-rendered')
      || block.dataset.meoPreviewMermaidAppearance !== appearance
      || (block.dataset.meoPreviewMermaidPreset ?? 'default') !== preset
      || (block.dataset.meoPreviewMermaidPresetRevision ?? '') !== revision
      || block.dataset.meoPreviewMermaidTheme !== (themeKey ??= JSON.stringify(readPreviewMermaidPalette(frameDocument, appearance)))
    ));
    if (!hasPendingBlocks) return Promise.resolve();
    const requestIsCurrent = () => renderGeneration === latestRenderGeneration && isCurrent();
    const report = (error: unknown) => { if (!(error instanceof MermaidDiagramResourceUnavailableError)) reportError(error); };
    const scheduled = renderTail.catch(() => undefined).then(async () => {
      if (!await waitForPreviewGesture(frameDocument, requestIsCurrent, isInteracting)) return;
      if (previewMermaidSvgCache.size && await renderCachedMermaidBlocks(
        frameDocument, appearance, onDiagramRendered, requestIsCurrent, commit, isInteracting
      )) return;
      // Admission can change while a reading owner accepts cached batches.
      if (!await waitForPreviewGesture(frameDocument, requestIsCurrent, isInteracting)) return;
      const group = resources.acquireGroup();
      activeGroup = group;
      try {
        await group.runExclusive(async () => {
          if (!requestIsCurrent()) return;
          try {
            await renderMermaidBlocks(
              frameDocument,
              appearance,
              onDiagramRendered,
              requestIsCurrent,
              commit,
              isInteracting
            );
          } finally {
            await restoreMermaidEditorTheme();
          }
        }, 'high');
      } catch (error) {
        report(error);
      } finally {
        group.end();
        if (activeGroup === group) activeGroup = null;
      }
    }).catch(report);
    renderTail = scheduled;
    return scheduled;
  };

  return {
    render,
    dispose() {
      latestRenderGeneration += 1;
      activeGroup?.end();
      activeGroup = null;
    }
  };
}

/** A queued or in-flight batch can outlive the gesture check that scheduled it.
 * Retire obsolete work promptly, and leave the UI thread to native dragging. */
async function waitForPreviewGesture(document: Document, isCurrent: () => boolean, isInteracting: () => boolean): Promise<boolean> {
  while (isCurrent() && hasBoundedPreviewResources(document) && isInteracting())
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  return isCurrent();
}

async function renderMermaidBlocks(
  frameDocument: Document,
  appearance: PreviewAppearance,
  onDiagramRendered: (() => void) | undefined,
  isCurrent: () => boolean,
  commit: PreviewMermaidCommit,
  isInteracting: () => boolean
): Promise<void> {
  if (!isCurrent()) return;
  syncPreviewRenderedActions(frameDocument);
  const context = previewMermaidContext(frameDocument, appearance), { preset, palette } = context;
  const blocks = pendingMermaidBlocks(frameDocument, context);
  if (blocks.length === 0) return;

  const mermaid = await loadMermaidRuntime();
  if (!await waitForPreviewGesture(frameDocument, isCurrent, isInteracting)) return;
  const github = frameDocument.documentElement.dataset.meoPreviewRenderer === 'github-readme' || preset === 'github-readme';
  mermaid.initialize(github ? getGithubMermaidConfig(appearance === 'dark') : {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look: 'classic',
    themeVariables: {
      ...getMermaidColorVariables(palette),
      sequenceNumberColor: appearance === 'dark' ? palette.chartTextColor : '#ffffff',
      ...Object.fromEntries(palette.chartColors.map((color, index) => [`pie${index + 1}`, color])),
      pieOpacity: 1,
      darkMode: appearance === 'dark'
    },
    htmlLabels: true,
    markdownAutoWrap: true,
    flowchart: { htmlLabels: true },
    legacyMathML: true,
    forceLegacyMathML: true
  });

  let renderIndex = 0;
  const prepared: PreparedDiagram[] = [];
  const failed: HTMLElement[] = [];
  const commitPrepared = async () => {
    if (!isCurrent() || prepared.length + failed.length === 0) return;
    // The reading owner may admit this result in a later frame. Keep an
    // immutable batch until acceptance, and settle only after its DOM commit.
    const ready = prepared.splice(0), errors = failed.splice(0);
    await commitPreviewMermaidResults(frameDocument, context, ready, errors, onDiagramRendered, isCurrent, commit);
  };
  for (const { block, documentIndex } of blocks) {
    // Mermaid's promises can resolve in one task. Let input and paint run
    // between diagrams while retaining the exclusive theme lease.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!await waitForPreviewGesture(frameDocument, isCurrent, isInteracting)) return;
    if (!isNearPreviewViewport(block, frameDocument)) continue;
    const source = decodeBase64Utf8(block.dataset.sourceB64 ?? '');
    if (!source) continue;

    const cacheKey = previewMermaidCacheKey(context, documentIndex, source);

    try {
      const cachedSvg = previewMermaidSvgCache.get(cacheKey);
      const normalizedSource = normalizeMermaidDiagramText(source);
      const result = cachedSvg
        ? cachedSvg
        : await renderMermaidSvgInDocument(
            mermaid,
            `meo-preview-mermaid-${Date.now()}-${renderIndex += 1}`,
            normalizedSource,
            frameDocument
          );
      if (!isCurrent()) return;
      const svg = result;
      if (!svg) continue;

      cachePreviewMermaidSvg(cacheKey, svg);
      prepared.push({ block, source, svg });
    } catch {
      failed.push(block);
    }
    if (hasBoundedPreviewResources(frameDocument) && prepared.length + failed.length >= 2) {
      if (!await waitForPreviewGesture(frameDocument, isCurrent, isInteracting)) return;
      await commitPrepared();
    }
  }
  if (await waitForPreviewGesture(frameDocument, isCurrent, isInteracting)) await commitPrepared();
}

function readPreviewMermaidPalette(
  frameDocument: Document,
  appearance: PreviewAppearance
): PreviewMermaidPalette {
  const palette = getMermaidPalette(appearance === 'dark');
  const rootStyles = frameDocument.defaultView?.getComputedStyle(frameDocument.documentElement);
  const readColor = (name: string, fallback: string) => {
    const value = rootStyles?.getPropertyValue(name).trim() || fallback;
    const probe = frameDocument.createElement('span');
    probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none';
    probe.style.color = value;
    frameDocument.body.appendChild(probe);
    const resolved = frameDocument.defaultView?.getComputedStyle(probe).color || fallback;
    probe.remove();
    return normalizeMermaidColor(resolved, fallback);
  };

  return {
    ...palette,
    background: readColor('--meo-mermaid-background', appearance === 'dark' ? '#20252b' : '#ffffff'),
    nodeBackground: readColor('--meo-mermaid-node-background', palette.nodeBackground),
    secondaryBackground: readColor('--meo-mermaid-secondary-background', palette.secondaryBackground),
    tertiaryBackground: readColor('--meo-mermaid-tertiary-background', palette.tertiaryBackground),
    clusterBackground: readColor('--meo-mermaid-cluster-background', palette.clusterBackground),
    foreground: readColor('--meo-mermaid-foreground', palette.foreground),
    border: readColor('--meo-mermaid-border', palette.border),
    line: readColor('--meo-mermaid-line', palette.line),
    chartColors: palette.chartColors.map((color, index) => readColor(`--meo-mermaid-chart-${index + 1}`, color)),
    chartTextColor: readColor('--meo-mermaid-chart-text', palette.chartTextColor)
  };
}

function normalizeMermaidColor(value: string, fallback: string): string {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i.exec(value);
  if (!srgb) return value;
  const channels = srgb.slice(1, 4).map((channel) => Math.round(Number(channel) * 255));
  if (channels.some((channel) => !Number.isFinite(channel))) return fallback;
  const alpha = srgb[4] === undefined ? 1 : Number(srgb[4]);
  return alpha >= 1
    ? `rgb(${channels.join(', ')})`
    : `rgba(${channels.join(', ')}, ${Number.isFinite(alpha) ? alpha : 1})`;
}

function cachePreviewMermaidSvg(cacheKey: string, svg: string): void {
  previewMermaidSvgCache.delete(cacheKey);
  previewMermaidSvgCache.set(cacheKey, svg);
  if (previewMermaidSvgCache.size <= PREVIEW_MERMAID_CACHE_LIMIT) return;
  const oldestKey = previewMermaidSvgCache.keys().next().value;
  if (oldestKey) previewMermaidSvgCache.delete(oldestKey);
}

function decodeBase64Utf8(value: string): string {
  try {
    const binary = window.atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return '';
  }
}
