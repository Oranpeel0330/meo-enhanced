import assert from 'node:assert/strict';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { browser, server, open, frames, captureResult } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { captureHistoryInteraction, assertHistoryRoundTrip, assertHistoryCoverage } from './history-interaction-contract';

type Range = { anchor: number; head: number };

const witness = { witness: 'HISTORY_WITNESS' };
const prefix = '# Before\n\n' + 'Earlier paragraph.\n\n'.repeat(55) + '## HISTORY_WITNESS\n\n';
const suffix = '\n\nAfter.\n\n'.repeat(30);
const body = 'alpha beta';
const multiRanges: Range[] = [{ anchor: 5, head: 0 }, { anchor: 6, head: 10 }];
const receipts = [
  'clipboard/source/html-paste',
  'clipboard/live/multi-paste',
  'clipboard/source/multi-cut',
  'clipboard/live/optimized-paste-options'
];
const completed: string[] = [];
let failure: unknown;

async function setRanges(page: any, ranges: Range[], mainIndex: number): Promise<void> {
  await page.evaluate(({ ranges, mainIndex }) => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const Selection = view.state.selection.constructor;
    view.dispatch({ selection: Selection.create(ranges.map((range: any) => Selection.range(range.anchor, range.head)), mainIndex), scrollIntoView: true });
    view.focus();
  }, { ranges, mainIndex });
}

async function centerSelection(page: any): Promise<void> {
  await page.evaluate(() => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const caret = view.coordsAtPos(view.state.selection.main.head);
    const bounds = view.scrollDOM.getBoundingClientRect();
    if (caret) view.scrollDOM.scrollTop += caret.top - bounds.top - bounds.height / 2;
  });
  await frames(page, 4);
}

async function dispatchClipboard(page: any, type: 'paste' | 'cut', plain: string, html?: string): Promise<void> {
  await page.evaluate(({ type, plain, html }) => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', plain);
    if (html !== undefined) clipboard.setData('text/html', html);
    view.contentDOM.dispatchEvent(new ClipboardEvent(type, { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, { type, plain, html });
}

async function enableHtmlPaste(page: any): Promise<void> {
  await page.evaluate(preferences => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'editingPreferencesChanged', preferences: { input: preferences, shortcuts: {} }, revision: 1
    } }));
  }, { ...defaultInputAssistance, pasteHtml: true });
  await frames(page, 4);
}

