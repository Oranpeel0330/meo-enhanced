import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { buildExportStyles, buildPreviewStyles } from '../src/export/exportStyles';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-kbd-appearance-'));
const screenshots = path.join(repoRoot, '.local/test-artifacts/document-keycaps');
fs.mkdirSync(screenshots, { recursive: true });
const contrast = (a: number[], b: number[]) => {
  const luminance = (channels: number[]) => channels.map(value => {
    const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  return (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
};
const source = [
  '键帽样式', '',
  '点击右<kbd>侧单元</kbd>格末尾，按 <kbd>Ctrl</kbd>+Enter。', '',
  '> 引用里的 <kbd>回车</kbd>。', '',
  '- 列表中的 <kbd>Esc</kbd>。', '',
  '嵌套 HTML <strong>快捷键 <kbd>Enter</kbd></strong>。', '',
  '<p>HTML 中的 <kbd>回车</kbd> 和 <kbd>Ctrl</kbd>。</p>', '',
  '| 按键 |', '| --- |', '| 按 <kbd>回车</kbd> 和 <kbd>Ctrl</kbd> |', '',
  '<details open><summary>折叠标题 <kbd>Enter</kbd></summary><p>正文</p></details>'
].join('\n');

let browser: Awaited<ReturnType<typeof launchTestBrowser>> | undefined;
try {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'test-kbd-appearance-entry.ts')],
    outdir: tempDir, target: 'browser', format: 'iife', naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  browser = await launchTestBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 1000 });
  await page.setContent('<!doctype html><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root{--vscode-editor-font-weight:400;--vscode-font-family:Arial,sans-serif}#app{height:950px}.meo-md-html-table-cell-preview{min-width:300px}' });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  for (const appearance of ['light', 'dark'] as const) {
    for (const font of ['Consolas', 'Arial', 'Microsoft YaHei']) {
      for (const size of [12, 16, 24]) {
        const result = await page.evaluate(async ({ appearance, font, size, source }) => {
          const api = (globalThis as any).KbdAppearanceHarness;
          const root = document.documentElement;
          root.style.setProperty('--vscode-editor-font-family', `"${font}", "Microsoft YaHei", sans-serif`);
          root.style.setProperty('--vscode-editor-font-size', `${size}px`);
          api.applyBuiltInVisualBaseline(appearance);
          api.applyUiTheme(appearance, false);
          const app = document.getElementById('app')!;
          const mount = (keys: boolean) => {
            const editor = api.createEditor({ parent: app, initialMode: 'live', uiLanguage: 'zh-CN',
              text: keys ? source : source.replace(/<\/?kbd>/g, ''), onApplyChanges() {} });
            return editor;
          };
          const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const measure = () => Array.from(app.querySelectorAll('.cm-line, .meo-md-html-content p, .meo-md-html-content summary, .meo-md-html-table-cell-line'))
            .map(node => node.getBoundingClientRect().height);
          const plain = mount(false);
          await settle();
          const plainHeights = measure();
          plain.destroy();
          const editor = mount(true);
          await settle();
          const keyHeights = measure();
          const probe = () => {
            const span = document.createElement('span');
            span.style.cssText = 'display:inline-block;width:0;height:0;border:0;padding:0;margin:0;vertical-align:baseline';
            return span;
          };
          const keys = Array.from(app.querySelectorAll<HTMLElement>('kbd')).map(key => {
            const before = probe();
            key.before(before);
            const label = document.createElement('span');
            label.append(...Array.from(key.childNodes));
            key.append(label);
            const inner = probe();
            label.append(inner);
            const style = getComputedStyle(key);
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const paint = canvas.getContext('2d', { willReadFrequently: true })!;
            const ancestors: Element[] = [];
            for (let node: Element | null = key; node; node = node.parentElement) ancestors.unshift(node);
            paint.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--meo-background'); paint.fillRect(0, 0, 1, 1);
            for (const node of ancestors) { paint.fillStyle = getComputedStyle(node).backgroundColor; paint.fillRect(0, 0, 1, 1); }
            const background = Array.from(paint.getImageData(0, 0, 1, 1).data).slice(0, 3);
            paint.fillStyle = style.borderTopColor; paint.fillRect(0, 0, 1, 1);
            const result = { text: key.textContent, baseline: inner.getBoundingClientRect().top - before.getBoundingClientRect().top,
              color: style.color, fill: style.webkitTextFillColor, font: style.fontFamily,
              background, border: Array.from(paint.getImageData(0, 0, 1, 1).data).slice(0, 3),
              keyFill: style.backgroundColor, topWidth: style.borderTopWidth, bottomWidth: style.borderBottomWidth };
            inner.remove(); before.remove(); label.replaceWith(...Array.from(label.childNodes));
            return result;
          });
          editor.destroy();
          return { plainHeights, keyHeights, keys };
        }, { appearance, font, size, source });
        const context = `${appearance}/${font}/${size}`;
        assert.equal(result.keys.length, 10, context);
        assert.deepEqual(result.keyHeights, result.plainHeights, `${context}: keycaps must preserve line heights`);
        for (const key of result.keys) {
          assert(Math.abs(key.baseline) < 0.1, `${context}/${key.text}: baseline offset ${key.baseline}px`);
          assert.equal(key.fill, key.color, `${context}/${key.text}: text fill must match foreground`);
          assert.equal(key.keyFill, 'rgba(0, 0, 0, 0)', `${context}: keep the transparent key surface`);
          assert.equal(key.topWidth, '1px'); assert.equal(key.bottomWidth, '2px');
          if (appearance === 'dark') assert.ok(contrast(key.border, key.background) >= 1.4 && contrast(key.border, key.background) < 2.5,
            `${context}/${key.text}: dark frame is visible but restrained`);
          assert(key.font.startsWith('Consolas') && key.font.includes('Microsoft YaHei'), `${context}: include the prose fallback font`);
        }
      }
    }
    const environment = await page.evaluate(() => ({
      editorBackgroundColor: document.documentElement.style.getPropertyValue('--meo-background'),
      meoThemeColors: Object.fromEntries(Array.from(document.documentElement.style).filter(name => name.startsWith('--meo-document-'))
        .map(name => [name.slice('--meo-'.length), document.documentElement.style.getPropertyValue(name)]))
    }));
    for (const [kind, buildStyles] of [['preview', buildPreviewStyles], ['export', buildExportStyles]] as const) {
      const preview = await browser.newPage();
      await preview.setContent('<p><span id="kbd-sample">按 <kbd>Ctrl</kbd> + <kbd>S</kbd> 保存 / Save</span></p>');
      await preview.addStyleTag({ content: buildStyles({ ...environment, editorFontFamily: 'Arial, "Microsoft YaHei", sans-serif', editorFontSizePx: 16 }, appearance) });
      const previewStyle = await preview.$eval('kbd', key => {
        const style = getComputedStyle(key);
        return { font: style.fontFamily, color: style.color, fill: style.webkitTextFillColor,
          background: style.backgroundColor, border: style.borderTopColor, topWidth: style.borderTopWidth, bottomWidth: style.borderBottomWidth };
      });
      assert(previewStyle.font.startsWith('Consolas') && previewStyle.font.includes('Microsoft YaHei'));
      assert.equal(previewStyle.fill, previewStyle.color);
      assert.equal(previewStyle.background, 'rgba(0, 0, 0, 0)');
      assert.equal(previewStyle.topWidth, '1px'); assert.equal(previewStyle.bottomWidth, '2px');
      assert.deepEqual(previewStyle.border.match(/[\d.]+/g)!.map(Number), environment.meoThemeColors['document-kbd-border'].match(/[\d.]+/g)!.map(Number),
        `${kind}/${appearance}: use the captured document key border color`);
      const sample = await preview.$eval('#kbd-sample', sample => sample.getBoundingClientRect().toJSON());
      await preview.screenshot({ path: path.join(screenshots, `${kind}-${appearance}.png`), clip: {
        x: Math.max(0, Math.floor(sample.x) - 6), y: Math.max(0, Math.floor(sample.y) - 8),
        width: Math.ceil(sample.width) + 12, height: Math.ceil(sample.height) + 16
      } });
      await preview.close();
    }
  }
  console.log('Kbd appearance passed: Chinese/Latin baselines, line heights, restrained dark frames, transparent surfaces, and Preview/export parity.');
} finally {
  await browser?.close();
  assert.equal(path.dirname(tempDir), path.resolve(os.tmpdir()));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
