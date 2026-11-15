import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/application/largeDocumentPolicy';
import { getWebviewPreloadShellCss, getWebviewPreloadShellMarkup } from '../src/shared/webviewPreloadShell';
import { webviewPreloadModules } from '../src/extension/webviewResourceHints';
import { installModeLoadingReadiness } from './mode-loading-readiness';

/** Failed viewport data must reach a terminal presentation without restarting readiness. */
export async function checkStartupFailureRecovery(browser: Browser): Promise<void> {
  const text = '# Window failure\n\n' + Array.from({ length: 5000 }, (_, i) => `Short paragraph ${i}.\n\n`).join('');
  assert.equal(assessLargeDocument(text).windowedPreview, true);
  const dist = path.resolve('webview/dist');
  const directory = '.local/test-artifacts/startup-failure';
  fs.mkdirSync(directory, { recursive: true });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const relative = decodeURIComponent(new URL(request.url).pathname).slice(1);
    if (!relative) return new Response(`<!doctype html><style>${getWebviewPreloadShellCss()}</style><link rel="stylesheet" href="/index.css">`
      + webviewPreloadModules(false).map(module => `<link rel="modulepreload" href="/${module}">`).join('')
      + `<body class="vscode-dark"><div id="app">${getWebviewPreloadShellMarkup()}</div><script type="module" src="/index.js"></script>`,
    { headers: { 'Content-Type': 'text/html' } });
    const file = path.resolve(dist, relative);
    return file.startsWith(dist + path.sep) && fs.existsSync(file) ? new Response(Bun.file(file)) : new Response('', { status: 404 });
  } });
  const reports: unknown[] = [];
  const ready = (page: Page, mode: 'source' | 'preview') => page.waitForFunction(mode =>
    (window as any).__modeLoadingReadiness(mode, 'Window failure').interactive, { timeout: 10000 }, mode);
  try {
    for (const scenario of ['persistent', 'once', 'cancel-success', 'cancel-failure'] as const) {
      const context = await browser.createBrowserContext();
      const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const firstBlock = new Promise<void>(resolve => { entered = resolve; });
      let requests = 0, failures = 0, renders = 0;
      let policy: 'pass' | 'persistent' | 'once' | 'held' = scenario.startsWith('cancel') ? 'held' : scenario as 'persistent' | 'once';
      const errors: string[] = [], logs: string[] = [];
      try {
        const page = await context.newPage();
        await page.setViewport({ width: 1100, height: 720 });
        page.on('pageerror', error => errors.push(String(error)));
        page.on('console', message => { if (message.type() === 'error') logs.push(message.text()); });
        await page.exposeFunction('__startupFailureHost', async (message: any) => {
          if (message.type === 'ready') return {
            type: 'init', pageId: message.pageId, documentId: 'file:///window-failure.md', text, version: 1,
            savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: 'en',
            sourceLineNumbers: 'on', editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
            previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: false,
            gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
            diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
            contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
            outlineVisible: false, outlinePosition: 'right', outlineWidth: 260,
            restoreReadingPositionOnOpen: false, largeDocumentOptimizationEnabled: true, vscodeTheme: null
          };
          if (message.type === 'requestPreviewRender') {
            renders++;
            assert.ok(message.window, 'Exercise production windowed rendering');
            const document = createPreviewDocument(message.requestId, { markdownText: message.text,
              sourceDocumentPath: 'C:/fixtures/window-failure.md', uiLanguage: 'en', styleEnvironment: message.environment });
            documents.set(message.requestId, document);
            return { type: 'previewRenderResult', requestId: message.requestId,
              result: { ok: true, value: document.open(message.window.anchorLine) } };
          }
          if (message.type !== 'requestPreviewDocument') return null;
          if (message.operation.kind === 'blocks') {
            requests++;
            entered();
            const requestedPolicy = policy;
            if (requestedPolicy === 'held') await held;
            if (requestedPolicy === 'persistent' || requestedPolicy === 'once'
              || requestedPolicy === 'held' && scenario === 'cancel-failure') {
              failures++;
              if (requestedPolicy === 'once') policy = 'pass';
              return { type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
                result: { ok: false, error: { code: 'operation-failed', message: 'Controlled blocks failure' } } };
            }
          }
          return { type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
            result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
        });
        await page.evaluateOnNewDocument(installModeLoadingReadiness);
        await page.evaluateOnNewDocument(() => {
          (window as any).acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: any) {
            (window as any).__startupFailureHost(message).then((response: unknown) => {
              if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
            });
          } });
        });
        await page.goto(server.url.href, { waitUntil: 'domcontentloaded' });
        let blockTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([firstBlock, new Promise((_, reject) => {
          blockTimer = setTimeout(() => reject(new Error('Initial Preview did not request missing visible blocks')), 10000);
        })]); } finally { clearTimeout(blockTimer); }
        if (scenario.startsWith('cancel')) {
          await page.click('[data-mode="source"]');
          await ready(page, 'source');
          release();
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)));
          await ready(page, 'source');
          assert.equal(await page.$eval('.editor-host .cm-content', element => (element as any).cmTile.root.view.state.doc.toString()), text);
          assert.equal(await page.$('.meo-startup-loading'), null, 'A late canceled block result must not restore a startup cover');
          const settledRequests = requests, settledLogs = logs.length;
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 180)));
          assert.equal(requests, settledRequests, 'Canceled window work must converge after its late result');
          assert.equal(logs.length, settledLogs);
        } else {
          const expectTerminal = async () => {
            await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === false);
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
            const terminal = await page.evaluate(() => {
              const status = document.querySelector<HTMLElement>('.preview-status')!, rect = status.getBoundingClientRect();
              const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return { startup: !!document.querySelector('.meo-startup-loading'), statusVisible: !status.hidden && status.contains(target),
                loadingHidden: document.querySelector<HTMLElement>('.preview-loading')?.hidden,
                busy: document.querySelector('.preview-host')?.getAttribute('aria-busy') };
            });
            assert.deepEqual(terminal, { startup: false, statusVisible: true, loadingHidden: true, busy: null },
              `A failed reading window must expose its error state: ${JSON.stringify({ terminal, requests, failures })}`);
            const settledRequests = requests, settledLogs = logs.length;
            await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
            assert.equal(requests, settledRequests, 'Terminal failure must stop automatic block requests');
            assert.equal(logs.length, settledLogs, 'Terminal failure must stop repeated error logs');
          };
          await expectTerminal();
          await page.screenshot({ path: `${directory}/${scenario}-error.png` });
          policy = 'pass';
          if (scenario === 'once') {
            await page.evaluate(() => {
              (window as any).__failedPreviewDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument;
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'editorLineHeightChanged', value: 1.7 } }));
            });
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
              ?.querySelector('[data-meo-preview-block="16"]'));
            assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
              === (window as any).__failedPreviewDocument), true, 'An in-place successful refresh must reactivate the retained viewport');
          } else {
            await page.click('[data-mode="source"]'); await ready(page, 'source');
            await page.click('[data-mode="preview"]');
          }
          await ready(page, 'preview');
          assert.ok(renders >= 2, 'Explicit retry must render a fresh accepted document');
          assert.equal(await page.$eval('.preview-status', element => (element as HTMLElement).hidden), true);
          if (scenario === 'persistent') {
            policy = 'persistent';
            await page.mouse.move(400, 400); await page.mouse.wheel({ deltaY: 8000 });
            await expectTerminal();
          }
        }
        assert.deepEqual(errors, []);
        reports.push({ scenario, requests, failures, renders, logs: logs.length });
        console.log(`Startup window failure passed: ${scenario}`);
      } finally {
        release();
        await context.close();
        for (const document of documents.values()) document.dispose();
      }
    }
  } finally {
    server.stop(true);
    fs.writeFileSync(`${directory}/report.json`, JSON.stringify(reports, null, 2));
  }
}
