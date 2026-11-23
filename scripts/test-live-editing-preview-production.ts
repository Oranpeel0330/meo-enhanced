import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { browser, server, open, frames, captureResult, assertStablePaint } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { emptyMarkdownTable } from '../webview/src/application/delimitedTable';

// Native input and the production Workers/renderers must make preview progress
// during typing, rather than waiting for the full-document quiet window.
type Kind = 'mermaid' | 'html' | 'math';
const cases: Array<{ kind: Kind; name: string; block: string; layout?: string; latex?: boolean }> = [
  ...['stacked', 'side-by-side'].map(layout => ({ kind: 'mermaid' as const, name: `mermaid/${layout}`, layout,
    block: '```mermaid\nflowchart LR\nA[Seed42] --> B[End]\n```' })),
  { kind: 'html', name: 'html', block: '<div id="editing-preview-probe">Seed42</div>' },
  { kind: 'math', name: 'math/dollars', block: '$$\nx=42\n$$' },
  { kind: 'math', name: 'math/latex', block: '\\[\nx=42\n\\]', latex: true },
  { kind: 'math', name: 'math/fence', block: '```math\nx=42\n```' }
];

type EndInsertion = { slash?: string; query?: string; markdown: string; pasteImage?: boolean; keyboard?: boolean; toolbarCode?: boolean };
const toolbarTable: EndInsertion = { markdown: emptyMarkdownTable(3, 3)! };
const slashTable: EndInsertion = { slash: 'table', query: 'table', markdown: emptyMarkdownTable()! };
const definition: EndInsertion = { slash: 'definition', query: 'definition', markdown: '<dl>\n<dt>Term</dt>\n<dd>Definition</dd>\n</dl>' };
const endInsertions: readonly [boolean, EndInsertion][] = [
  [false, slashTable], [false, definition],
  [true, { slash: 'codeBlock', query: 'code', markdown: '```\n\n```' }],
  [true, { slash: 'blockMath', query: 'equation', markdown: '$$\n\n$$', keyboard: true }],
  [true, { toolbarCode: true, markdown: '```\n\n```' }],
  [false, { slash: 'image', query: 'image', markdown: '![alt](url)' }],
  [true, { pasteImage: true, markdown: '![test.png](test.png)' }]
];

const tableExitPrefix = ('## A section\n\nParagraph with **bold**, `code`, and a [link](#a-section).\n\n'
  + '| Heading | Value |\n| --- | --- |\n' + '| **one** | <br> two |\n'.repeat(8) + '\n'
  + '```js\n' + 'const value = '.repeat(32) + '1;\n```\n\n$$\n\\sum_{k=1}^N k\n$$\n\n'
  + '> Quoted content\n> on two lines.\n\n<div><p>HTML content</p></div>\n\n').repeat(130);

