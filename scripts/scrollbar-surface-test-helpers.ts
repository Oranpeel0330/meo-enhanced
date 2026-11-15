import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import exportRuntime from '../src/export/runtime';

// Sample the compositor: computed scrollbar-track colors do not describe the
// reserved gutter when overflow is absent.
async function checkPaint(page: Page, label: string, overflow: boolean) {
  const probes = await page.evaluate(() => {
    const result: { name: string; x: number; y: number; expected: number[]; overflow: boolean; gutter: number }[] = [];
    const context = document.createElement('canvas').getContext('2d')!;
    const probe = (name: string, element: HTMLElement, background: string) => {
      const rect = element.getBoundingClientRect();
      const gutter = element.offsetWidth - element.clientWidth;
      context.fillStyle = background; context.fillRect(0, 0, 1, 1);
      result.push({ name, x: Math.floor(rect.right - Math.max(2, gutter / 2)),
        y: Math.floor(rect.top + rect.height - 18),
        expected: Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3),
        overflow: element.scrollHeight > element.clientHeight, gutter });
    };
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    if (!editor.hidden && !editor.inert) {
      const scroll = editor.querySelector<HTMLElement>('.cm-scroller')!;
      probe('editor', scroll, getComputedStyle(scroll).backgroundColor);
    }
    const host = document.querySelector<HTMLElement>('.preview-host')!;
    if (!host.hidden && !host.inert && getComputedStyle(host).visibility !== 'hidden') {
      const frame = host.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      const rect = frame.getBoundingClientRect();
      // A root clientWidth can include a stable gutter without overflow.
      const root = doc.documentElement;
      const gutter = frame.clientWidth - root.getBoundingClientRect().width;
      context.fillStyle = doc.defaultView!.getComputedStyle(doc.body).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      result.push({ name: 'preview', x: Math.floor(rect.right - Math.max(2, gutter / 2)),
        y: Math.floor(rect.bottom - 18), expected: Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3),
        overflow: root.scrollHeight > root.clientHeight, gutter });
    }
    const sidebar = document.querySelector<HTMLElement>('.outline-sidebar')!;
    probe('outline', sidebar.querySelector<HTMLElement>('.outline-content')!, getComputedStyle(sidebar).backgroundColor);
    // Floating-panel shadows legitimately cover the adjacent document edge.
    return document.querySelector<HTMLElement>('.editor-wrapper')!.dataset.outlineMode === 'floating'
      ? result.filter(probe => probe.name === 'outline') : result;
  });
  const screenshot = await page.screenshot();
  const actual = await page.evaluate(async ({ data, probes }) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return probes.map(probe => Array.from(context.getImageData(probe.x, probe.y, 1, 1).data).slice(0, 3));
  }, { data: Buffer.from(screenshot).toString('base64'), probes });
  if (process.env.MEO_TEST_SCREENSHOTS) {
    mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
    await Bun.write(path.join(process.env.MEO_TEST_SCREENSHOTS, `${label.replaceAll('/', '-')}.png`), screenshot);
  }
  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i]!;
    assert.equal(probe.overflow, overflow, `${label}/${probe.name}: fixture overflow state`);
    assert.ok(probe.gutter > 0, `${label}/${probe.name}: native gutter is reserved`);
    assert.ok(actual[i]!.every((channel, j) => Math.abs(channel - probe.expected[j]!) <= 1),
      `${label}/${probe.name}: gutter paint ${actual[i]} must match content ${probe.expected}; overflow=${probe.overflow}`);
  }
}

