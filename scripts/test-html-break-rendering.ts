import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-html-break-rendering-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function checkBreakDeletion(page: Page, large: boolean): Promise<void> {
  const table = '| A | B |\n| --- | --- |\n| Alpha<br>Beta | Z |';
  const padding = large ? '\n\n' + 'Padding\n'.repeat(8_100) : '';
  const cases: Array<{
    mode: 'source' | 'live'; before: string; after: string; offset: number; key: 'Backspace' | 'Delete';
    click?: 'closing' | 'next' | 'blank'; navigate?: 'Home' | 'End' | 'Shift+End';
    selectThrough?: number; secondCaret?: boolean; history?: boolean;
  }> = [
    { mode: 'source', before: table, offset: 4, key: 'Backspace', after: table.replace('<br>', '<br'), history: true },
    { mode: 'source', before: table, offset: 0, key: 'Delete', after: table.replace('<br>', 'br>') },
    { mode: 'source', before: 'Alpha<br>Beta', offset: 4, key: 'Backspace', after: 'Alpha<brBeta' },
    { mode: 'live', before: 'Alpha<br>Beta', offset: 4, click: 'next', key: 'Backspace', after: 'AlphaBeta', history: true },
    { mode: 'live', before: 'Alpha<br>Beta', offset: 4, click: 'closing', key: 'Backspace', after: 'Alpha<brBeta', history: true },
    { mode: 'live', before: 'Alpha<br>Beta', offset: 4, click: 'closing', key: 'Delete', after: 'Alpha<br>eta' },
    { mode: 'live', before: 'Alpha<br><br>Beta', offset: 4, click: 'closing', key: 'Delete', after: 'Alpha<br>br>Beta' },
    { mode: 'live', before: 'Alpha<br><br>Beta', offset: 4, click: 'blank', key: 'Delete', after: 'Alpha<br>Beta' },
    { mode: 'live', before: 'Alpha<br/>Beta', offset: 4, key: 'Backspace', after: 'Alpha<br>Beta' },
    { mode: 'live', before: 'Alpha<br/>Beta', offset: 3, selectThrough: 4, key: 'Delete', after: 'Alpha<br>Beta' },
    { mode: 'live', before: 'Alpha<BR />Beta', offset: 0, key: 'Delete', after: 'AlphaBeta' },
    { mode: 'live', before: 'Alpha<br>Beta', offset: 0, navigate: 'End', key: 'Delete', after: 'AlphaBeta' },
    { mode: 'live', before: 'Alpha<br>Beta', offset: 0, navigate: 'Shift+End', key: 'Delete', after: '<br>Beta' },
    { mode: 'live', before: 'Alpha<br>Beta', offset: 4, navigate: 'Home', key: 'Backspace', after: 'AlphaBeta' },
    { mode: 'live', before: 'Alpha<br>\nBeta', offset: 5, key: 'Backspace', after: 'AlphaBeta' },
    { mode: 'live', before: 'Alpha<br>  \nBeta', offset: 0, key: 'Delete', after: 'Alpha  Beta' },
    { mode: 'live', before: '`Alpha<br>Beta`', offset: 4, key: 'Backspace', after: '`Alpha<brBeta`' },
    { mode: 'live', before: 'Alpha<br>Beta\n\nOther!', offset: 4, secondCaret: true, key: 'Backspace', after: 'AlphaBeta\n\nOther', history: true }
  ];
  for (const test of cases) {
    const source = test.before + padding;
    const tag = test.before.indexOf('<');
    const anchor = tag + test.offset;
    const head = test.selectThrough === undefined ? anchor : tag + test.selectThrough;
    const initialHead = test.click === 'closing' ? head - 1 : test.click === 'blank' || test.navigate?.endsWith('End') ? 0
      : test.navigate === 'Home' ? head + 2 : head;
    assert.equal(assessLargeDocument(source).boundedEditorWork, large);
    await page.evaluate(({ source, mode, anchor, head, extraHead }) => {
      const fixture = window as any;
      const harness = fixture.HtmlBreakRenderingHarness;
      fixture.__htmlBreakEditor.destroy();
      fixture.__htmlBreakEditor = harness.createEditor({
        parent: document.getElementById('app')!, text: source, initialMode: mode, onApplyChanges() {}
      });
      const view = fixture.__htmlBreakEditor.view;
      view.focus();
      const { range, cursor, create } = harness.EditorSelection;
      const ranges = [anchor === head ? cursor(head) : range(anchor, head)];
      if (extraHead !== null) ranges.push(cursor(extraHead));
      view.dispatch({ selection: create(ranges) });
    }, { source, mode: test.mode, anchor: test.selectThrough === undefined ? initialHead : anchor,
      head: initialHead, extraHead: test.secondCaret ? test.before.length : null });
    await page.waitForFunction(large => {
      const fixture = window as any;
      return fixture.HtmlBreakRenderingHarness.usesLargeDocumentDerivedWorkBudget(fixture.__htmlBreakEditor.view.state) === large;
    }, {}, large);
    await waitForFrames(page, 3);
    if (test.click) {
      const point = await page.evaluate(({ head, click }) => {
        const view = (window as any).__htmlBreakEditor.view;
        if (click === 'blank') {
          const first = view.coordsForChar(0);
          const third = view.coordsForChar(head + 4);
          return { x: first.right + 120, y: (first.top + first.bottom + third.top + third.bottom) / 4 };
        }
        const box = view.coordsForChar(click === 'closing' ? head - 1 : head);
        if (!box) throw new Error('The break boundary has no rendered glyph');
        return { x: box.left + (box.right - box.left) * (click === 'closing' ? 0.75 : 0.25), y: (box.top + box.bottom) / 2 };
      }, { head, click: test.click });
      await page.mouse.click(point.x, point.y);
      await waitForFrames(page, 3);
    }
    if (test.navigate === 'Shift+End') {
      await page.keyboard.down('Shift');
      await page.keyboard.press('End');
      await page.keyboard.up('Shift');
    } else if (test.navigate) await page.keyboard.press(test.navigate);
    const before = await page.evaluate(() => {
      const { state } = (window as any).__htmlBreakEditor.view;
      return [state.selection.main.head, state.selection.main.assoc];
    });
    const context = `${large ? 'large' : 'ordinary'}/${test.mode}/${test.key} at ${before} in ${JSON.stringify(test.before)}`;
    assert.equal(before[0], head, context);
    if (test.click) assert.equal(before[1], test.click === 'closing' ? -1 : 1, `${context}/break affinity`);
    await page.keyboard.press(test.key);
    const actual = await page.evaluate(() => (window as any).__htmlBreakEditor.getText());
    assert.equal(actual.slice(0, actual.length - padding.length), test.after, context);
    assert.equal(actual.slice(actual.length - padding.length), padding);
    if (test.history) {
      const history = await page.evaluate(async original => {
        const editor = (window as any).__htmlBreakEditor;
        const restored = await editor.undo() && editor.getText() === original;
        const selection = editor.view.state.selection;
        return { restored, head: selection.main.head, assoc: selection.main.assoc, count: selection.ranges.length,
          redone: await editor.redo(), text: editor.getText() };
      }, source);
      assert.deepEqual(history, { restored: true, head, assoc: before[1], count: test.secondCaret ? 2 : 1,
        redone: true, text: actual }, `${context}/history`);
    }
  }
}