async function assertLivePasteAtScrollEnd(large: boolean): Promise<void> {
  const original = 'Earlier paragraph.\n\n'.repeat(large ? 8_200 : 100) + 'Before paste witness\n\n';
  assert.equal(assessLargeDocument(original).boundedEditorWork, large);
  const tableText = '\n\n| Pasted witness | Value |\n| --- | --- |\n| Text | More |\n';
  const page = await browser.newPage();
  const host = await open(page, original, false, 'live', { scrollBeyondLastLine: true });
  try {
    await page.setViewport({ width: 1050, height: 560 });
    await setRanges(page, [{ anchor: original.length, head: original.length }], 0);
    await frames(page, 8);
    const point = await page.$eval('.editor-host .cm-scroller', element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 90, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({ deltaY: 1_000_000 });
    await frames(page, 10);
    const read = () => page.evaluate(() => {
      const content = document.querySelector('.editor-host .cm-content')!;
      const view = (content as any).cmTile.root.view;
      const scroll = view.scrollDOM as HTMLElement;
      const top = scroll.getBoundingClientRect().top;
      const caret = view.coordsAtPos(view.state.selection.main.head);
      const witness = [...content.querySelectorAll('.cm-line')].find(line => line.textContent === 'Before paste witness');
      const table = [...content.querySelectorAll('table')].find(el => el.textContent?.includes('Pasted witness'));
      return { top: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight, height: scroll.clientHeight,
        lineHeight: view.defaultLineHeight as number, head: view.state.selection.main.head as number,
        witnessY: witness ? witness.getBoundingClientRect().top - top : null,
        tableTop: table ? table.getBoundingClientRect().top - top : null,
        tableBottom: table ? table.getBoundingClientRect().bottom - top : null,
        caretTop: caret ? caret.top - top as number : null, caretBottom: caret ? caret.bottom - top as number : null };
    });
    const before = await read();
    assert.ok(Math.abs(before.top - before.max) <= 1 && before.caretTop !== null && before.caretTop >= 0
      && before.caretBottom !== null && before.caretBottom <= before.height);
    await dispatchClipboard(page, 'paste', tableText);
    await page.waitForFunction(() => [...document.querySelectorAll('.editor-host table')]
      .some(table => table.textContent?.includes('Pasted witness')));
    await frames(page, 12);
    const after = await read();
    assert.ok(before.witnessY !== null && after.witnessY !== null && Math.abs(before.witnessY - after.witnessY) <= 1
      && after.tableTop !== null && after.tableTop >= before.caretTop - 1
      && after.tableBottom !== null && after.caretBottom !== null && after.tableBottom <= after.caretBottom
      && after.caretBottom <= after.height, `A table pasted at the scroll limit must grow below the old content: ${JSON.stringify({ before, after })}`);
    assert.equal(after.head, original.length + tableText.length);

    const tallText = '\n\n' + 'More pasted text.\n\n'.repeat(45) + 'End of the paste.';
    await dispatchClipboard(page, 'paste', tallText);
    await frames(page, 12);
    const tall = await read();
    assert.ok(tall.caretTop !== null && tall.caretTop >= 0 && tall.caretBottom !== null
      && tall.caretBottom <= tall.height + 1 && tall.height - tall.caretBottom < 3 * tall.lineHeight,
      `A paste taller than the remaining space should reveal its caret near the bottom: ${JSON.stringify(tall)}`);
    assert.equal(tall.head, original.length + tableText.length + tallText.length);
    assert.equal(host.readHost(), original + tableText + tallText);
    assert.deepEqual(host.errors, []);
    console.log(`Live clipboard paste stays below the existing content at the scroll limit (${large ? 'optimized' : 'ordinary'})`);
  } finally { host.dispose(); await page.close(); }
}

try {
  await assertLivePasteAtScrollEnd(false);
  await assertLivePasteAtScrollEnd(true);
  {
    const id = receipts[0]!;
    const original = prefix + 'left word right' + suffix;
    const afterText = prefix + 'left **bold** right' + suffix;
    const page = await browser.newPage();
    const host = await open(page, original, false, 'source');
    try {
      await enableHtmlPaste(page);
      await setRanges(page, [{ anchor: prefix.length + 9, head: prefix.length + 5 }], 0);
      await centerSelection(page);
      const before = await captureHistoryInteraction(page, witness);
      assert.deepEqual(before.ranges, [{ anchor: prefix.length + 9, head: prefix.length + 5 }], id + ': initial backward selection');
      assert.equal(before.mainIndex, 0, id + ': initial primary range');
      await dispatchClipboard(page, 'paste', 'bold', '<strong>bold</strong>');
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, witness);
      assert.equal(after.text, afterText, id + ': exact HTML paste');
      assert.deepEqual(after.ranges, [{ anchor: prefix.length + 13, head: prefix.length + 13 }], id + ': folded caret');
      assert.equal(after.mainIndex, 0, id + ': primary range after paste');
      assert.equal(host.readHost(), afterText, id + ': host text');
      await assertHistoryRoundTrip(page, { ...witness, label: id, before, after });
      await page.keyboard.type('Q');
      await frames(page, 8);
      assert.equal(host.readHost(), prefix + 'left **bold**Q right' + suffix, id + ': input after redo lands at caret');
      completed.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }

  {
    const id = receipts[1]!;
    const original = prefix + body + '\n\n' + 'Padding.\n'.repeat(8100);
    const afterText = prefix + 'Z Z' + '\n\n' + 'Padding.\n'.repeat(8100);
    assert.equal(assessLargeDocument(original).boundedEditorWork, true, id + ': production optimized-document policy');
    const page = await browser.newPage();
    const host = await open(page, original, false, 'live');
    try {
      await setRanges(page, multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length })), 1);
      await centerSelection(page);
      const before = await captureHistoryInteraction(page, witness);
      const expectedBefore = multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length }));
      assert.deepEqual(before.ranges, expectedBefore, id + ': initial multi-selection');
      assert.equal(before.mainIndex, 1, id + ': initial primary range');
      await dispatchClipboard(page, 'paste', 'Z');
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, witness);
      assert.equal(after.text, afterText, id + ': exact literal paste');
      assert.deepEqual(after.ranges, [{ anchor: prefix.length + 1, head: prefix.length + 1 }, { anchor: prefix.length + 3, head: prefix.length + 3 }], id + ': folded multi-caret');
      assert.equal(after.mainIndex, 1, id + ': primary range after paste');
      assert.equal(host.readHost(), afterText, id + ': host text');
      await assertHistoryRoundTrip(page, { ...witness, label: id, before, after });
      completed.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }

  {
    const id = receipts[2]!;
    const original = prefix + body + suffix;
    const afterText = prefix + ' ' + suffix;
    const page = await browser.newPage();
    const host = await open(page, original, false, 'source');
    try {
      await setRanges(page, multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length })), 1);
      await centerSelection(page);
      const before = await captureHistoryInteraction(page, witness);
      const expectedBefore = multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length }));
      assert.deepEqual(before.ranges, expectedBefore, id + ': initial multi-selection');
      assert.equal(before.mainIndex, 1, id + ': initial primary range');
      await dispatchClipboard(page, 'cut', '');
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, witness);
      assert.equal(after.text, afterText, id + ': exact multi-selection cut');
      assert.deepEqual(after.ranges, [{ anchor: prefix.length, head: prefix.length }, { anchor: prefix.length + 1, head: prefix.length + 1 }], id + ': folded multi-caret');
      assert.equal(after.mainIndex, 1, id + ': primary range after cut');
      assert.equal(host.readHost(), afterText, id + ': host text');
      await assertHistoryRoundTrip(page, { ...witness, label: id, before, after });
      completed.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }
  {
    const id = receipts[3]!;
    const tail = '\n\n' + 'Long document padding.\n'.repeat(8200);
    const original = prefix + 'left word right' + tail;
    const afterText = prefix + 'left bold right' + tail;
    assert.equal(assessLargeDocument(original).boundedEditorWork, true, id + ': production optimized-document policy');
    const page = await browser.newPage();
    const host = await open(page, original, false, 'live');
    try {
      await enableHtmlPaste(page);
      await setRanges(page, [{ anchor: prefix.length + 9, head: prefix.length + 5 }], 0);
      await centerSelection(page);
      const before = await captureHistoryInteraction(page, witness);
      assert.deepEqual(before.ranges, [{ anchor: prefix.length + 9, head: prefix.length + 5 }]);
      await dispatchClipboard(page, 'paste', 'bold', '<strong>bold</strong>');
      await frames(page, 4);
      assert.equal(host.readHost(), prefix + 'left **bold** right' + tail, id + ': initial formatted paste reached the host');
      await page.waitForSelector('.meo-paste-options-trigger', { visible: true });
      await page.keyboard.press('Control');
      await page.waitForSelector('.meo-paste-options-menu [data-paste-mode="plain"]', { visible: true });
      await captureResult(page, 'paste-options-dark-en');
      await Bun.sleep(650);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, witness);
      assert.equal(after.text, afterText, id + ': exact final text');
      assert.deepEqual(after.ranges, [{ anchor: prefix.length + 9, head: prefix.length + 9 }]);
      assert.equal(host.readHost(), afterText, id + ': host text');
      await assertHistoryRoundTrip(page, { ...witness, label: id, before, after });
      await page.keyboard.type('Q');
      await frames(page, 8);
      assert.equal(host.readHost(), prefix + 'left boldQ right' + tail, id + ': input after redo lands at caret');
      completed.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }
  assertHistoryCoverage(receipts);
  console.log(`Production clipboard history passed: ${completed.length} cases; DOM clipboard conversion, multi-selection paste/cut, and undo/redo contracts covered`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  server.stop(true);
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
}