export async function checkScrollbarSurfaces(browser: Browser, bundle: string) {
  for (const appearance of ['dark', 'light'] as const) {
    for (const overflow of [false, true]) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(String(error)));
      try {
        await page.setViewport({ width: 1200, height: 720 });
        await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${appearance}"><div id="app"></div></body>`);
        await page.addStyleTag({ path: 'webview/src/styles.css' });
        await page.addStyleTag({ content: ':root{--vscode-editor-background:#282828;--vscode-editorWidget-background:#282828;--vscode-editor-foreground:#dddddd;--vscode-foreground:#dddddd;--vscode-button-background:#2472c8;--vscode-textLink-foreground:#2472c8;--vscode-font-family:Arial;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px}' });
        await page.exposeFunction('__renderScrollbar', (message: any) => message.type === 'requestPreviewRender' ? {
          type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
            markdownText: message.text, sourceDocumentPath: '/fixture/scrollbars.md', uiLanguage: appearance === 'dark' ? 'zh-CN' : 'en',
            styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth
          }) }
        } : null);
        await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return {}},setState(){},postMessage(message){window.__renderScrollbar(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
        await page.addScriptTag({ content: bundle });
        const text = Array.from({ length: overflow ? 45 : 1 }, (_, i) => `## Section ${i}\n\nReading content.\n`).join('\n');
        await page.evaluate(({ text, appearance }) => window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'init', documentId: 'file:///scrollbars.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [],
          mode: 'live', uiLanguage: appearance === 'dark' ? 'zh-CN' : 'en', sourceLineNumbers: 'on', previewAppearance: appearance,
          previewFontFamily: '', previewSourceColoring: false, editorAppearance: appearance,
          uiColors: { dark: { documentBackground: '#19302c' }, light: { documentBackground: '#edf4f0' } },
          gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
          fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
          findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible: true, outlineWidth: 260,
          vscodeTheme: { name: 'fixture', type: appearance, colors: {}, tokenColors: [] }
        } })), { text, appearance });
        await page.waitForFunction(count => document.querySelectorAll('.outline-item').length === count, {}, overflow ? 45 : 1);
        for (const view of ['live', 'source', 'source+preview', 'preview'] as const) {
          const mode = view === 'source+preview' ? 'source' : view;
          await page.click(`button[data-mode="${mode}"]`);
          if (view === 'source+preview') await page.click('.source-preview-button');
          await page.waitForFunction(({ mode, preview }) => {
            const editor = document.querySelector<HTMLElement>('.editor-host')!;
            const host = document.querySelector<HTMLElement>('.preview-host')!;
            return document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode
              && !document.querySelector('.editor-surface')!.hasAttribute('data-source-preview-preparing')
              && (mode === 'preview' ? editor.hidden && !editor.hasAttribute('data-preview-cover') : !editor.hidden && !editor.inert)
              && (!preview || !host.hidden && !host.inert && getComputedStyle(host).visibility !== 'hidden'
                && host.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.inert === false);
          }, {}, { mode, preview: view === 'preview' || view === 'source+preview' });
          if (view === 'source+preview') {
            await page.select('.preview-preset-control select', 'github-readme');
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === 'github-readme');
          }
          for (const position of ['left', 'right'] as const) {
            await page.evaluate(position => {
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'outlinePositionChanged', position } }));
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'outlineVisibilityChanged', visible: true } }));
            }, position);
            for (const outline of ['fixed', 'floating'] as const) {
              if (await page.$eval('.editor-wrapper', e => (e as HTMLElement).dataset.outlineMode) !== outline) {
                await page.click('.outline-header-button[data-action="toggle-mode"]');
              }
              await page.mouse.move(0, 0);
              await checkPaint(page, `${appearance}/${overflow ? 'overflow' : 'short'}/${view}/${position}/${outline}`, overflow);
            }
          }
        }
        // Every built-in preset and an opposite Preview appearance use the
        // same resolved carrier surface, including an already-open iframe.
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'outlineVisibilityChanged', visible: true } })));
        await page.click('.outline-header-button[data-action="toggle-mode"]');
        for (const preset of ['default', 'newsprint', 'whitey', 'obsidian-minimal', 'github-readme']) {
          await page.select('.preview-preset-control select', preset);
          await page.waitForFunction(preset => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement.dataset.meoPreviewPreset === preset, {}, preset);
          await checkPaint(page, `${appearance}/${overflow ? 'overflow' : 'short'}/${preset}`, overflow);
        }
        await page.select('.preview-appearance-select', appearance === 'dark' ? 'light' : 'dark');
        await page.waitForFunction(appearance => document.querySelector<HTMLElement>('.preview-host')!.style.colorScheme !== appearance, {}, appearance);
        await checkPaint(page, `${appearance}/${overflow ? 'overflow' : 'short'}/opposite-preview`, overflow);
        assert.deepEqual(errors, [], 'scrollbar fixture Webview errors');
      } finally { await page.close(); }
    }
  }
  console.log('Scrollbar gutter paint passed across short/overflow documents, modes and outline placements.');
}