async function checkTableInsertionPaint(atEnd: boolean, fromSlash: boolean, insideInline = false): Promise<void> {
  const label = `live-table-insertion-${atEnd ? 'end' : 'middle'}-${fromSlash ? 'slash' : 'toolbar'}${insideInline ? '-nested-link' : ''}`;
  const witness = 'Reading witness before table';
  const prefix = tableExitPrefix + witness
    + '. Styled **bold** words keep this paint witness visible. More text on this row.\n\n';
  const suffix = atEnd ? '' : '\n\nFollowing witness\n\n' + 'An ordinary **styled** line with text.\n\n'.repeat(45);
  const inline = insideInline ? 'Paragraph before [**nested** link](#a-section)' : '';
  const rest = insideInline ? ' after.' : '';
  const expected = prefix + (insideInline ? inline + '\n\n' : '')
    + (fromSlash ? slashTable : toolbarTable).markdown + (insideInline ? '\n\n' + rest : '') + suffix;
  const page = await browser.newPage();
  const host = await open(page, prefix + inline + rest + suffix, false, 'live', { scrollBeyondLastLine: true });
  try {
    await page.setViewport({ width: 1200, height: 635 });
    await page.$eval('.editor-host .cm-content', (content, anchor) => {
      const view = (content as any).cmTile.root.view;
      view.dispatch({ selection: { anchor }, effects: view.constructor.scrollIntoView(anchor, { y: 'center' }) });
      view.focus();
    }, prefix.length + (insideInline ? inline.indexOf('nested') + 3 : 0));
    await frames(page, 16);
    if (atEnd) {
      await page.hover('.editor-host > .cm-editor > .cm-scroller');
      await page.mouse.wheel({ deltaY: 500_000 });
      await frames(page, 10);
      await page.mouse.wheel({ deltaY: -85 });
      await frames(page, 10);
    }
    const button = '.table-wrapper > .format-button';
    const openTableGrid = async () => {
      await page.hover(button);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.table-dropdown-wrapper')!).opacity === '1');
    };
    if (fromSlash) {
      await page.keyboard.type('/table');
      await page.waitForSelector('.meo-input-suggestions:not([hidden]) [data-command="table"]');
      await frames(page, 6);
    } else await openTableGrid();
    const clip = await page.$eval('.editor-host .cm-content', (content, witness) => {
      const row = [...content.querySelectorAll<HTMLElement>('.cm-line')].find(entry => entry.textContent?.startsWith(witness));
      if (!row?.querySelector('.meo-md-strong')) throw new Error('Missing rendered text witness');
      const rect = row.getBoundingClientRect();
      const grid = document.querySelector('.table-dropdown')!.getBoundingClientRect();
      const left = Math.ceil(Math.max(rect.left + 6, grid.right + 10));
      return { left, top: Math.ceil(rect.top), width: 310, height: Math.floor(rect.bottom) - Math.ceil(rect.top) };
    }, witness);
    await assertStablePaint(page, clip, async () => {
      await page.$eval('.editor-host .cm-content', (content, witness) => {
        const scope = window as any;
        const view = (content as any).cmTile.root.view;
        const before = view.state.doc;
        const row = () => [...content.querySelectorAll('.cm-line')].find(entry => entry.textContent?.startsWith(witness));
        const original = row();
        scope.__presentationFrames = [];
        const sample = () => setTimeout(() => {
          const input = document.activeElement;
          if (view.state.doc !== before) scope.__presentationFrames.push({
            rendered: Boolean(row()?.querySelector('.meo-md-strong')),
            retained: row() === original,
            firstCell: input instanceof HTMLTextAreaElement && input.dataset.tableRow === '0'
              && input.dataset.tableCol === '0' && input.selectionStart === 0 && input.selectionEnd === 0
          });
          scope.tableInsertionFrame = requestAnimationFrame(sample);
        }, 0);
        scope.tableInsertionFrame = requestAnimationFrame(sample);
      }, witness);
      if (fromSlash) await page.keyboard.press('Enter');
      else {
        await openTableGrid();
        await page.click(button);
        await page.click('.table-grid-cell[data-row="3"][data-col="3"]');
      }
    }, label);
    const samples = await page.evaluate(() => {
      const scope = window as any;
      cancelAnimationFrame(scope.tableInsertionFrame);
      return scope.__presentationFrames as { rendered: boolean; retained: boolean; firstCell: boolean }[];
    });
    assert.ok(samples.length > 0 && samples.every(sample => sample.rendered && sample.retained && sample.firstCell),
      `${label}: retain the unchanged line and focus the first cell from the first frame ${JSON.stringify(samples.slice(0, 5))}`);
    assert.equal(host.readHost(), expected);
    assert.deepEqual(host.errors, []);
    console.log(`${label}: uninterrupted paint and first-cell focus through ${samples.length} frames`);
  } finally { host.dispose(); await page.close(); }
}