async function checkBreakPointerGeometry(page: Page, large: boolean): Promise<void> {
  const label = large ? 'large' : 'ordinary';
  const padding = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}`);
  const first = '甲：第一段', second = '乙：第二段', third = '丙：第三段', tail = '末尾标签';
  const source = [...padding, `${first}<br>${second}<br/>${third}<BR />丁：最后一段`, `${tail}<br>  `,
    '下一源文件行', ...padding, ...(large ? Array(8_100).fill('Padding') : [])].join('\n');
  const start = source.indexOf(first);
  const firstBreak = start + first.length;
  const secondStart = source.indexOf(second);
  const secondBreak = secondStart + second.length;
  const thirdBreak = source.indexOf(third) + third.length;
  const tailBreak = source.indexOf(tail) + tail.length;
  assert.equal(assessLargeDocument(source).boundedEditorWork, large, `${label}/size policy`);
  await page.evaluate(text => {
    const fixture = window as any;
    fixture.__htmlBreakEditor.destroy();
    fixture.__htmlBreakEditor = fixture.HtmlBreakRenderingHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
    });
    fixture.__htmlBreakEditor.scrollToLine(34, 'top');
  }, source);
  await page.waitForFunction((large, start) => {
    const fixture = window as any;
    const view = fixture.__htmlBreakEditor.view;
    const row = view.coordsForChar(start);
    return fixture.HtmlBreakRenderingHarness.usesLargeDocumentDerivedWorkBudget(view.state) === large
      && view.scrollDOM.scrollTop > 0 && row?.top > 80 && row.bottom < 400
      && view.contentDOM.querySelectorAll('.meo-md-html-break').length === 3;
  }, {}, large, start);
  await waitForFrames(page);

  const point = (position: number, blank: boolean) => page.evaluate(({ position, blank }) => {
    const view = (window as any).__htmlBreakEditor.view;
    const box = view.coordsForChar(position);
    if (!box) throw new Error(`Missing visible glyph at ${position}`);
    const x = blank ? box.right + 100 : box.left + (box.right - box.left) / 4;
    const y = (box.top + box.bottom) / 2;
    const target = document.elementFromPoint(x, y);
    if (!target?.closest('.cm-content')) throw new Error(`Click at ${x},${y} hit ${target?.outerHTML.slice(0, 200)}`);
    return { x, y };
  }, { position, blank });
  const checkClick = async (position: number, blank: boolean, expected: number, tag: string, action: string) => {
    const { x, y } = await point(position, blank);
    const before = await page.evaluate(start => {
      const fixture = window as any;
      const view = fixture.__htmlBreakEditor.view;
      const samples: Array<{ scroll: number; top: number }> = [];
      const measure = () => ({ scroll: view.scrollDOM.scrollTop, top: view.coordsForChar(start)?.top });
      let frame = requestAnimationFrame(function observe() {
        samples.push(measure());
        frame = requestAnimationFrame(observe);
      });
      fixture.__htmlBreakPointerSamples = () => {
        cancelAnimationFrame(frame);
        const { head, assoc } = view.state.selection.main;
        return {
          samples, head, caret: view.coordsAtPos(head, assoc < 0 ? -1 : 1),
          tags: [...view.contentDOM.querySelectorAll('.meo-md-html-break-source')].map(part => part.textContent),
          breaks: view.contentDOM.querySelectorAll('.meo-md-html-break').length
        };
      };
      return measure();
    }, start);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await waitForFrames(page, 2);
    const held = await page.evaluate(() => (window as any).__htmlBreakEditor.view.state.selection.main.head);
    await page.mouse.up();
    await waitForFrames(page);
    const result = await page.evaluate(() => (window as any).__htmlBreakPointerSamples());
    const context = `${label}/${action}`;
    assert.equal(held, expected, `${context}/held source offset`);
    assert.equal(result.head, expected, `${context}/released source offset`);
    assert.deepEqual(result.tags, [tag], `${context}/visible tag`);
    assert.equal(result.breaks, 3, `${context}/painted breaks`);
    assert(result.caret?.top <= y && y <= result.caret?.bottom, `${context}/caret must stay on the clicked row`);
    assert(result.samples.length >= 2, `${context}/frame samples`);
    for (const sample of result.samples) {
      assert(Math.abs(sample.scroll - before.scroll) <= 1 && Math.abs(sample.top - before.top) <= 1,
        `${context}/document moved from ${JSON.stringify(before)} to ${JSON.stringify(sample)}`);
    }
  };

  await checkClick(firstBreak - 1, true, firstBreak, '<br>', 'blank tail with hidden tag');
  await checkClick(secondStart, false, secondStart, '<br/>', 'start of the row after a revealed tag');
  await checkClick(secondBreak - 1, true, secondBreak, '<br/>', 'blank tail with revealed tag');
  await checkClick(thirdBreak - 1, true, thirdBreak, '<BR />', 'uppercase tag');
  await checkClick(tailBreak - 1, true, tailBreak, '<br>', 'tag before a physical newline and trailing spaces');

  const dragStart = await point(firstBreak - 1, true);
  const dragEnd = await point(secondStart + 1, false);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
  await page.mouse.up();
  await waitForFrames(page);
  const drag = await page.evaluate(() => {
    const { state } = (window as any).__htmlBreakEditor.view;
    const { anchor, head } = state.selection.main;
    return { anchor, head, text: state.doc.toString() };
  });
  assert.deepEqual(drag, { anchor: firstBreak, head: secondStart + 1, text: source }, `${label}/drag from the blank tail`);

  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
  await page.mouse.move(dragStart.x, dragStart.y, { steps: 5 });
  await page.mouse.up();
  await waitForFrames(page);
  const returned = await page.evaluate(() => {
    const { anchor, head } = (window as any).__htmlBreakEditor.view.state.selection.main;
    return { anchor, head };
  });
  assert.deepEqual(returned, { anchor: firstBreak, head: firstBreak }, `${label}/drag back to the blank tail`);

  await checkClick(secondBreak - 1, true, secondBreak, '<br/>', 'reveal the tag for editing');
  await checkClick(secondBreak + 3, false, secondBreak + 3, '<br/>', 'inside the tag before its slash');
  await page.keyboard.type(' ');
  await waitForFrames(page);
  const edited = await page.evaluate(() => {
    const view = (window as any).__htmlBreakEditor.view;
    return { text: view.state.doc.toString(), breaks: view.contentDOM.querySelectorAll('.meo-md-html-break').length };
  });
  assert.equal(edited.text, source.slice(0, secondBreak + 3) + ' ' + source.slice(secondBreak + 3), `${label}/editing tag source`);
  assert.equal(edited.breaks, 3, `${label}/valid tag edit preserves visual breaks`);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-html-break-rendering-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 640, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-token-comment-color:#a3b4c5; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:"Courier New"; --meo-font-source-weight:500; --meo-font-source-size:14px; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const source = [
      '---',
      'title: "<br>"',
      '---',
      'alpha<br>beta<br/>gamma<br />delta',
      'tail<br>',
      'next',
      '`inline<br>code`',
      '```html',
      'block<br>code',
      '```'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__htmlBreakSource = text;
      (window as any).__htmlBreakEditor = (window as any).HtmlBreakRenderingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, source);
    await waitForFrames(page);

    const collectState = () => page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      const firstLine = Array.from(content.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('alpha'))!;
      const textTop = (label: string): number | null => {
        const walker = document.createTreeWalker(firstLine, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent?.indexOf(label) ?? -1;
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + label.length);
          return range.getBoundingClientRect().top;
        }
        return null;
      };
      return {
        firstLineText: firstLine.textContent ?? '',
        breakCount: firstLine.querySelectorAll('.meo-md-html-break').length,
        sourceBreaks: Array.from(firstLine.querySelectorAll('.meo-md-html-break-source'), element => ({
          tag: element.textContent,
          colors: [element, ...element.querySelectorAll('*')].map(part => getComputedStyle(part).webkitTextFillColor)
        })),
        tops: ['alpha', 'beta', 'gamma', 'delta'].map(textTop),
        documentText: (window as any).__htmlBreakEditor.view.state.doc.toString(),
        documentLines: (window as any).__htmlBreakEditor.view.state.doc.lines,
        clickPoint: (() => {
          const top = textTop('beta');
          if (top === null) return null;
          const rect = firstLine.getBoundingClientRect();
          return { x: rect.left + 24, y: top + 6 };
        })()
      };
    });

    const initial = await collectState();
    if (initial.firstLineText.includes('<br') || initial.breakCount !== 3) {
      throw new Error(`HTML break tags were not hidden correctly: ${JSON.stringify(initial)}`);
    }
    if (
      initial.tops.some((top) => top === null) ||
      !initial.tops.every((top, index, tops) => index === 0 || Number(top) > Number(tops[index - 1]))
    ) {
      throw new Error(`HTML break widgets did not create visual lines: ${JSON.stringify(initial.tops)}`);
    }
    if (initial.documentText !== source || initial.documentLines !== source.split('\n').length) {
      throw new Error('HTML break rendering changed the Markdown document or its logical line count');
    }
    if (!initial.clickPoint) {
      throw new Error('Could not locate a rendered HTML break line for interaction testing');
    }

    await page.mouse.click(initial.clickPoint.x, initial.clickPoint.y);
    await waitForFrames(page);
    const textEditing = await collectState();
    if (textEditing.sourceBreaks.map(tag => tag.tag).join('') !== '<br/>' || textEditing.breakCount !== 3) {
      throw new Error(`Editing beta must show only its own terminating break: ${JSON.stringify(textEditing)}`);
    }
    await page.evaluate(() => {
      const view = (window as any).__htmlBreakEditor.view;
      const anchor = view.state.doc.toString().indexOf('<br/>') + 2;
      view.dispatch({ selection: { anchor } });
    });
    await waitForFrames(page);
    const active = await collectState();
    if (
      active.firstLineText !== 'alphabeta<br/>gammadelta' ||
      active.breakCount !== 3
    ) {
      throw new Error(`The selected HTML tag and its visual break must stay visible: ${JSON.stringify(active)}`);
    }
    if (active.sourceBreaks.map(breakTag => breakTag.tag).join('') !== '<br/>' ||
        active.sourceBreaks.some(breakTag => breakTag.colors.some(color => color !== 'rgb(163, 180, 197)'))) {
      throw new Error(`HTML break source tags did not use the comment color: ${JSON.stringify(active.sourceBreaks)}`);
    }
    if (
      active.tops.some((top) => top === null) ||
      !active.tops.every((top, index, tops) => index === 0 || Number(top) > Number(tops[index - 1]))
    ) {
      throw new Error(`Visual breaks disappeared after revealing source tags: ${JSON.stringify(active.tops)}`);
    }
    if (active.documentText !== source || active.documentLines !== source.split('\n').length) {
      throw new Error('Interacting with HTML breaks changed the Markdown source');
    }

    for (const [appearance, expectedColor] of [['light', 'rgb(116, 125, 135)'], ['dark', 'rgb(163, 180, 197)']] as const) {
      await page.evaluate(appearance => {
        (window as any).HtmlBreakRenderingHarness.applyBuiltInVisualBaseline(appearance);
        // The host syntax palette is applied after the appearance baseline.
        document.documentElement.style.setProperty('--meo-token-comment-color', '#a3b4c5');
      }, appearance);
      const { sourceBreaks } = await collectState();
      if (sourceBreaks.length !== 1 || sourceBreaks.some(tag => tag.colors.some(color => color !== expectedColor))) {
        throw new Error(`${appearance} Live break color differs from the expected comment color: ${JSON.stringify(sourceBreaks)}`);
      }
    }

    for (const large of [false, true]) {
      await checkBreakPointerGeometry(page, large);
      await checkBreakDeletion(page, large);
    }
    console.log('HTML break rendering browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
