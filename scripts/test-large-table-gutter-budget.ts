import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-gutter-budget-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, `import { createEditor } from ${JSON.stringify(path.resolve('scripts/test-editor-factory.ts'))};
  import { getLiveTableRowGeometry } from ${JSON.stringify(path.resolve('webview/src/helpers/gitDiffOverviewRuler.ts'))};
  (window as any).budgetRowGeometry = getLiveTableRowGeometry;
  (window as any).createBudgetEditor = createEditor;`);
const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const text = '# Table gutter budget\n\n| Name | Value |\n| --- | --- |\n'
  + Array.from({ length: 1600 }, (_, index) => `| Row ${index} | **formatted** ${index % 53 === 0 ? 'wrapped content '.repeat(30) : index} |\n`).join('')
  + '\nAfter table.\n';
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 820, height: 600 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: path.resolve('webview/src/styles.css') });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(text => {
    // Accessibility keeps the complete table DOM. Its gutter still needs a
    // bounded reading band independently of the row-window presentation.
    document.body.classList.add('vscode-using-screen-reader');
    const scope = window as any;
    scope.editor = scope.createBudgetEditor({ parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {} });
    const original = Element.prototype.getBoundingClientRect;
    scope.rowReads = 0;
    scope.originalRect = original;
    Element.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLTableRowElement && this.dataset.sourceLineNumber) scope.rowReads++;
      return original.call(this);
    };
  }, text);
  const frames = () => page.evaluate(async () => {
    for (let index = 0; index < 8; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  await frames();
  const samples = [];
  for (const fraction of [0, .45, .95, .2, 0]) {
    await page.evaluate(fraction => {
      const scope = window as any, scroll = scope.editor.view.scrollDOM;
      scope.rowReads = 0;
      scroll.scrollTop = fraction * (scroll.scrollHeight - scroll.clientHeight);
      scroll.dispatchEvent(new Event('scroll'));
    }, fraction);
    await frames();
    const result = await page.evaluate(() => {
      const scope = window as any, view = scope.editor.view;
      const rect = (element: Element) => scope.originalRect.call(element) as DOMRect;
      const viewport = rect(view.scrollDOM), gutter = view.dom.querySelector('.cm-lineNumbers')!, gutterRect = rect(gutter);
      const nativeLabel = gutter.querySelector(':scope > .cm-gutterElement')!;
      const numberRight = gutterRect.right - parseFloat(getComputedStyle(nativeLabel).paddingRight);
      const labels = [...gutter.querySelectorAll<HTMLElement>('.meo-md-html-table-line-number')];
      const rows = [...view.dom.querySelectorAll<HTMLTableRowElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr[data-source-line-number]')];
      const visible = rows.filter(row => { const bounds = rect(row); return bounds.bottom > viewport.top && bounds.top < viewport.bottom; });
      return { reads: scope.rowReads, labels: labels.length, rows: rows.length,
        visible: visible.length,
        correct: visible.every(row => labels.some(label => label.textContent === row.dataset.sourceLineNumber
          && Math.abs(Number.parseFloat(label.style.top) - (rect(row).top - gutterRect.top)) < 1
          && Math.abs(rect(label).right - numberRight) < .5)),
        source: view.state.doc.toString() };
    });
    assert.equal(result.rows, 1601, 'gutter budgeting must preserve every actual table row');
    assert.equal(result.source, text);
    assert.ok(result.correct, `Visible table line numbers missing or misaligned: ${JSON.stringify({ fraction, ...result, source: undefined })}`);
    assert.ok(result.labels <= 100 && result.reads <= 180,
      `Offscreen table rows consumed gutter work: ${JSON.stringify({ fraction, ...result, source: undefined })}`);
    samples.push({ fraction, reads: result.reads, labels: result.labels, visible: result.visible });
  }
  await page.evaluate(() => {
    const scope = window as any, editor = scope.editor;
    scope.firstLabel = document.querySelector('.meo-md-html-table-line-number');
    editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
  });
  await frames();
  assert.ok(await page.evaluate(() => (window as any).firstLabel === document.querySelector('.meo-md-html-table-line-number')),
    'Unchanged viewport must retain its line-number DOM');
  await page.evaluate(() => {
    const scope = window as any;
    scope.rowReads = 0;
    scope.editor.setSearchQuery('Row 799');
  });
  await page.waitForSelector('.meo-search-overview-ruler-marker');
  await frames();
  const search = await page.evaluate(() => ({ reads: (window as any).rowReads,
    markers: document.querySelectorAll('.meo-search-overview-ruler-marker').length }));
  assert.equal(search.markers, 1);
  assert.ok(search.reads <= 180, `Searching one table row measured unrelated rows: ${JSON.stringify(search)}`);
  const endpoints = await page.evaluate(() => {
    const scope = window as any;
    scope.editor.setSearchQuery('');
    scope.rowReads = 0;
    const rows = scope.budgetRowGeometry(scope.editor.view, new Set([5, 804, 1604]));
    return { reads: scope.rowReads, lines: [...rows.keys()], heights: [...rows.values()].map((value: any) => value.bottom - value.top) };
  });
  assert.deepEqual(endpoints.lines, [5, 804, 1604], 'Overview endpoint geometry must include distant rows outside the line-number window');
  assert.equal(endpoints.reads, 3, 'Overview endpoints must not measure unrelated table rows');
  assert.ok(endpoints.heights.every(height => height > 0));
  await page.setViewport({ width: 610, height: 480 });
  await frames();
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setSourceLineNumbers('off');
    editor.setSourceLineNumbers('on');
    editor.view.dispatch({ changes: { from: 0, insert: 'prefix\n' } });
  });
  await frames();
  assert.ok(await page.evaluate(() => document.querySelector('.meo-md-html-table-line-number')?.textContent === '4'),
    'Line-number remount and source-line changes must invalidate visible table labels');
  await page.evaluate(() => {
    const scope = window as any;
    scope.editor.destroy();
    document.body.classList.remove('vscode-using-screen-reader');
    scope.editor = scope.createBudgetEditor({ parent: document.getElementById('app'), initialMode: 'live',
      text: 'top\n\n| A |\n| --- |\n| x |\n\n| B |\n| --- |\n| y |\n| z |\n\ntail', onApplyChanges() {} });
  });
  const expectLabels = async (expected: string[]) => {
    await frames();
    assert.deepEqual(await page.$$eval('.meo-md-html-table-line-number', labels => labels.map(label => label.textContent)), expected);
  };
  await expectLabels(['3', '5', '7', '9', '10']);
  await page.evaluate(() => {
    const { view } = (window as any).editor;
    // A line can move when its absolute source offsets have stayed the same.
    view.dispatch({ changes: { from: 1, to: 2, insert: '\n' } });
  });
  await expectLabels(['4', '6', '8', '10', '11']);
  await page.evaluate(() => {
    const { view } = (window as any).editor;
    view.dispatch({ changes: { from: view.state.doc.line(6).to, insert: '\n| added |' } });
  });
  await expectLabels(['4', '6', '7', '9', '11', '12']);
  assert.ok(await page.evaluate(() => (window as any).editor.undo()));
  await expectLabels(['4', '6', '8', '10', '11']);
  assert.ok(await page.evaluate(() => (window as any).editor.redo()));
  await expectLabels(['4', '6', '7', '9', '11', '12']);
  await page.evaluate(() => {
    const { view } = (window as any).editor;
    view.dispatch({ changes: { from: view.state.doc.line(4).from, to: view.state.doc.line(8).from } });
  });
  await expectLabels(['5', '7', '8']);
  await page.evaluate(() => {
    const editor = (window as any).editor, { view } = editor;
    editor.setSourceLineNumbers('relative');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });
  await expectLabels(['5', '3', '2']);
  await page.evaluate(() => {
    const editor = (window as any).editor, { view } = editor;
    editor.setSourceLineNumbers('interval');
    view.dispatch({ selection: { anchor: view.state.doc.line(7).from } });
  });
  await expectLabels(['7']);
  await page.evaluate(() => (window as any).editor.setSourceLineNumbers('off'));
  await expectLabels([]);
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setSourceLineNumbers('on');
    editor.setMode('source');
  });
  await expectLabels([]);
  await page.evaluate(() => (window as any).editor.setMode('live'));
  await expectLabels(['5', '7', '8']);
  await page.evaluate(() => (window as any).editor.destroy());
  console.log('Table gutter: bounded row measurements, aligned and stable labels, resize, structure/history and line-number modes passed', JSON.stringify(samples));
} catch (error) { primary = error; throw error; }
finally {
  if (primary === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primary);
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('meo-table-gutter-budget-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