async function checkLastTableCellKey(page: Page, expected: string, key: 'Enter' | 'ArrowDown' | 'Tab', draft?: string): Promise<void> {
  const last = '.editor-host .meo-md-html-table-shell tbody textarea[data-table-row="3"][data-table-col="2"]';
  await (await page.$$(last)).at(-1)!.click();
  await page.waitForFunction(last => document.activeElement === [...document.querySelectorAll(last)].at(-1), {}, last);
  if (draft) {
    const [first, second] = draft.split('\n');
    await page.keyboard.type(first);
    if (second !== undefined) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.keyboard.type(second);
    }
  }
  const before = await page.evaluate(() => {
    const content = document.querySelector('.editor-host .cm-content')!;
    const view = (content as any).cmTile.root.view;
    const shell = [...content.querySelectorAll<HTMLElement>('.meo-md-html-table-shell')].at(-1)!;
    const start = Number(shell.dataset.meoRenderedBlockStartLine);
    const gutter = view.scrollDOM.querySelector(':scope > .cm-gutters > .cm-lineNumbers') as HTMLElement;
    const read = () => {
      const table = content.querySelector(`.meo-md-html-table-shell[data-meo-rendered-block-start-line="${start}"]`);
      const rows = [...table?.querySelectorAll<HTMLTableRowElement>('tr[data-source-line-number]') ?? []];
      const labels = [...gutter.querySelectorAll<HTMLElement>('.meo-md-html-table-line-number')];
      const rendered = labels.filter(label => {
        const number = Number(label.textContent);
        return number >= start && number <= start + 5;
      }).map(label => ({ line: Number(label.textContent), top: label.getBoundingClientRect().top }));
      const offset = parseFloat(getComputedStyle(gutter).fontSize) * .25;
      return {
        top: table?.getBoundingClientRect().top ?? null,
        lines: rendered.map(label => label.line),
        aligned: rows.every(row => {
          const matches = rendered.filter(label => label.line === Number(row.dataset.sourceLineNumber));
          return matches.length === 1 && Math.abs(matches[0].top - offset - row.getBoundingClientRect().top) <= 1;
        }),
        bodyNumber: view.state.doc.lines === start + 5 && [...gutter.querySelectorAll(':scope > .cm-gutterElement')]
          .some(label => label.textContent === String(start + 5) && getComputedStyle(label).visibility === 'visible'),
        linesInDocument: view.state.doc.lines,
        firstLabel: labels.find(label => label.textContent === String(start))
      };
    };
    const initial = read();
    const sample = { frames: [] as Array<Omit<ReturnType<typeof read>, 'firstLabel'> & { retained: boolean }>, id: 0, timer: 0 };
    const measure = () => {
      sample.timer = window.setTimeout(() => {
        const { firstLabel, ...frame } = read();
        sample.frames.push({ ...frame, retained: firstLabel === initial.firstLabel });
      }, 0);
      sample.id = requestAnimationFrame(measure);
    };
    sample.id = requestAnimationFrame(measure);
    (window as any).tableExitSample = sample;
    return { start, top: initial.top, linesInDocument: initial.linesInDocument };
  });
  await page.keyboard.press(key);
  await frames(page, 26);
  const after = await page.evaluate(({ expected, key }) => {
    const content = document.querySelector('.editor-host .cm-content')!;
    const view = (content as any).cmTile.root.view;
    const { id, timer, frames } = (window as any).tableExitSample;
    cancelAnimationFrame(id);
    clearTimeout(timer);
    const active = document.activeElement;
    const newRow = key === 'Tab' && active instanceof HTMLTextAreaElement
      && active.dataset.tableRow === '4' && active.dataset.tableCol === '0';
    const caret = newRow ? active.getBoundingClientRect() : view.coordsAtPos(view.state.selection.main.head);
    const viewport = view.scrollDOM.getBoundingClientRect();
    return { frames: frames as Array<{ top: number | null; lines: number[]; aligned: boolean; bodyNumber: boolean; linesInDocument: number; retained: boolean }>,
      correctTarget: key === 'Tab' ? newRow : active === content && view.state.selection.main.head === view.state.doc.length,
      correctText: view.state.doc.toString().endsWith(expected),
      caretVisible: !!caret && caret.top >= viewport.top - 1 && caret.bottom <= viewport.bottom + 1 };
  }, { expected, key });
  assert.ok(after.correctText && after.correctTarget && after.caretVisible,
    `${key} must continue at the adjacent editing target: ${JSON.stringify({ before, after })}`);
  const top = before.top;
  assert.ok(top !== null && after.frames.length > 0 && after.frames.every(({ top: y }) => y !== null && Math.abs(y - top) <= 1.5),
    `The table must stay painted at the same position during ${key}: ${JSON.stringify({ before, after })}`);
  const { start } = before;
  const wrongFrames = after.frames.filter(frame => {
    const added = frame.linesInDocument > before.linesInDocument;
    const expectedLines = key === 'Tab' && added ? [start, start + 2, start + 3, start + 4, start + 5]
      : [start, start + 2, start + 3, start + 4];
    return !frame.aligned || !frame.retained || String(frame.lines) !== String(expectedLines)
      || key !== 'Tab' && frame.linesInDocument === start + 5 && !frame.bodyNumber;
  });
  assert.ok(wrongFrames.length === 0,
    `Every frame must retain and align the latest line numbers during ${key}: ${JSON.stringify(wrongFrames.slice(0, 3))}`);
}

