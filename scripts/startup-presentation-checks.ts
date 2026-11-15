import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Browser } from 'puppeteer-core';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { getWebviewPreloadShellCss, getWebviewPreloadShellMarkup } from '../src/shared/webviewPreloadShell';
import { webviewPreloadModules } from '../src/extension/webviewResourceHints';
import { assessLargeDocument } from '../src/application/largeDocumentPolicy';
import { createLargeDocumentFixtures } from './large-document-fixtures';
import { installModeLoadingReadiness } from './mode-loading-readiness';

/** Exercise the actual HTML shell, emitted modules and final-width outline together. */
export async function checkStartupPresentation(browser: Browser): Promise<void> {
  const dist = path.resolve('webview/dist');
  const directory = '.local/test-artifacts/startup-presentation';
  fs.mkdirSync(directory, { recursive: true });
  const large = createLargeDocumentFixtures().find(fixture => fixture.kind === 'lines-heavy')!.text;
  assert.equal(assessLargeDocument(large).preferSource, true, 'The large case must cross the production opening policy');
  let shellGate: Promise<void> = Promise.resolve();
  let editorGate: Promise<void> = Promise.resolve();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const relative = decodeURIComponent(new URL(request.url).pathname).slice(1);
    if (!relative) return new Response(`<!doctype html><style>${getWebviewPreloadShellCss()}</style>`
      + (new URL(request.url).searchParams.get('appearance') === 'light'
        ? `<style>:root{--vscode-editor-background:${new URL(request.url).searchParams.has('alpha') ? 'rgba(241,243,245,.5)' : '#f1f3f5'};--vscode-editor-foreground:#24292f;--vscode-focusBorder:#0069cc}</style>`
        : `<style>:root{--vscode-editor-background:${new URL(request.url).searchParams.has('alpha') ? 'rgba(32,38,46,.5)' : '#20262e'};--vscode-editor-foreground:#e5e5e5;--vscode-focusBorder:#55aaff}</style>`)
      + '<link rel="stylesheet" href="/index.css"><link rel="stylesheet" href="/katex/katex-embedded.css">'
      + webviewPreloadModules(false).map(module => `<link rel="modulepreload" href="/${module}">`).join('')
      + `<body class="vscode-${new URL(request.url).searchParams.get('appearance')}" data-meo-statistics-worker-src="/document-statistics-worker.js" data-meo-katex-src="/katex/katex-embedded.css" `
      + 'data-meo-shiki-worker-src="/shiki-highlight-worker.js" data-meo-markdown-worker-src="/markdown-parse-worker.js">'
      + `<div id="app">${getWebviewPreloadShellMarkup()}</div><script type="module" src="/index.js"></script>`,
    { headers: { 'Content-Type': 'text/html' } });
    if (relative === 'index.js') await shellGate;
    if (relative === 'editor.js') await editorGate;
    const file = path.resolve(dist, relative);
    return file.startsWith(dist + path.sep) && fs.existsSync(file) ? new Response(Bun.file(file)) : new Response('', { status: 404 });
  } });
  const reports: unknown[] = [];
  try {
    for (const alpha of [true, false]) for (const size of ['small', 'large'] as const) for (const mode of ['live', 'source', 'preview'] as const) {
      const context = await browser.createBrowserContext();
      const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
      let releaseShell!: () => void, releaseEditor!: () => void, releasePreview!: () => void;
      shellGate = new Promise(resolve => { releaseShell = resolve; });
      editorGate = new Promise(resolve => { releaseEditor = resolve; });
      const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
      const appearance = size === 'small' ? 'dark' : 'light';
      const language = size === 'small' ? 'zh-CN' : 'en';
      const name = `${size}-${mode}${alpha ? '-alpha' : ''}`;
      const text = size === 'small'
        ? '# Startup content\n\n' + Array.from({ length: 12 }, (_, i) => `Plain text line ${i + 1}.`).join('\n')
        : '# Startup content\n\n' + large;
      let hostText = text, version = 1;
      let acceptInput!: () => void;
      const firstInput = new Promise<void>(resolve => { acceptInput = resolve; });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.setViewport({ width: 1100, height: 720 });
        await page.setCacheEnabled(false);
        await page.exposeFunction('__startupPresentationHost', async (message: any) => {
          if (message.type === 'ready') return {
            type: 'init', pageId: message.pageId, documentId: 'file:///startup-presentation.md', text, version: 1,
            savedRevision: { version: 1, text }, diagnostics: [], mode, uiLanguage: language,
            sourceLineNumbers: 'on', editorAppearance: appearance, editorFontSizeMode: 'auto', editorFontSize: 14,
            uiColors: { light: { documentBackground: '#F5EDDF', text: '#172431', accent: '#7C3AED' },
              dark: { documentBackground: '#18232F', text: '#F1E4D3', accent: '#B66A20' } },
            previewAppearance: appearance, previewFontFamily: '', previewSourceColoring: false,
            gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
            diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
            contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
            outlineVisible: true, outlinePosition: 'right', outlineWidth: 280,
            restoreReadingPositionOnOpen: false, largeDocumentOptimizationEnabled: true, vscodeTheme: null
          };
          if (message.type === 'applyChanges') {
            assert.equal(message.baseVersion, version);
            for (const change of [...message.changes].sort((a, b) => b.from - a.from)) {
              hostText = hostText.slice(0, change.from) + change.insert + hostText.slice(change.to);
            }
            acceptInput();
            return { type: 'applied', version: ++version };
          }
          if (message.type === 'requestPreviewDocument') return { type: 'previewDocumentResult', requestId: message.requestId,
            documentId: message.documentId, result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
          if (message.type !== 'requestPreviewRender') return null;
          await previewGate;
          const options: Parameters<typeof exportRuntime.renderPreviewDocument>[0] = { markdownText: message.text, sourceDocumentPath: 'C:/fixtures/startup-presentation.md',
            uiLanguage: language, styleEnvironment: message.environment };
          const document = message.window ? createPreviewDocument(message.requestId, options) : null;
          if (document) documents.set(message.requestId, document);
          return { type: 'previewRenderResult', requestId: message.requestId,
            result: { ok: true, value: document ? document.open(message.window.anchorLine) : exportRuntime.renderPreviewDocument(options) } };
        });
        await page.evaluateOnNewDocument(installModeLoadingReadiness);
        await page.evaluateOnNewDocument(() => {
          const scope = window as any;
          scope.__startupPresentation = { frames: [], paletteReads: 0 };
          const read = CanvasRenderingContext2D.prototype.getImageData;
          CanvasRenderingContext2D.prototype.getImageData = function(...args: Parameters<typeof read>) {
            scope.__startupPresentation.paletteReads++;
            return Reflect.apply(read, this, args);
          };
          scope.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: any) {
            if (message.type === 'ready') scope.__startupPresentation.beforeInitReads = scope.__startupPresentation.paletteReads;
            scope.__startupPresentationHost(message).then((response: any) => {
              if (!response) return;
              if (response.type === 'init') scope.__startupPresentation.mode = response.mode;
              window.dispatchEvent(new MessageEvent('message', { data: response }));
            });
          } });
        });
        const navigation = page.goto(`${server.url.href}?appearance=${appearance}${alpha ? '&alpha' : ''}`, { waitUntil: 'domcontentloaded' });
        void navigation.catch(() => {});
        await page.waitForSelector('.meo-startup-loading');
        await page.evaluate(() => {
          const scope = window as any, probe = scope.__startupPresentation;
          probe.cover = document.querySelector('.meo-startup-loading');
          probe.spinner = probe.cover.querySelector('.surface-loading-spinner');
          probe.animation = probe.spinner.getAnimations()[0];
          probe.readColors = () => {
            const cover = getComputedStyle(probe.cover), spinner = getComputedStyle(probe.spinner);
            return JSON.stringify([cover.backgroundColor, cover.backgroundImage, cover.color, spinner.borderTopColor, spinner.borderRightColor]);
          };
          probe.initialColors = probe.readColors();
          const observe = () => {
            const cover = document.querySelector<HTMLElement>('.meo-startup-loading');
            const rect = cover?.getBoundingClientRect();
            const covers = (x: number) => !!cover?.contains(document.elementFromPoint(x, innerHeight / 2));
            const ready = probe.mode && scope.__modeLoadingReadiness(probe.mode, 'Startup content').interactive;
            probe.frames.push({ at: performance.now(), cover: !!cover, same: cover === probe.cover,
              x: rect?.x, y: rect?.y, width: rect?.width, height: rect?.height,
              colors: cover ? probe.readColors() : null,
              coversEditor: covers(innerWidth / 4), coversOutline: covers(innerWidth - 12), ready: !!ready });
            if (ready) probe.done = true;
            else requestAnimationFrame(observe);
          };
          requestAnimationFrame(observe);
        });
        const initialPixel = await sharp(await page.screenshot()).extract({ left: 8, top: 360, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        releaseShell();
        await page.waitForFunction(mode => document.getElementById('app')?.dataset.mode === mode
          && document.querySelector('.mode-toolbar')?.classList.contains('meo-preload-toolbar') === false, {}, mode);
        if (mode === 'preview') {
          // Rendering remains pending beyond the old initial-paint fallback.
          releaseEditor();
          await page.waitForSelector('.editor-host > .cm-editor');
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 700)));
        }
        const pendingImage = await page.screenshot({ path: `${directory}/${name}-pending.png` });
        const pendingPixel = await sharp(pendingImage).extract({ left: 8, top: 360, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        assert.deepEqual([...pendingPixel], [...initialPixel], `${name}: an opaque startup presentation must not expose document palette changes`);
        const pending = await page.evaluate(() => {
          const scope = window as any, probe = scope.__startupPresentation;
          const cover = document.querySelector('.meo-startup-loading');
          return { same: cover === probe.cover, spinner: cover?.querySelector('.surface-loading-spinner') === probe.spinner,
            animation: probe.animation === probe.spinner.getAnimations()[0],
            frames: probe.frames, initialColors: probe.initialColors, beforeInitReads: probe.beforeInitReads };
        });
        assert.equal(pending.same && pending.spinner && pending.animation, true, `${size}/${mode}: retain the original loading element and animation through module and document preparation`);
        assert.equal(pending.beforeInitReads, 0, 'Do not derive a default color palette before the actual Host settings arrive');
        assert.ok(pending.frames.every((frame: any) => frame.colors === pending.initialColors),
          `${size}/${mode}: startup background, label and spinner must retain their first-frame colors while document settings initialize: ${JSON.stringify(pending.frames)}`);
        assert.ok(pending.frames.length > 0 && pending.frames.every((frame: any) => frame.cover && frame.same
          && frame.coversEditor && frame.coversOutline && frame.width === 1100),
        `${size}/${mode}: one stationary cover must conceal the unfinished document and outline: ${JSON.stringify(pending.frames)}`);
        releaseEditor(); releasePreview();
        await navigation;
        await page.waitForFunction(() => (window as any).__startupPresentation.done, { timeout: 15000 });
        const report = await page.evaluate(() => {
          const { frames, paletteReads, beforeInitReads, initialColors } = (window as any).__startupPresentation;
          return { frames, paletteReads, beforeInitReads, initialColors,
            documentBackground: getComputedStyle(document.querySelector('.editor-host')!).backgroundColor };
        });
        assert.ok(report.frames.every((frame: any) => frame.cover || frame.ready), 'The first uncovered frame must already be interactive');
        assert.ok(report.frames.every((frame: any) => !frame.cover || frame.colors === report.initialColors),
          'Document and Preview palette preparation must never recolor the startup feedback');
        assert.equal(report.documentBackground, appearance === 'dark' ? 'rgb(24, 35, 47)' : 'rgb(245, 237, 223)',
          'The accepted document must use the actual custom background after the stable startup cover retires');
        assert.equal(await page.$eval('.outline-sidebar', e => e.getBoundingClientRect().width), 280,
          'The accepted outline must already occupy its final width');
        assert.deepEqual(errors, []);
        const readyImage = await page.screenshot({ path: `${directory}/${name}-ready.png` });
        const pixel = await sharp(readyImage).extract({ left: 8, top: 360, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        assert.deepEqual([...pixel], appearance === 'dark' ? [24, 35, 47] : [245, 237, 223],
          'The first accepted reading surface must actually paint its configured background');
        if (mode !== 'preview') {
          assert.equal(await page.$eval('.editor-host .cm-content', e => e === document.activeElement), true,
            'The first accepted editable surface must own keyboard focus');
          const selection = await page.$eval('.editor-host .cm-content', e => {
            const state = (e as any).cmTile.root.view.state;
            return { from: state.selection.main.from, to: state.selection.main.to, text: state.doc.toString() };
          });
          assert.equal(selection.text, text, 'Startup must retain the complete document');
          const edited = text.slice(0, selection.from) + 'X' + text.slice(selection.to);
          await page.keyboard.type('X');
          await page.waitForFunction(expected => {
            const content = document.querySelector('.editor-host .cm-content') as any;
            return content?.cmTile.root.view.state.doc.toString() === expected;
          }, {}, edited);
          let inputTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([firstInput, new Promise((_, reject) => {
              inputTimer = setTimeout(() => reject(new Error('First input did not reach the Host')), 3000);
            })]);
          } finally { clearTimeout(inputTimer); }
          assert.equal(hostText, edited, 'First input must reach the Host without losing document text');
        }
        reports.push({ size, mode, alpha, ...report });
        console.log(`Unified startup presentation passed: ${name}; pre-init color samples ${report.beforeInitReads}`);
      } finally {
        releaseShell(); releaseEditor(); releasePreview();
        await context.close();
        for (const document of documents.values()) document.dispose();
      }
    }
  } finally {
    server.stop(true);
    fs.writeFileSync(`${directory}/report.json`, JSON.stringify(reports, null, 2));
  }
}
