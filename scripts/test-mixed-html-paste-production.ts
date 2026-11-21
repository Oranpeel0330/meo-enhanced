import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  await page.setViewport({ width: 1000, height: 700 });
  await page.setContent('<!doctype html><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const prepare = async (mode: string, text = '', from = text.length, to = from, preferences = {}) => {
    await page.evaluate(({ mode, text, from, to, preferences }) => {
      const global = window as any;
      global.editor?.destroy();
      global.EditingFeaturesHarness.applyUiTheme(mode === 'live' ? 'light' : 'dark', true);
      global.editor = global.EditingFeaturesHarness.createEditor({ parent: document.querySelector('#app')!,
        text, initialMode: mode, uiLanguage: mode === 'live' ? 'zh-CN' : 'en', initialInputAssistance: preferences, onApplyChanges() {} });
      global.editor.view.dispatch({ selection: { anchor: from, head: to } }); global.editor.view.focus();
    }, { mode, text, from, to, preferences: { ...defaultInputAssistance, ...preferences } });
  };
  const paste = async (plain: string, html: string, custom = '') => {
    await page.evaluate(({ plain, html, custom }) => {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', plain);
      clipboard.setData('text/html', html);
      if (custom) clipboard.setData('application/x-meo-table-cells+json', custom);
      (window as any).editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, { plain, html, custom });
    return page.evaluate(() => (window as any).editor.getText());
  };
  const undoRedo = async (before: string, after: string) => {
    assert.deepEqual(await page.evaluate(() => (window as any).editor.getHistoryDepth()), { undo: 1, redo: 0 });
    await page.evaluate(() => (window as any).editor.undo());
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), before);
    await page.evaluate(() => (window as any).editor.redo());
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), after);
  };
  const trigger = '.meo-paste-options-trigger';
  const option = (mode: string) => '.meo-paste-options-menu [data-paste-mode="' + mode + '"]';
  const choose = async (mode: string) => {
    await page.waitForSelector(trigger, { visible: true });
    await page.click(trigger);
    await page.waitForSelector(option(mode), { visible: true });
    await page.click(option(mode));
    return page.evaluate(() => (window as any).editor.getText());
  };
  const table = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
  const markdown = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  const mixedHtml = '<p>前文标记：这段文字应保留。</p>' + table + '<p>后文标记：这段文字也应保留。</p>';
  const mixedPlain = '前文标记：这段文字应保留。\nA\tB\n1\t2\n后文标记：这段文字也应保留。';
  const mixedMarkdown = '前文标记：这段文字应保留。\n\n' + markdown + '\n\n后文标记：这段文字也应保留。';
  for (const mode of ['source', 'live']) {
    await page.setViewport({ width: mode === 'source' ? 480 : 1000, height: 700 });
    await prepare(mode, '', 0, 0, { convertTables: false, pasteHtml: false });
    assert.equal(await paste(mixedPlain, mixedHtml), mixedPlain);
    assert.equal(await choose('formatted'), mixedMarkdown, mode + ': one paste overrides both defaults');
    await undoRedo('', mixedMarkdown);

    const originalMarkdown = '# Heading with **bold**\n\n- [x] A [link](https://example.com)\n- Use C#\n\n' + markdown;
    const textOnly = 'Heading with bold\n\nA link\nUse C#\n\nA\tB\n1\t2';
    await prepare(mode);
    await page.keyboard.down('Control');
    assert.equal(await paste(originalMarkdown, ''), originalMarkdown);
    await page.keyboard.up('Control');
    await page.waitForSelector(trigger, { visible: true });
    assert.equal(await page.$eval(trigger, element => element.getAttribute('aria-expanded')), 'false', mode + ': releasing the paste modifier does not open the menu');
    assert.deepEqual(await page.$eval(trigger, element => ({
      text: element.textContent,
      icons: element.querySelectorAll('svg').length
    })), { text: 'Ctrl', icons: 2 }, mode + ': the compact button shows the shortcut between two icons');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Control');
    await page.waitForSelector(option('plain'), { visible: true });
    assert.equal(await page.$eval(option('plain'), element => element.textContent), mode === 'live' ? '仅保留文字' : 'Keep text only');
    if (mode === 'live') {
      await page.waitForSelector('.meo-md-html-table', { visible: true });
      const geometry = await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const table = document.querySelector('.meo-md-html-table')!.getBoundingClientRect();
        const button = document.querySelector('.meo-paste-options-trigger')!.getBoundingClientRect();
        const view = (window as any).editor.view;
        const block = view.lineBlockAt(view.state.selection.main.head);
        return { left: table.left, right: table.right, button: button.left, block: block.type };
      });
      assert.ok(geometry.button >= geometry.left - 8 && geometry.button < geometry.right,
        'a rendered table anchors the menu near its visible content: ' + JSON.stringify(geometry));
    }
    if (process.argv.includes('--capture')) {
      mkdirSync('.local/input-presentation', { recursive: true });
      const appearance = mode === 'live' ? 'light-zh' : 'dark-en';
      await page.screenshot({ path: '.local/input-presentation/paste-options-' + appearance + '.png' });
    }
    assert.equal(await page.$eval(option('formatted'), element => element === document.activeElement), true);
    await page.keyboard.press('ArrowDown');
    const rows = await page.$$eval('.meo-paste-options-menu button', elements => elements.map(element => ({
      background: getComputedStyle(element).backgroundColor,
      before: getComputedStyle(element, '::before').content
    })));
    assert.notEqual(rows[0].background, 'rgba(0, 0, 0, 0)', mode + ': the current choice has a background');
    assert.deepEqual(rows.map(row => row.before), ['none', 'none'], mode + ': choices have no checkmarks');
    assert.equal(rows[1].background, 'rgba(0, 0, 0, 0)', mode + ': keyboard focus keeps the current choice distinguishable');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), textOnly, mode + ': Markdown syntax and table structure are removed');
    await undoRedo('', textOnly);

    await prepare(mode, 'label', 0, 5);
    assert.equal(await paste('https://example.com', ''), '[label](https://example.com)');
    assert.equal(await choose('plain'), 'https://example.com', mode + ': text choice replaces the auto-generated link');
    await undoRedo('label', 'https://example.com');

    await prepare(mode, '', 0, 0, { pasteHtml: true });
    const formatted = '# Heading\n\n**Word**\n\n| A | B |\n| --- | --- |\n| **1** | 2 |';
    assert.equal(await paste('Heading\nWord\nA\tB\n1\t2',
      '<h1>Heading</h1><p><b>Word</b></p>' + table.replace('<td>1', '<td><b>1</b>')), formatted);
    assert.equal(await choose('plain'), 'Heading\n\nWord\n\nA\tB\n1\t2', mode + ': rich clipboard table and prose become text');

    await prepare(mode);
    assert.equal(await paste('A\tB\n1\t2', '<p>Unstructured HTML</p>'), markdown);
    assert.equal(await choose('plain'), 'A\tB\n1\t2', mode + ': recognized spreadsheet text keeps every row and column');

    await prepare(mode, '', 0, 0, { showPasteOptions: false, pasteHtml: true });
    assert.equal(await paste('bold', '<b>bold</b>'), '**bold**');
    assert.equal(await page.$(trigger), null, mode + ': disabling the menu leaves ordinary formatting enabled');
    await prepare(mode);
    assert.equal(await paste('C# and a * b', ''), 'C# and a * b');
    assert.equal(await page.$(trigger), null, mode + ': ordinary symbols have no alternative paste result');
    assert.equal(await paste('bold', '<b>bold</b>'), 'C# and a * bbold');
    await page.waitForSelector(trigger, { visible: true });
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.$(trigger), null, mode + ': moving the caret retires the action');
    assert.equal(await paste('word', '<strong>word</strong>'), 'C# and a * bbolwordd');
    await page.waitForSelector(trigger, { visible: true });
    await page.keyboard.press('Control');
    await page.waitForSelector(option('plain'), { visible: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.$(trigger), null, mode + ': Escape retires the action');
    assert.equal(await page.evaluate(() => document.activeElement === (window as any).editor.view.contentDOM), true);

    for (const pasteHtml of [false, true]) for (const convertTables of [false, true]) {
      await prepare(mode, '', 0, 0, { pasteHtml, convertTables });
      const expected = pasteHtml && convertTables ? mixedMarkdown : mixedPlain;
      assert.equal(await paste(mixedPlain, mixedHtml), expected, `${mode}: mixed fragment and conversion switches`);
      await undoRedo('', expected);
    }
    for (const [html, original, position, expected] of [
      ['<p>Before</p>' + table, 'suffix', 0, 'Before\n\n' + markdown + '\n\nsuffix'],
      [table + '<p>After</p>', 'prefix', 6, 'prefix\n\n' + markdown + '\n\nAfter'],
      ['<div><span> </span><table><caption>Caption</caption>' + table.slice(7) + '</div>', 'prefix', 6, 'prefix\n\nCaption\n\n' + markdown],
      ['<blockquote>' + table + '</blockquote>', 'prefixsuffix', 6, 'prefix\n\n' + markdown.split('\n').map(line => '> ' + line).join('\n') + '\n\nsuffix'],
      ['<h2>Heading</h2>', 'prefixsuffix', 6, 'prefix\n\n## Heading\n\nsuffix'],
      ['<pre>code</pre>', 'prefixsuffix', 6, 'prefix\n\n```\ncode\n```\n\nsuffix'],
      ['<ul><li>one</li><li>two</li></ul>', 'prefixsuffix', 6, 'prefix\n\n- one\n- two\n\nsuffix'],
      ['<hr>', 'prefixsuffix', 6, 'prefix\n\n---\n\nsuffix'],
      ['<p><strong>inline</strong></p>', 'prefixsuffix', 6, 'prefix**inline**suffix']
    ] as const) {
      await prepare(mode, original, position, position, { pasteHtml: true });
      assert.equal(await paste('plain fallback', html), expected, `${mode}: block edges for ${html.slice(0, 30)}`);
      await undoRedo(original, expected);
    }
    for (const src of ['', 'data:image/png;base64,ignored', 'javascript:ignored']) {
      const image = '<img src="' + src + '">';
      await prepare(mode, 'prefix', 6, 6, { pasteHtml: true });
      assert.equal(await paste('fallback', image + table + '<p>After</p>'), 'prefix\n\n' + markdown + '\n\nAfter', `${mode}: filtered leading image does not hide a block edge`);
      await prepare(mode, 'suffix', 0, 0, { pasteHtml: true });
      assert.equal(await paste('fallback', '<p>Before</p>' + table + image), 'Before\n\n' + markdown + '\n\nsuffix', `${mode}: filtered trailing image does not hide a block edge`);
    }
    await prepare(mode, 'left replace right', 5, 12, { pasteHtml: true });
    assert.equal(await paste(mixedPlain, mixedHtml), 'left ' + mixedMarkdown + ' right');
    await undoRedo('left replace right', 'left ' + mixedMarkdown + ' right');
    for (const pasteHtml of [false, true]) {
      await prepare(mode, '', 0, 0, { pasteHtml });
      assert.equal(await paste('A\tB\n1\t2', '<div>A\tB<br>1\t2</div>'), markdown, `${mode}: TSV with HTML wrapper`);
      await prepare(mode, '', 0, 0, { pasteHtml });
      assert.equal(await paste('A\tB\n1\t2', table), markdown, `${mode}: standalone HTML table`);
    }
    const twoHtml = '<p><strong>Before</strong></p>' + table + '<p>Between</p>' + table + '<p>After</p>';
    await prepare(mode, '', 0, 0, { pasteHtml: true });
    assert.equal(await paste('Before\nA\tB\n1\t2\nBetween\nA\tB\n1\t2\nAfter', twoHtml), '**Before**\n\n' + markdown + '\n\nBetween\n\n' + markdown + '\n\nAfter');
    const formattedHtml = '<div><p><strong>Before</strong> <a href="https://example.test/">link</a></p><table><caption>First table</caption><tr><th>A</th><th>B</th></tr><tr><td rowspan="2"><em>one</em><br>two</td><td>x|y</td></tr><tr><td>z</td></tr></table><p>Between</p><table><tr><th>C</th></tr><tr><td><code>code</code></td></tr></table><p>After</p></div>';
    await prepare(mode, '', 0, 0, { pasteHtml: true });
    assert.equal(await paste('complete fallback', formattedHtml), '**Before** [link](https://example.test/)\n\nFirst table\n\n| A | B |\n| --- | --- |\n| *one*<br>two | x\\|y |\n|  | z |\n\nBetween\n\n| C |\n| --- |\n| `code` |\n\nAfter');
    const invalid = '<p><strong>Before</strong></p><table><tr><td colspan="10001">value</td></tr></table><p>After</p>';
    for (const convertTables of [false, true]) {
      await prepare(mode, '', 0, 0, { pasteHtml: true, convertTables });
      assert.equal(await paste('Before\nvalue\nAfter', invalid), 'Before\nvalue\nAfter', `${mode}: invalid table falls back as a whole`);
      await prepare(mode, '', 0, 0, { pasteHtml: true, convertTables });
      assert.equal(await paste('whole fragment', table + invalid), 'whole fragment', `${mode}: no partially converted siblings`);
    }
    for (const nested of [table, '<table><tr><td colspan="10001">oversized inner table</td></tr></table>']) {
      await prepare(mode, '', 0, 0, { pasteHtml: true });
      assert.equal(await paste('complete nested table text', '<table><tr><td>outer' + nested + '</td></tr></table>'),
        'complete nested table text', `${mode}: unsupported nesting cannot flatten or bypass capacity`);
    }
    await prepare(mode, '```\n\n```', 4, 4, { pasteHtml: true });
    assert.equal(await paste(mixedPlain, mixedHtml), '```\n' + mixedPlain + '\n```', `${mode}: code remains literal`);
    await prepare(mode, 'left right', 0, 0, { pasteHtml: true });
    await page.evaluate(() => {
      const global = window as any;
      global.editor.view.dispatch({ selection: global.EditingFeaturesHarness.EditorSelection.create([
        global.EditingFeaturesHarness.EditorSelection.range(0, 4), global.EditingFeaturesHarness.EditorSelection.range(5, 10)
      ]) });
    });
    assert.equal(await paste(mixedPlain, mixedHtml), mixedPlain + ' ' + mixedPlain, `${mode}: multiple selections use literal paste`);
    await undoRedo('left right', mixedPlain + ' ' + mixedPlain);
    const existing = '| X | Y |\n| --- | --- |\n| old | tail |';
    await prepare(mode, existing, existing.indexOf('old'), existing.indexOf('old'), { pasteHtml: true, convertTables: false });
    assert.equal(await paste(mixedPlain, mixedHtml), '| X | Y |\n| --- | --- |\n| A | B |\n| 1 | 2 |', `${mode}: existing tables still paste a matrix independently of conversion`);
    await prepare(mode, '', 0, 0, { pasteHtml: true });
    assert.equal(await paste('a\tb', '<b>unrelated</b>', JSON.stringify({ version: 1, cells: [['**a**', 'b']] })), '| **a** | b |\n| --- | --- |', `${mode}: editor matrix has priority`);
  }
  await prepare('source', 'prefix', 6, 6, { pasteHtml: true });
  assert.equal(await paste('Caption\nA\tB\n1\t2', '<table><caption><img src="caption.png" alt="Caption"></caption>' + table.slice(7)),
    'prefix\n\n![Caption](caption.png)\n\n' + markdown, 'non-text captions are preserved');
  await prepare('source', '', 0, 0, { pasteHtml: true });
  const parserCalls = await page.evaluate(({ mixedHtml, mixedPlain }) => {
    const parse = DOMParser.prototype.parseFromString;
    let calls = 0;
    DOMParser.prototype.parseFromString = function(...args) { calls++; return parse.apply(this, args); };
    try {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', mixedPlain); clipboard.setData('text/html', mixedHtml);
      (window as any).editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
      return calls;
    } finally { DOMParser.prototype.parseFromString = parse; }
  }, { mixedHtml, mixedPlain });
  assert.equal(parserCalls, 1, 'classification, formatting and table cells reuse the parsed clipboard DOM');
  // Each table is within its own limit, but the complete clipboard exceeds it.
  const largeTable = '<table>' + '<tr><td>a</td><td>b</td></tr>'.repeat(3000) + '</table>';
  const largePlain = 'Before\n' + 'a\tb\n'.repeat(3000) + 'Between\n' + 'a\tb\n'.repeat(3000) + 'After';
  await prepare('source', '', 0, 0, { pasteHtml: true });
  assert.equal(await paste(largePlain, '<p>Before</p>' + largeTable + '<p>Between</p>' + largeTable + '<p>After</p>'), largePlain, 'all tables share the clipboard capacity');
  console.log('Production paste: both modes, paste options, HTML/Markdown/table text, switches, block edges, dual MIME, capacity, literal code and undo/redo passed');
} finally { await closeTestBrowser(browser); }