async function insertAtScrollEnd(large: boolean, test = toolbarTable, nearViewportBottom = false, scrollBeyondLastLine = true,
  tableBoundary?: 'blank-exit' | 'exit' | 'append-row'): Promise<void> {
  const table = test === toolbarTable || test === slashTable;
  const addBlankLines = test.toolbarCode || test === toolbarTable && nearViewportBottom;
  const text = (tableBoundary ? tableExitPrefix : 'Paragraph with **bold** text.\n\n'.repeat(large ? 8_200 : 100))
    + 'End insertion witness' + (test.toolbarCode ? '\n\n## End **heading**' : addBlankLines ? '' : '\n\n');
  assert.equal(assessLargeDocument(text).boundedEditorWork, large);
  const page = await browser.newPage();
  const host = await open(page, text, false, 'live', {
    scrollBeyondLastLine, uiLanguage: 'zh-CN', outlineVisible: tableBoundary === 'blank-exit',
    saveClipboardImage: () => ({ path: 'test.png', fileName: 'test.png' }),
    resolveImageSrc: async () => {
      if (test.pasteImage) await Bun.sleep(650);
      return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"/>');
    }
  });
  try {
    await page.setViewport({ width: 1180, height: 610 });
    await page.$eval('.editor-host .cm-content', (content, insideHeading) => {
      const view = (content as any).cmTile.root.view;
      view.dispatch({ selection: { anchor: view.state.doc.length - (insideHeading ? 5 : 0) }, scrollIntoView: true });
      view.focus();
    }, !!test.toolbarCode);
    await frames(page, 10);
    const point = await page.$eval('.editor-host .cm-scroller', element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 75, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({ deltaY: 1_000_000 });
    await frames(page, 10);
    if (test.toolbarCode) {
      // Keep the existing paragraph visible above the last heading.
      await page.$eval('.editor-host .cm-content', (content, anchor) => {
        const view = (content as any).cmTile.root.view;
        view.dispatch({ effects: view.constructor.scrollIntoView(anchor, { y: 'start', yMargin: 40 }) });
      }, text.lastIndexOf('End insertion witness'));
      await frames(page, 10);
    }
    if (nearViewportBottom) {
      const deltaY = await page.$eval('.editor-host .cm-content', content => {
        const view = (content as any).cmTile.root.view;
        return view.coordsAtPos(view.state.doc.length).bottom - view.scrollDOM.getBoundingClientRect().bottom + 6;
      });
      await page.mouse.wheel({ deltaY });
      await frames(page, 10);
    }
    const suggestion = `.meo-input-suggestions:not([hidden]) [data-command="${test.slash}"]`;
    if (test.slash) {
      await page.keyboard.type('/' + test.query);
      await page.waitForSelector(suggestion);
      await frames(page, 6);
    }
    const tableLine = text.split('\n').length + (addBlankLines ? 2 : 0);
    const read = (observe = false) => page.evaluate(({ observe, tableLine }) => {
      const content = document.querySelector('.editor-host .cm-content')!;
      const scroll = content.parentElement!;
      const viewport = scroll.getBoundingClientRect();
      const witnessY = () => {
        const witness = [...content.querySelectorAll('.cm-line')].find(line => line.textContent === 'End insertion witness');
        return witness ? witness.getBoundingClientRect().top - viewport.top : null;
      };
      const shell = content.querySelector(`.meo-md-html-table-shell[data-meo-rendered-block-start-line="${tableLine}"]`);
      const table = shell?.getBoundingClientRect();
      const input = shell?.querySelector<HTMLTextAreaElement>('.meo-md-html-table thead textarea');
      const view = (content as any).cmTile.root.view;
      const caret = input?.getBoundingClientRect() ?? view.coordsAtPos(view.state.selection.main.head);
      const windowState = window as Window & { endInsertionFrames?: { id: number; positions: Array<number | null> } };
      if (observe) {
        const before = view.state.doc;
        const sample = () => {
          if (view.state.doc !== before) observation.positions.push(witnessY());
          observation.id = requestAnimationFrame(sample);
        };
        const observation = { id: requestAnimationFrame(sample), positions: [] as Array<number | null> };
        windowState.endInsertionFrames = observation;
      } else if (windowState.endInsertionFrames) cancelAnimationFrame(windowState.endInsertionFrames.id);
      return { scrollTop: scroll.scrollTop, max: scroll.scrollHeight - scroll.clientHeight,
        height: scroll.clientHeight, witnessY: witnessY(), positions: windowState.endInsertionFrames?.positions ?? [],
        tableTop: table ? table.top - viewport.top : null, tableBottom: table ? table.bottom - viewport.top : null,
        caretTop: caret ? caret.top - viewport.top : null, caretBottom: caret ? caret.bottom - viewport.top : null,
        focused: document.activeElement === (input ?? content),
        firstCellCaret: input && input.selectionStart === 0 && input.selectionEnd === 0 };
    }, { observe, tableLine });
    const before = await read(!nearViewportBottom);
    assert.ok(before.witnessY !== null);
    if (test.toolbarCode) assert.ok(before.witnessY >= 0);
    else if (!nearViewportBottom) assert.ok(Math.abs(before.max - before.scrollTop) <= 1);
    if (test.slash) {
      if (test.keyboard) await page.keyboard.press('Enter');
      else await page.click(suggestion);
    } else if (test.pasteImage) {
      await page.evaluate(() => {
        const clipboard = new DataTransfer();
        clipboard.items.add(new File(['clipboard image'], 'test.png', { type: 'image/png' }));
        document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.cm-content img')]
        .some(image => image.complete && image.naturalWidth === 240));
    } else if (test.toolbarCode) {
      await page.click('.format-button[data-action="codeBlock"]');
    } else {
      await page.hover('.table-wrapper > .format-button');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.table-dropdown-wrapper')!).opacity === '1');
      await page.click('.table-wrapper > .format-button');
      await page.click('.table-grid-cell[data-row="3"][data-col="3"]');
    }
    await frames(page, 16);
    const after = await read();
    assert.equal(host.readHost(), text + (addBlankLines ? '\n\n' : '') + test.markdown);
    const details = JSON.stringify({ before, after });
    assert.ok(after.focused, `Insertion should return focus to the edit target: ${details}`);
    if (nearViewportBottom) {
      assert.ok(after.witnessY !== null && after.witnessY < before.witnessY && after.caretBottom !== null
        && Math.abs(after.height - after.caretBottom) <= 1, `Scroll just enough to show the edit target: ${details}`);
    } else {
      const oldY = before.witnessY;
      const tolerance = tableBoundary ? 1.5 : 1;
      assert.ok(after.positions.length > 0 && [after.witnessY, ...after.positions].every(y => y !== null && Math.abs(y - oldY) <= tolerance),
        `Keep the existing text in place through every observed frame: ${details}`);
      if (table && scrollBeyondLastLine) assert.ok(after.tableTop !== null && after.tableTop >= 0 && after.tableBottom !== null && after.tableBottom <= after.height);
    }
    assert.ok(after.caretTop !== null && after.caretTop >= 0 && after.caretBottom !== null && after.caretBottom <= after.height + 1,
      `Keep the edit target visible: ${details}`);
    if (table) {
      assert.ok(after.firstCellCaret, `A new table starts with the caret at the beginning of its first header cell: ${details}`);
      if (tableBoundary === 'blank-exit') {
        const expectedExit = test.markdown + '\n';
        await checkLastTableCellKey(page, expectedExit, 'Enter');
        assert.ok(host.readHost().endsWith(expectedExit));
        assert.deepEqual(host.errors, []);
        return;
      }
      const editedTable = test.markdown.replace('|  |', '| First cell |');
      await page.keyboard.type('First cell');
      await page.waitForFunction(expected => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view
        .state.doc.toString().endsWith(expected), {}, editedTable);
      if (tableBoundary === 'exit') {
        const pendingCell = 'Draft';
        const expectedExit = editedTable.slice(0, -2) + pendingCell + ' |\n';
        await checkLastTableCellKey(page, expectedExit, 'Enter', pendingCell);
        await checkLastTableCellKey(page, expectedExit, 'ArrowDown');
        assert.ok(host.readHost().endsWith(expectedExit));
        console.log('Last-cell Enter and ArrowDown preserve the table and continue in prose');
      } else if (tableBoundary === 'append-row' && await page.evaluate(() => navigator.platform.startsWith('Win'))) {
        const expectedRow = editedTable.slice(0, -2) + 'First line<br>Second line |\n|  |  |  |';
        await checkLastTableCellKey(page, expectedRow, 'Tab', 'First line\nSecond line');
        assert.ok(host.readHost().endsWith(expectedRow));
        console.log('Last-cell Tab preserves the table and focuses the appended row');
      }
    }
    assert.deepEqual(host.errors, []);
    const fixture = nearViewportBottom ? 'near viewport bottom' : large ? 'optimized' : 'ordinary';
    console.log(`${test.slash ? '/' + test.slash : test.pasteImage ? 'Pasted image' : test.toolbarCode ? 'Toolbar code block after heading' : 'Toolbar table'} stays at the document end (${fixture})`);
  } finally { host.dispose(); await page.close(); }
}

async function checkOpeningFenceCaret(): Promise<void> {
  const page = await browser.newPage();
  const text = 'Before the code block.\n\n```js\n' + '55555'.repeat(80) + '\n```';
  const host = await open(page, text, false, 'live');
  try {
    const fenceEnd = text.indexOf('```js') + '```js'.length;
    await page.$eval('.editor-host .cm-content', (element, fenceEnd) => {
      const view = (element as any).cmTile.root.view;
      view.dispatch({ selection: { anchor: fenceEnd } });
      view.focus();
    }, fenceEnd);
    await frames(page, 6);
    const caret = await page.evaluate(() => {
      const line = document.querySelector('.cm-line.meo-md-code-block-start')!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let language = walker.nextNode();
      while (language && language.textContent !== 'js') language = walker.nextNode();
      if (!language) return null;
      const text = document.createRange();
      text.selectNodeContents(language);
      const cursor = document.querySelector('.editor-host .cm-cursor-primary')?.getBoundingClientRect();
      const actions = line.querySelector('.meo-code-block-actions')?.getBoundingClientRect();
      return { textEnd: text.getBoundingClientRect().right, cursor: cursor?.left, actions: actions?.left };
    });
    assert.ok(caret && caret.cursor !== undefined && caret.actions !== undefined
      && Math.abs(caret.cursor - caret.textEnd) <= 1 && caret.actions > caret.cursor + 40,
      `The Live fence caret is drawn beside its editable text: ${JSON.stringify(caret)}`);
    console.log('The Live opening fence caret stays next to the fence text');
  } finally { host.dispose(); await page.close(); }
}

try {
  const paintOnly = process.argv.includes('--table-insertion-paint-only');
  const tableExitOnly = process.argv.includes('--table-exit-only');
  if (!tableExitOnly) {
    for (const atEnd of [false, true]) for (const fromSlash of [false, true]) await checkTableInsertionPaint(atEnd, fromSlash);
    await checkTableInsertionPaint(false, false, true);
    await checkTableInsertionPaint(true, true, true);
  }
  if (!paintOnly) {
    await insertAtScrollEnd(true, toolbarTable, false, true, 'blank-exit');
    await insertAtScrollEnd(true, toolbarTable, false, true, 'exit');
    await insertAtScrollEnd(true, toolbarTable, false, true, 'append-row');
  }
  if (!paintOnly && !tableExitOnly) {
    for (const large of [false, true]) await insertAtScrollEnd(large);
    await insertAtScrollEnd(false, toolbarTable, true);
    await insertAtScrollEnd(true, toolbarTable, false, false);
  }
  if (!paintOnly && !tableExitOnly && !process.argv.includes('--table-insertion-only')) {
    await checkOpeningFenceCaret();
    for (const [large, test] of endInsertions) await insertAtScrollEnd(large, test);
    await insertAtScrollEnd(false, definition, true);
  }
  const insertionsOnly = paintOnly || tableExitOnly || process.argv.includes('--table-insertion-only') || process.argv.includes('--end-insertion-only');
  for (const large of [false, true]) for (const test of insertionsOnly ? [] : cases) {
    const { kind, block } = test, label = `${test.name}/${large ? 'large' : 'ordinary'}`;
    const marker = kind === 'math' ? '42' : 'Seed42';
    const text = (large ? 'Reading paragraph.\n\n'.repeat(800) : '') + 'Before\n\n' + block + '\n\nAfter\n\n'
      + (large ? 'Background paragraph.\n\n'.repeat(1200)
        + ('## Rich tail\n\n| Name | Value |\n| --- | --- |\n| **A** | `value` |\n\n```ts\nconst value = 1;\n```\n\n$$\ny=2\n$$\n\n').repeat(8) : '');
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, `${label}: fixture must select the production work budget`);
    const page = await browser.newPage(), host = await open(page, text, false, 'live', { latexDelimiters: test.latex });
    page.on('console', message => { if (message.type() === 'error') host.errors.push(message.text()); });
    try {
      if (large) {
        await page.evaluate(block => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.toString().indexOf(block), { y: 'start', yMargin: 80 }) });
        }, block);
        await frames(page, 12);
      }
      const reading = kind === 'mermaid' ? '.meo-mermaid-block svg' : kind === 'html' ? '#editing-preview-probe' : '.meo-md-math-fenced-display .katex';
      await page.waitForSelector(reading);
      await page.click(kind === 'mermaid' ? '.meo-mermaid-mode-btn' : reading);
      if (test.layout) {
        const side = await page.evaluate(() => !!document.querySelector('.meo-mermaid-inline-preview:not([hidden])'));
        if (side !== (test.layout === 'side-by-side')) await page.click('.meo-mermaid-editing-preview .meo-mermaid-layout-btn');
        await page.waitForFunction(side => !!document.querySelector('.meo-mermaid-inline-preview:not([hidden])') === side,
          {}, test.layout === 'side-by-side');
      }
      const selector = kind === 'mermaid' ? '.meo-mermaid-editing-preview .meo-mermaid-svg-wrapper'
        : kind === 'html' ? '.meo-md-html-live-result' : '.meo-math-live-result .katex-html';
      await page.waitForFunction(({ selector, marker }) => document.querySelector(selector)?.textContent?.includes(marker), {}, { selector, marker });
      await frames(page, 8);
      await page.evaluate(({ marker, selector }) => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(marker) + marker.length } });
        view.focus();
        const observation = (window as any).editingPreviewProbe = { accepted: marker, inputs: [] as any[], paints: [] as any[] };
        document.addEventListener('input', event => {
          const input = event as InputEvent;
          if (!(input.target as Element)?.closest('.cm-content') || !input.data) return;
          observation.accepted += input.data;
          observation.inputs.push({ value: observation.accepted, time: performance.now(), trusted: input.isTrusted });
        }, true);
        const observer = new MutationObserver(() => {
          const value = document.querySelector(selector)?.textContent?.match(new RegExp(marker + '[0-9]*'))?.[0];
          const input = observation.inputs.find((entry: any) => entry.value === value);
          if (!input || observation.paints.some((entry: any) => entry.value === value)) return;
          const record = { value, input: input.time, dom: performance.now(), frame: 0 };
          observation.paints.push(record);
          requestAnimationFrame(() => { record.frame = performance.now(); });
        });
        observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
      }, { marker, selector });
      await page.keyboard.type('1');
      await page.waitForFunction(() => {
        const probe = (window as any).editingPreviewProbe;
        return probe.paints.some((entry: any) => entry.value === probe.accepted && entry.frame);
      }, { timeout: 5000 });
      await page.keyboard.type('234567892345', { delay: 60 });
      await page.waitForFunction(() => {
        const probe = (window as any).editingPreviewProbe;
        return probe.paints.some((entry: any) => entry.value === probe.accepted && entry.frame);
      }, { timeout: 5000 });
      const observation = await page.evaluate(() => (window as any).editingPreviewProbe);
      const duringInput = observation.paints.filter((entry: any) => entry.value !== marker + '1'
        && entry.frame > 0 && entry.frame < observation.inputs.at(-1).time).length;
      const singleMs = observation.paints[0].frame - observation.inputs[0].time;
      assert.ok(observation.inputs.length === 13 && observation.inputs.every((entry: any) => entry.trusted));
      assert.ok(host.readHost().includes(marker + '1234567892345'));
      assert.deepEqual(host.errors, []);
      assert.ok(duringInput >= 2, `${label}: preview must advance during native typing; observed ${duringInput} intermediate paints`);
      await captureResult(page, `editing-preview-${label}`);
      const composition = await page.createCDPSession(), committed = marker + '12345678923456';
      const expectedDocument = text.replace(marker, committed);
      try {
        await composition.send('Input.imeSetComposition', { text: '6', selectionStart: 1, selectionEnd: 1 });
        await frames(page, 8);
        const preedit = await page.evaluate(({ selector, committed }) => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          return { composing: view.composing, accepted: view.state.doc.toString().includes(committed),
            rendered: document.querySelector(selector)?.textContent?.includes(committed) };
        }, { selector, committed });
        assert.ok(preedit.composing && preedit.accepted, `${label}: fixture must establish real native preedit`);
        assert.equal(preedit.rendered, false, `${label}: expensive preview work must wait for composition commit`);
        await composition.send('Input.insertText', { text: '6' });
        await page.waitForFunction(({ selector, committed }) => document.querySelector(selector)?.textContent?.includes(committed),
          { timeout: 5000 }, { selector, committed });
        assert.equal(await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any)
          .cmTile.root.view.state.doc.toString()), expectedDocument, `${label}: IME must commit exactly once`);
        assert.equal(host.readHost(), expectedDocument, `${label}: committed text must reach the document owner`);
        assert.deepEqual(host.errors, []);
      } finally { await composition.detach(); }
      console.log(`${label}: single ${Math.round(singleMs)}ms, ${duringInput} intermediate preview paints`);
    } finally { host.dispose(); await page.close(); }
  }
} finally { try { await closeTestBrowser(browser); } finally { server.stop(true); } }
