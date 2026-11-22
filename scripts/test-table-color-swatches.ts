import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-colors-'));

async function checkHashTokenClassification(page: Page): Promise<void> {
  const line = '颜色：#122321，#33669988。 #AABBCC项目 #33669988𐐀 #AABBCC\u0301 #AABBCC/任务 #工作 #635 #875';
  const expected = {
    colors: ['#122321', '#33669988'],
    tags: ['#AABBCC项目', '#33669988𐐀', '#AABBCC\u0301', '#AABBCC/任务', '#工作']
  };
  for (const large of [false, true]) {
    const text = [line, '', '| Color |', '| --- |', `| ${line} |`, '', 'After.'].join('\n')
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    await page.evaluate(text => {
      const harness = (window as any).TableStabilityHarness;
      const editor = (window as any).hashTokenEditor = harness.createEditor({
        parent: document.getElementById('app')!, initialMode: 'live', text, onApplyChanges() {}
      });
      editor.view.dispatch({ selection: { anchor: text.indexOf('After.') } });
    }, text);
    await page.waitForFunction(large => {
      const { TableStabilityHarness, hashTokenEditor } = window as any;
      return TableStabilityHarness.usesLargeDocumentDerivedWorkBudget(hashTokenEditor.view.state) === large
        && !!document.querySelector('tbody .meo-md-html-table-cell-preview [data-color-value="#122321"]');
    }, {}, large);
    const rendered = await page.evaluate(() => {
      const read = (root: Element) => ({
        colors: Array.from(root.querySelectorAll<HTMLElement>('[data-color-value]'), swatch => swatch.dataset.colorValue),
        tags: Array.from(root.querySelectorAll('.meo-md-tag'), tag => tag.textContent)
      });
      const prose = document.querySelector('.cm-line:has([data-color-value="#122321"])')!;
      const table = document.querySelector('tbody .meo-md-html-table-cell-preview')!;
      return { prose: read(prose), table: read(table) };
    });
    assert.deepEqual(rendered, { prose: expected, table: expected },
      `${large ? 'optimized' : 'ordinary'} Live rendering agrees on complete HEX and tag tokens`);
    await page.evaluate(() => {
      const { hashTokenEditor: editor } = window as any;
      editor.view.dispatch({ selection: { anchor: '颜色：#122321'.length } });
      editor.view.focus();
    });
    await page.keyboard.type('项目');
    await page.waitForFunction(() => {
      const prose = document.querySelector('.cm-line:has([data-color-value="#33669988"])');
      return !!prose && !prose.querySelector('[data-color-value="#122321"]')
        && Array.from(prose.querySelectorAll('.meo-md-tag')).some(tag => tag.textContent === '#122321项目');
    });
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => {
      const prose = document.querySelector('.cm-line:has([data-color-value="#33669988"])');
      return !!prose?.querySelector('[data-color-value="#122321"]')
        && !Array.from(prose.querySelectorAll('.meo-md-tag')).some(tag => tag.textContent?.startsWith('#122321'));
    });
    await page.evaluate(() => (window as any).hashTokenEditor.destroy());
  }
}

async function checkSwatchWrapping(page: Page): Promise<void> {
  for (const large of [false, true]) for (const table of [false, true]) {
    const line = 'prefix should stay here #122321 tail';
    const text = (table ? `| Color |\n| --- |\n| ${line} |` : line) + '\n\nAfter.'
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    const label = `${table ? 'table' : 'prose'}/${large ? 'optimized' : 'ordinary'}`;
    const swatchSelector = '[data-color-value="#122321"]';
    await page.evaluate(text => {
      const harness = (window as any).TableStabilityHarness;
      const editor = (window as any).wrappingColorEditor = harness.createEditor({
        parent: document.getElementById('app')!, initialMode: 'live', text, onApplyChanges() {}
      });
      editor.view.dispatch({ selection: { anchor: text.indexOf('After.') } });
    }, text);
    await page.waitForFunction(({ large, swatchSelector }) => {
      const { TableStabilityHarness, wrappingColorEditor } = window as any;
      return TableStabilityHarness.usesLargeDocumentDerivedWorkBudget(wrappingColorEditor.view.state) === large
        && !!document.querySelector(swatchSelector);
    }, {}, { large, swatchSelector });
    const lineSelector = table ? 'tbody .meo-md-html-table-cell-preview' : '.cm-line';
    const rule = await page.$eval(swatchSelector, (swatch, lineSelector) => {
      const line = swatch.closest(lineSelector)!;
      const left = line.getBoundingClientRect().left;
      const right = swatch.getBoundingClientRect().right;
      return `#app ${lineSelector} { box-sizing: border-box; width: ${right - left + 8}px !important; }`;
    }, lineSelector);
    const style = await page.addStyleTag({ content: rule });
    const measure = () => page.$eval(swatchSelector, (swatch, lineSelector) => {
      const line = swatch.closest(lineSelector)!;
      const glyph = (value: string, length: number) => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent!.indexOf(value);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + length);
          return Array.from(range.getClientRects(), rect => rect.toJSON());
        }
        throw new Error(`Missing ${value}`);
      };
      return { prefix: glyph('prefix', 6)[0]!, color: glyph('#122321', 7), swatch: swatch.getBoundingClientRect().toJSON() };
    }, lineSelector);
    const verify = async () => {
      const geometry = await measure();
      assert.equal(geometry.color.length, 1, `${label}: the value stays on one visual row`);
      const color = geometry.color[0]!;
      assert.ok(color.top > geometry.prefix.top + 5, `${label}: the value wraps to the next row`);
      assert.ok(Math.abs((color.top + color.bottom - geometry.swatch.top - geometry.swatch.bottom) / 2) <= 1.5,
        `${label}: the swatch wraps with the value ${JSON.stringify(geometry)}`);
      return color;
    };
    const color = await verify();
    await page.mouse.click(Math.ceil(color.left + color.width / 2), (color.top + color.bottom) / 2);
    if (table) await page.waitForSelector(`${lineSelector} .meo-md-table-active-source-line`);
    const caretInColor = await page.evaluate(table => {
      const editor = (window as any).wrappingColorEditor;
      const input = table ? document.querySelector<HTMLTextAreaElement>('tbody .is-editing textarea') : null;
      const source = table ? input?.value : editor.getText();
      const offset = table ? input?.selectionStart : editor.view.state.selection.main.head;
      const start = source?.indexOf('#122321') ?? -1;
      return start >= 0 && offset !== undefined && offset > start && offset < start + '#122321'.length;
    }, table);
    assert.ok(caretInColor, `${label}: clicking the wrapped HEX selects a character position inside it`);
    await verify();
    if (!large && process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `wrapped-swatch-${table ? 'table' : 'prose'}.png`) });
    }
    await style.evaluate(style => style.remove());
    await page.evaluate(() => (window as any).wrappingColorEditor.destroy());
  }
}

async function checkSwatchesWhileEditing(page: Page): Promise<void> {
  await page.setViewport({ width: 1100, height: 700 });
  for (const large of [false, true]) for (const table of [false, true]) {
    const line = '#336699 and **#AA4411**';
    const source = (table ? `| Color |\n| --- |\n| ${line} |` : line) + '\n\nAfter.'
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    const label = `${table ? 'table' : 'prose'}/${large ? 'optimized' : 'ordinary'}`;
    const root = table ? 'tbody .meo-md-html-table-cell-preview' : '.cm-content';
    await page.evaluate(source => {
      const harness = (window as any).TableStabilityHarness;
      const editor = (window as any).editingColorEditor = harness.createEditor({
        parent: document.getElementById('app')!, initialMode: 'live', text: source, onApplyChanges() {}
      });
      editor.view.dispatch({ selection: { anchor: source.indexOf('After.') } });
    }, source);
    await page.waitForFunction(({ large, root }) => {
      const { TableStabilityHarness, editingColorEditor } = window as any;
      return TableStabilityHarness.usesLargeDocumentDerivedWorkBudget(editingColorEditor.view.state) === large
        && document.querySelector(`${root} [data-color-value="#AA4411"]`);
    }, {}, { large, root });
    const point = await page.$eval(`${root} [data-color-value="#336699"]`, (swatch, root) => {
      const walker = document.createTreeWalker(swatch.closest(root)!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent!.indexOf('#336699');
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index + 3);
        range.setEnd(node, index + 4);
        const rect = range.getBoundingClientRect();
        return { x: Math.ceil(rect.left + 1), y: rect.top + rect.height / 2 };
      }
      throw new Error('Missing HEX text');
    }, root);
    const visibleSwatches = () => page.$$eval(`${root} .meo-md-color-swatch`, elements =>
      elements.filter(element => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility === 'visible')
        .map(element => (element as HTMLElement).style.backgroundColor));
    const swatchAlignment = () => page.$eval(
      `${root} .meo-md-color-swatch:is([data-color-value="#AA4411"], [data-tooltip="#AA4411"])`,
      (swatch, root) => {
        const walker = document.createTreeWalker(swatch.closest(root)!, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent!.indexOf('#AA4411');
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + '#AA4411'.length);
          const swatchRect = swatch.getBoundingClientRect();
          const textRect = range.getBoundingClientRect();
          return { tag: swatch.tagName, offset: swatchRect.y + swatchRect.height / 2 - (textRect.y + textRect.height / 2) };
        }
        throw new Error('Missing text next to the swatch');
      }, root
    );
    const reading = await visibleSwatches();
    assert.deepEqual(reading, ['rgb(51, 102, 153)', 'rgb(170, 68, 17)'], `${label}: both reading swatches are visible`);
    const readingAlignment = await swatchAlignment();
    assert.equal(readingAlignment.tag, 'BUTTON');
    assert(Math.abs(readingAlignment.offset) <= 1.5, `${label}: reading swatch is centered with its HEX text (${readingAlignment.offset}px)`);
    const assertStableAlignment = async (phase: string, tag: string) => {
      const alignment = await swatchAlignment();
      assert.equal(alignment.tag, tag, `${label}: ${phase} measures the intended swatch state`);
      const shift = alignment.offset - readingAlignment.offset;
      assert(Math.abs(shift) <= 0.25, `${label}: ${phase} moves the swatch ${shift}px relative to its text`);
    };
    await page.mouse.click(point.x, point.y);
    if (table) await page.waitForSelector(`${root} .meo-md-table-active-source-line`);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await visibleSwatches(), reading, `${label}: placing the caret in the color keeps both swatches`);
    await assertStableAlignment('entering the source line', 'BUTTON');
    await page.keyboard.press('Delete');
    if (table) await assertStableAlignment('editing ahead of the swatch', 'SPAN');
    await page.keyboard.type('8');
    await page.waitForFunction(root => Array.from(document.querySelectorAll<HTMLElement>(`${root} .meo-md-color-swatch`))
      .some(swatch => swatch.style.backgroundColor === 'rgb(51, 134, 153)' && swatch.getBoundingClientRect().width > 0), {}, root);
    await assertStableAlignment('returning to the interactive swatch', 'BUTTON');
    const inBold = table ? `${root} .meo-md-table-inline-source` : `${root} .meo-md-strong-marker-active`;
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.waitForSelector(inBold);
    assert.deepEqual(await visibleSwatches(), ['rgb(51, 134, 153)', 'rgb(170, 68, 17)'],
      `${label}: revealing emphasis keeps its nested color swatch`);
    await page.waitForFunction(() => (window as any).editingColorEditor.getText().includes('#338699'));
    if (!large && process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `editing-swatch-${table ? 'table' : 'prose'}.png`) });
    }
    const nestedControl = `${root} [data-color-value="#AA4411"]`;
    assert(await page.$eval(nestedControl, swatch => {
      const rect = swatch.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === swatch;
    }), `${label}: the swatch is the pointer target during editing`);
    await page.click(nestedControl);
    const input = await page.waitForSelector('.meo-hex-color-adjustment-value', { timeout: 2000 });
    assert.equal(await input?.evaluate((element: HTMLInputElement) => element.value), '#AA4411',
      `${label}: the swatch opens the adjustment for its own color`);
    await page.evaluate(() => (window as any).editingColorEditor.destroy());
  }
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) {
    throw new Error(build.logs.map(String).join('\n'));
  }

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <button id="outside">outside</button>
      <div class="editor-root" data-mode="live">
        <div class="mode-toolbar">toolbar</div>
        <div class="editor-notice"></div>
        <div class="editor-wrapper">
          <div class="editor-surface">
            <div id="app" class="editor-host"></div>
          </div>
        </div>
      </div>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await checkHashTokenClassification(page);
    await checkSwatchWrapping(page);
    await checkSwatchesWhileEditing(page);

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text: [
          '| Colors | Tag | Protected |',
          '| --- | --- | --- |',
          `| #f00 #0f08 #336699 #33669988 rgba(51, 153, 255, 0.55) hsl(210 100% 60%) red linear-gradient(#ffffff, #000000) | #todo #abc/tag | \`#00ff00\` HTTPS://example.com/?color=#aabbcc //example.com/?color=#aabbcc [section]( #aabbcc) ${String.fromCharCode(92)}${String.fromCharCode(96).repeat(2)}#00aa00${String.fromCharCode(96)} #00bb00 |`
        ].join('\n'),
        onApplyChanges() {}
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      const previews = document.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-preview');
      const swatchTitles = (root: ParentNode) => Array.from(
        root.querySelectorAll<HTMLElement>('.meo-md-color-swatch'),
        (swatch) => swatch.dataset.colorValue ?? swatch.dataset.tooltip
      );
      const tagTexts = (root: ParentNode) => Array.from(
        root.querySelectorAll<HTMLElement>('.meo-md-tag'),
        (tag) => tag.textContent
      );
      const initial = {
        colors: swatchTitles(previews[0]),
        colorTags: tagTexts(previews[0]),
        tags: tagTexts(previews[1]),
        protectedColors: previews[2].querySelectorAll('.meo-md-color-swatch').length,
        protectedColorTitles: swatchTitles(previews[2])
      };

      const tableSwatch = previews[0].querySelector<HTMLElement>('.meo-md-color-swatch');
      tableSwatch?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const tableDialogOpened = Boolean(app.querySelector('.meo-hex-color-adjustment'));

      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.value = '#00ff00 #00ff00项目 #todo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('outside')!.focus();
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const preview = document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview')!;
      const updated = {
        colors: swatchTitles(preview),
        tags: tagTexts(preview)
      };
      editor.destroy();
      return { initial, updated, tableDialogOpened };
    });

    const expectedInitial = {
      colors: ['#336699', '#33669988'],
      colorTags: [],
      tags: ['#todo', '#abc/tag'],
      protectedColors: 1,
      protectedColorTitles: ['#00bb00']
    };
    if (JSON.stringify(result.initial) !== JSON.stringify(expectedInitial)) {
      throw new Error(`Table colors were not rendered separately from tags: ${JSON.stringify(result.initial)}`);
    }
    if (JSON.stringify(result.updated) !== JSON.stringify({ colors: ['#00ff00'], tags: ['#00ff00项目', '#todo'] })) {
      throw new Error(`Edited table colors were not refreshed: ${JSON.stringify(result.updated)}`);
    }

    await page.evaluate(async () => {
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).tableColorEditor = (window as any).TableStabilityHarness.createEditor({
        parent: app,
        initialMode: 'live',
        text: '| #AABBCC | Note |\n| --- | --- |\n| #336699 and #33669988 | text |',
        onApplyChanges() {}
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const tableSwatchBounds = await page.$eval(
      'tbody button.meo-md-color-swatch-interactive[data-color-value="#336699"]',
      (element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      }
    );
    await page.mouse.move(tableSwatchBounds.x, tableSwatchBounds.y);
    await page.mouse.down();
    const openedOnPointerDown = await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return Boolean(document.querySelector('.meo-hex-color-adjustment'));
    });
    await page.mouse.up();
    if (!openedOnPointerDown) {
      throw new Error('Table HEX dialog must open before the table pointer lifecycle can replace the swatch');
    }
    await page.waitForSelector('.meo-hex-color-adjustment');
    const tableDialogPresentation = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('.meo-hex-color-adjustment')!;
      const bounds = dialog.getBoundingClientRect();
      const centerX = Math.max(0, Math.min(innerWidth - 1, bounds.left + bounds.width / 2));
      const centerY = Math.max(0, Math.min(innerHeight - 1, bounds.top + bounds.height / 2));
      const topmost = document.elementFromPoint(centerX, centerY);
      const style = getComputedStyle(dialog);
      return {
        visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
          bounds.width > 0 && bounds.height > 0,
        topmost: Boolean(topmost && (topmost === dialog || dialog.contains(topmost)))
      };
    });
    if (!tableDialogPresentation.visible || !tableDialogPresentation.topmost) {
      throw new Error(`Table HEX dialog was mounted but not visibly interactive: ${JSON.stringify(tableDialogPresentation)}`);
    }
    const tableInteraction = await page.evaluate(async () => {
      for (let index = 0; index < 2; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const app = document.getElementById('app')!;
      const editor = (window as any).tableColorEditor;
      const dialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment')!;
      const swatch = app.querySelector<HTMLElement>('tbody button[data-color-value="#336699"]')!;
      const popupBounds = dialog.getBoundingClientRect();
      const swatchBounds = swatch.getBoundingClientRect();
      const stickySwatch = app.querySelector<HTMLElement>('.meo-md-html-table-sticky-table .meo-md-color-swatch');
      const input = dialog.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')!;
      input.value = '#112233';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const beforeApply = editor.getText();
      dialog.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')!.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterApply = editor.getText();
      const undo = await editor.undo();
      const afterUndo = editor.getText();
      app.querySelector<HTMLButtonElement>('tbody button[data-color-value="#33669988"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const eightDialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment');
      const eightInput = eightDialog?.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value');
      if (eightInput) {
        eightInput.value = '#44556677';
        eightInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      eightDialog?.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterEightApply = editor.getText();
      const undoEight = await editor.undo();
      const afterEightUndo = editor.getText();
      app.querySelector<HTMLButtonElement>('tbody button[data-color-value="#33669988"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const sixInput = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value');
      if (sixInput) {
        sixInput.value = '#445566';
        sixInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      app.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterSixApply = editor.getText();
      const undoSix = await editor.undo();
      const afterSixUndo = editor.getText();
      app.querySelector<HTMLButtonElement>('thead button[data-color-value="#AABBCC"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const result = {
        popupNearSwatch: Math.abs(popupBounds.left - swatchBounds.left) < 300 &&
          Math.abs(popupBounds.bottom - swatchBounds.top) < 350,
        previewExposed: !swatch.closest('.meo-md-html-table-cell-preview')?.hasAttribute('aria-hidden'),
        stickySwatchPassive: stickySwatch?.tagName === 'SPAN' &&
          !app.querySelector('.meo-md-html-table-sticky-table button.meo-md-color-swatch-interactive'),
        draftIsolated: beforeApply.includes('#336699 and #33669988'),
        changedOnlyTarget: afterApply.includes('#112233 and #33669988'),
        undoRestored: undo && afterUndo.includes('#336699 and #33669988'),
        changedOnlyEight: afterEightApply.includes('#336699 and #44556677'),
        undoEightRestored: undoEight && afterEightUndo.includes('#336699 and #33669988'),
        changedEightToSix: afterSixApply.includes('#336699 and #445566 |'),
        undoSixRestored: undoSix && afterSixUndo.includes('#336699 and #33669988'),
        headerOpens: Boolean(app.querySelector('.meo-hex-color-adjustment'))
      };
      editor.destroy();
      return result;
    });
    if (Object.values(tableInteraction).some((value) => !value)) {
      throw new Error(`Table HEX click/apply/undo and passive sticky header failed: ${JSON.stringify(tableInteraction)}`);
    }

    await page.evaluate(async () => {
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const before = Array.from({ length: 40 }, (_, index) => `Before color ${index}`);
      const after = Array.from({ length: 40 }, (_, index) => `After color ${index}`);
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: app,
        initialMode: 'live',
        text: [...before, '| Color |', '| --- |', '| #336699 |', ...after].join('\n'),
        onApplyChanges() {}
      });
      (window as any).tableColorPopoverEditor = editor;
      const tablePos = before.join('\n').length + 1;
      editor.view.scrollDOM.scrollTop = editor.view.lineBlockAt(tablePos).top - 150;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await page.click('tbody button.meo-md-color-swatch-interactive[data-color-value="#336699"]');
    await page.waitForSelector('.meo-hex-color-adjustment');
    const popoverBeforeWheel = await page.evaluate(async () => {
      for (let index = 0; index < 2; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const editor = (window as any).tableColorPopoverEditor;
      const toolbarBounds = document.querySelector('.mode-toolbar')!.getBoundingClientRect();
      const popoverBounds = document.querySelector('.meo-hex-color-adjustment')!.getBoundingClientRect();
      const swatchBounds = document.querySelector('tbody button[data-color-value="#336699"]')!.getBoundingClientRect();
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        toolbarBottom: toolbarBounds.bottom,
        popoverTop: popoverBounds.top,
        popoverHeight: popoverBounds.height,
        swatchTop: swatchBounds.top,
        swatchBottom: swatchBounds.bottom
      };
    });
    const scrollAlignment = await page.evaluate(async () => {
      const scroller = (window as any).tableColorPopoverEditor.view.scrollDOM as HTMLElement;
      const swatch = document.querySelector<HTMLElement>('tbody button[data-color-value="#336699"]')!;
      const dialog = document.querySelector<HTMLElement>('.meo-hex-color-adjustment')!;
      const offset = () => dialog.getBoundingClientRect().top - swatch.getBoundingClientRect().top;
      const before = offset();
      const swatchTopBefore = swatch.getBoundingClientRect().top;
      const scrollTop = scroller.scrollTop;
      scroller.scrollTop += 24;
      const beforeScrollEvent = offset();
      scroller.dispatchEvent(new Event('scroll'));
      const duringScroll = offset();
      const scrollTopDuring = scroller.scrollTop;
      const swatchTopDuring = swatch.getBoundingClientRect().top;
      scroller.scrollTop = scrollTop;
      scroller.dispatchEvent(new Event('scroll'));
      for (let index = 0; index < 2; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return { before, beforeScrollEvent, duringScroll, scrollTop, scrollTopDuring, swatchTopBefore, swatchTopDuring, restored: scroller.scrollTop === scrollTop };
    });
    if (!scrollAlignment.restored || scrollAlignment.scrollTopDuring - scrollAlignment.scrollTop !== 24 ||
      Math.abs(scrollAlignment.swatchTopDuring - scrollAlignment.swatchTopBefore + 24) > 1 ||
      Math.abs(scrollAlignment.beforeScrollEvent - scrollAlignment.before) > 1 ||
      Math.abs(scrollAlignment.duringScroll - scrollAlignment.before) > 1) {
      throw new Error(`Table HEX dialog did not scroll with its swatch: ${JSON.stringify(scrollAlignment)}`);
    }
    const popoverWheelProgress = await page.evaluate(async () => {
      const scroller = (window as any).tableColorPopoverEditor.view.scrollDOM as HTMLElement;
      const samples = [scroller.scrollTop];
      const wheel = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 90,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL
      });
      document.querySelector('.meo-hex-color-adjustment-hue')!.dispatchEvent(wheel);
      samples.push(scroller.scrollTop);
      for (let index = 0; index < 18; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push(scroller.scrollTop);
      }
      return { samples, defaultPrevented: wheel.defaultPrevented };
    });
    const colorPopoverBounds = await page.$eval('.meo-hex-color-adjustment-hue', (element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    });
    await page.mouse.move(colorPopoverBounds.x, colorPopoverBounds.y);
    await page.mouse.wheel({ deltaY: 60 });
    await page.evaluate(async () => {
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const popoverAfterWheel = await page.evaluate(async () => {
      const editor = (window as any).tableColorPopoverEditor;
      const afterWheel = editor.view.scrollDOM.scrollTop;
      editor.view.scrollDOM.scrollTop = afterWheel + 500;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const closedAfterLeavingAnchor = !document.querySelector('.meo-hex-color-adjustment');
      const afterLeavingAnchor = editor.view.scrollDOM.scrollTop;
      editor.view.scrollDOM.scrollTop = afterWheel;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const stayedClosedAfterReturn = !document.querySelector('.meo-hex-color-adjustment');
      const swatch = document.querySelector<HTMLButtonElement>('tbody button[data-color-value="#336699"]');
      swatch?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        afterWheel,
        afterLeavingAnchor,
        closedAfterLeavingAnchor,
        stayedClosedAfterReturn,
        reopenedAfterClick: Boolean(document.querySelector('.meo-hex-color-adjustment'))
      };
    });
    await page.evaluate(() => (window as any).tableColorPopoverEditor.destroy());
    if (popoverBeforeWheel.popoverTop < popoverBeforeWheel.toolbarBottom) {
      throw new Error(`Table HEX dialog overlapped the editor toolbar: ${JSON.stringify(popoverBeforeWheel)}`);
    }
    if (!popoverAfterWheel.closedAfterLeavingAnchor || !popoverAfterWheel.stayedClosedAfterReturn ||
      !popoverAfterWheel.reopenedAfterClick) {
      throw new Error(`Table HEX dialog did not end its session after the anchor left the viewport: ${JSON.stringify(popoverAfterWheel)}`);
    }
    if (popoverWheelProgress.defaultPrevented ||
      popoverWheelProgress.samples.some((position) => Math.abs(position - popoverWheelProgress.samples[0]!) > 1) ||
      popoverAfterWheel.afterWheel <= popoverWheelProgress.samples.at(-1)!) {
      throw new Error(`Wheel over the table HEX dialog did not use native document scrolling: ${JSON.stringify({
        before: popoverBeforeWheel.scrollTop,
        progress: popoverWheelProgress,
        after: popoverAfterWheel.afterWheel
      })}`);
    }

    const horizontalPlacement = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('.editor-root')!;
      const wrapper = document.querySelector<HTMLElement>('.editor-wrapper')!;
      const app = document.getElementById('app')!;
      const results = [];
      for (const { width, outline, inset } of [
        { width: 420, outline: false, inset: 8 },
        { width: 750, outline: true, inset: 300 },
        { width: 220, outline: false, inset: 8 }
      ]) {
        app.replaceChildren();
        root.style.width = `${width}px`;
        root.classList.toggle('outline-visible', outline);
        wrapper.dataset.outlineMode = outline ? 'floating' : 'fixed';
        wrapper.dataset.outlinePosition = 'right';
        wrapper.querySelector('.outline-sidebar')?.remove();
        if (outline) {
          const sidebar = document.createElement('div');
          sidebar.className = 'outline-sidebar';
          wrapper.appendChild(sidebar);
        }
        const editor = (window as any).TableStabilityHarness.createEditor({
          parent: app,
          initialMode: 'live',
          text: 'Live colors\nHEX #60A5FA and #60A5FA80',
          onApplyChanges() {}
        });
        const scroller = editor.view.scrollDOM as HTMLElement;
        for (let index = 0; index < 3; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        const swatch = app.querySelector<HTMLButtonElement>('.meo-md-color-swatch-interactive');
        if (!swatch) throw new Error(`No inline HEX swatch in ${width}px fixture: ${app.textContent}`);
        const line = swatch.closest<HTMLElement>('.cm-line')!;
        line.style.textAlign = 'right';
        line.style.paddingRight = `${inset}px`;
        for (let index = 0; index < 3; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        const before = scroller.scrollWidth;
        swatch.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const dialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment')!;
        const scrollerBounds = scroller.getBoundingClientRect();
        const dialogBounds = dialog.getBoundingClientRect();
        const sidebarBounds = wrapper.querySelector('.outline-sidebar')?.getBoundingClientRect();
        results.push({ width, outline, before, after: scroller.scrollWidth,
          left: dialogBounds.left, right: dialogBounds.right,
          safeLeft: scrollerBounds.left + scroller.clientLeft + 8,
          safeRight: Math.min(scrollerBounds.left + scroller.clientLeft + scroller.clientWidth - 8,
            sidebarBounds ? sidebarBounds.left - 8 : Infinity),
          internalOverflow: dialog.scrollWidth > dialog.clientWidth + 1 });
        editor.destroy();
      }
      root.style.width = '';
      root.classList.remove('outline-visible');
      wrapper.querySelector('.outline-sidebar')?.remove();
      wrapper.removeAttribute('data-outline-mode');
      wrapper.removeAttribute('data-outline-position');
      return results;
    });
    if (horizontalPlacement.some((result) => result.after > result.before + 1 ||
      result.left < result.safeLeft - 1 || result.right > result.safeRight + 1 || result.internalOverflow)) {
      throw new Error(`HEX dialog created horizontal overflow or escaped the visible editor: ${JSON.stringify(horizontalPlacement)}`);
    }

    await page.evaluate(async () => {
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const before = Array.from({ length: 80 }, (_, index) => `Before table ${index}`);
      const after = Array.from({ length: 80 }, (_, index) => `After table ${index}`);
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: app,
        initialMode: 'live',
        text: [...before, '| Color |', '| --- |', '| #336699 |', ...after].join('\n'),
        onApplyChanges() {}
      });
      (window as any).tableViewportEditor = editor;
      const view = editor.view;
      const tablePos = before.join('\n').length + 1;
      view.scrollDOM.scrollTop = view.lineBlockAt(tablePos).top - 120;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const swatch = app.querySelector<HTMLButtonElement>('tbody button[data-color-value="#336699"]');
      if (!swatch) throw new Error('Scrolled table swatch not rendered');
    });
    await page.click('tbody button[data-color-value="#336699"]');
    await page.waitForSelector('.meo-hex-color-adjustment');
    await page.evaluate(() => {
      const app = document.getElementById('app')!;
      const view = (window as any).tableViewportEditor.view;
      const opacity = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-opacity')!;
      opacity.value = '128';
      opacity.dispatchEvent(new Event('input', { bubbles: true }));
      const initialScrollTop = view.scrollDOM.scrollTop;
      const samples = [initialScrollTop];
      const recordScroll = () => samples.push(view.scrollDOM.scrollTop);
      view.scrollDOM.addEventListener('scroll', recordScroll);
      const table = app.querySelector('tbody')!;
      const tableRect = () => table.getBoundingClientRect().top;
      const tableTop = [tableRect()];
      const removedTables: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.removedNodes) {
            if (node instanceof Element && (node.matches('.meo-md-html-table') || node.querySelector('.meo-md-html-table'))) {
              removedTables.push(node.className);
            }
          }
        }
      });
      observer.observe(view.dom, { childList: true, subtree: true });
      (window as any).__tableViewportProbe = { initialScrollTop, samples, tableTop, removedTables, observer, table, recordScroll };
    });
    await page.click('.meo-hex-color-adjustment-apply');
    const tableViewport = await page.evaluate(async () => {
      const view = (window as any).tableViewportEditor.view;
      const probe = (window as any).__tableViewportProbe;
      probe.samples.push(view.scrollDOM.scrollTop);
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        probe.samples.push(view.scrollDOM.scrollTop);
        probe.tableTop.push(probe.table.getBoundingClientRect().top);
      }
      view.scrollDOM.removeEventListener('scroll', probe.recordScroll);
      probe.observer.disconnect();
      const result = {
        initialScrollTop: probe.initialScrollTop,
        samples: probe.samples,
        tableTop: probe.tableTop,
        removedTables: probe.removedTables,
        tableConnected: probe.table.isConnected,
        selectedLine: view.state.doc.lineAt(view.state.selection.main.head).text,
        changed: (window as any).tableViewportEditor.getText().includes('| #33669980 |')
      };
      (window as any).tableViewportEditor.destroy();
      return result;
    });
    if (!tableViewport.changed || tableViewport.initialScrollTop < 100 ||
      tableViewport.samples.some((value) => Math.abs(value - tableViewport.initialScrollTop) > 20) ||
      tableViewport.tableTop.some((value) => Math.abs(value - tableViewport.tableTop[0]!) > 20) ||
      !tableViewport.tableConnected || tableViewport.removedTables.length > 0) {
      throw new Error(`Table HEX apply flashed or moved the document viewport: ${JSON.stringify(tableViewport)}`);
    }

    const liveResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const text = [
        'Live swatches',
        'HEX #abc #abcd #aabbcc #aabbccdd',
        'Plain rgb(1 2 3) rgba(1 2 3 / 40%) hsl(120 50% 40%) hsla(120 50% 40% / .5) red linear-gradient(#fff, #000)',
        'Links https://example.com/#abc HTTPS://example.com/?color=#abc //example.com/?color=#abc [section](#abc) [spaced]( #abc) tag #abc/tag code `#fff`',
        '',
        'Unmatched ` inline marker',
        '',
        'After unmatched #010203',
        `${String.fromCharCode(92)}${String.fromCharCode(96).repeat(2)}#00aa00${String.fromCharCode(96)} #00bb00`
      ].join('\n');
      let applyCount = 0;
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text,
        onApplyChanges() { applyCount += 1; }
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const swatches = Array.from(app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'));
      const inlineSwatch = swatches[0];
      const line = inlineSwatch?.closest('.cm-line');
      const walker = line ? document.createTreeWalker(line, NodeFilter.SHOW_TEXT) : null;
      let adjacentText: Text | null = null;
      while (walker?.nextNode()) {
        if (walker.currentNode.textContent?.includes('#aabbcc')) {
          adjacentText = walker.currentNode as Text;
          break;
        }
      }
      const textRange = document.createRange();
      if (adjacentText) {
        const offset = adjacentText.textContent!.indexOf('#aabbcc');
        textRange.setStart(adjacentText, offset);
        textRange.setEnd(adjacentText, offset + '#aabbcc'.length);
      }
      const swatchRect = inlineSwatch?.getBoundingClientRect();
      const textRect = adjacentText ? textRange.getBoundingClientRect() : null;
      const verticalCenterOffset = swatchRect && textRect
        ? (swatchRect.top + swatchRect.height / 2) - (textRect.top + textRect.height / 2) : null;
      const before = editor.getText();
      swatches[0]?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const textUnchangedAfterOpen = editor.getText() === before;
      const firstDialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment');
      const firstValueInput = firstDialog?.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value');
      const sixDigitOpacity = firstDialog?.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.closest<HTMLElement>('label');
      const sixDigitOpacityVisible = Boolean(sixDigitOpacity && getComputedStyle(sixDigitOpacity).display !== 'none');
      if (firstValueInput) {
        firstValueInput.value = '#1122334';
        firstValueInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const incompleteHexRejected = firstValueInput?.getAttribute('aria-invalid') === 'true' &&
        firstDialog?.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.disabled === true;
      if (firstValueInput) {
        firstValueInput.value = '#112233';
        firstValueInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const draftDoesNotWrite = editor.getText() === before;
      const draftFocusRetained = document.activeElement === firstValueInput;
      firstDialog?.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const alphaSwatch = app.querySelector<HTMLButtonElement>('[data-color-value="#aabbccdd"]');
      alphaSwatch?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const secondDialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment');
      const alphaInput = secondDialog?.querySelector<HTMLInputElement>('input[aria-label="Opacity"]');
      if (alphaInput) {
        alphaInput.value = '128';
        alphaInput.dispatchEvent(new Event('input', { bubbles: true }));
        alphaInput.value = '64';
        alphaInput.dispatchEvent(new Event('input', { bubbles: true }));
        alphaInput.value = '128';
        alphaInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const alphaDraftDoesNotWrite = editor.getText().includes('#aabbccdd');
      secondDialog?.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const adjustedText = editor.getText();
      app.querySelector<HTMLButtonElement>('[data-color-value="#010203"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const thirdValueInput = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value');
      if (thirdValueInput) {
        thirdValueInput.value = '#445566';
        thirdValueInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const canceledSwatch = app.querySelector<HTMLButtonElement>('[data-color-value="#010203"]');
      const cancelRestoredPreview = canceledSwatch?.style.backgroundColor === 'rgb(1, 2, 3)';
      const escapeCanceledDraft = editor.getText() === adjustedText;
      const dialogClosed = !app.querySelector('.meo-hex-color-adjustment');
      const undoAlpha = await editor.undo();
      const textAfterFirstUndo = editor.getText();
      const undoSixDigit = await editor.undo();
      const textAfterSecondUndo = editor.getText();
      const redoSixDigit = await editor.redo();
      const redoAlpha = await editor.redo();
      const result = {
        colors: swatches.map((swatch) => swatch.dataset.colorValue),
        tags: swatches.map((swatch) => swatch.tagName),
        popupKinds: swatches.map((swatch) => swatch.getAttribute('aria-haspopup')),
        interactiveDescendants: swatches.reduce(
          (count, swatch) => count + swatch.querySelectorAll('input, button, select, textarea').length,
          0
        ),
        textUnchangedAfterOpen,
        draftDoesNotWrite,
        draftFocusRetained,
        alphaDraftDoesNotWrite,
        firstDialogVisible: Boolean(firstDialog),
        sixDigitOpacityVisible,
        incompleteHexRejected,
        opacityVisible: Boolean(alphaInput && getComputedStyle(alphaInput.closest<HTMLElement>('label')!).display !== 'none'),
        adjustedSixDigit: adjustedText.includes('#112233'),
        adjustedEightDigit: adjustedText.includes('#aabbcc80'),
        escapeCanceledDraft,
        dialogClosed,
        cancelRestoredPreview,
        undoAlpha: undoAlpha && textAfterFirstUndo.includes('#aabbccdd') && textAfterFirstUndo.includes('#112233'),
        undoSixDigit: undoSixDigit && textAfterSecondUndo === before,
        redoBoth: redoSixDigit && redoAlpha && editor.getText() === adjustedText,
        applyCount,
        verticalCenterOffset
      };
      editor.destroy();
      return result;
    });
    if (JSON.stringify(liveResult.colors) !== JSON.stringify(['#aabbcc', '#aabbccdd', '#010203', '#00bb00'])
      || liveResult.tags.some((tag) => tag !== 'BUTTON')
      || liveResult.popupKinds.some((kind) => kind !== 'dialog')
      || liveResult.interactiveDescendants !== 0
      || !liveResult.textUnchangedAfterOpen
      || !liveResult.draftDoesNotWrite
      || !liveResult.draftFocusRetained
      || !liveResult.alphaDraftDoesNotWrite
      || !liveResult.firstDialogVisible
      || !liveResult.sixDigitOpacityVisible
      || !liveResult.incompleteHexRejected
      || !liveResult.opacityVisible
      || !liveResult.adjustedSixDigit
      || !liveResult.adjustedEightDigit
      || !liveResult.escapeCanceledDraft
      || !liveResult.dialogClosed
      || !liveResult.cancelRestoredPreview
      || !liveResult.undoAlpha
      || !liveResult.undoSixDigit
      || !liveResult.redoBoth
      || liveResult.applyCount < 2) {
      throw new Error(`Live HEX swatches must provide bounded color adjustment: ${JSON.stringify(liveResult)}`);
    }
    if (liveResult.verticalCenterOffset === null || Math.abs(liveResult.verticalCenterOffset) > 1.5) {
      throw new Error(`Live swatch must be vertically centered with adjacent text: ${JSON.stringify(liveResult)}`);
    }
    if (!result.tableDialogOpened) {
      throw new Error(`Table HEX swatch click must open the adjustment dialog: ${JSON.stringify(result)}`);
    }

    await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).colorShortcutEditor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text: 'Live swatches\nHEX #123456',
        onApplyChanges() {}
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await page.waitForSelector('.meo-md-color-swatch-interactive');
    await page.focus('.meo-md-color-swatch-interactive');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.meo-hex-color-adjustment');
    await page.keyboard.press('Escape');
    const keyboardResult = await page.evaluate(() => ({
      closed: !document.querySelector('.meo-hex-color-adjustment'),
      unchanged: (window as any).colorShortcutEditor.getText() === 'Live swatches\nHEX #123456'
    }));
    await page.click('.meo-md-color-swatch-interactive');
    await page.waitForSelector('.meo-hex-color-adjustment');
    await page.click('#outside');
    const outsideClosed = await page.evaluate(() => !document.querySelector('.meo-hex-color-adjustment'));
    await page.evaluate(() => (window as any).colorShortcutEditor.destroy());
    if (!keyboardResult.closed || !keyboardResult.unchanged || !outsideClosed) {
      throw new Error(`Swatch keyboard/outside dismissal failed: ${JSON.stringify({ keyboardResult, outsideClosed })}`);
    }

    const opacityResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text: 'Live swatches\nHEX #112233 and #aabbcc80',
        onApplyChanges() {}
      });
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (let index = 0; index < 3; index += 1) await frame();
      const open = (value: string) => app.querySelector<HTMLButtonElement>(`[data-color-value="${value}"]`)?.click();
      const setOpacity = (value: number) => {
        const slider = app.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const draft = () => app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')?.value;
      const apply = () => app.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
      open('#112233');
      await frame();
      setOpacity(128);
      const transparentDraft = draft() === '#11223380' && editor.getText().includes('#112233 and');
      setOpacity(255);
      const restoredDraft = draft() === '#112233';
      apply();
      await frame();
      const opaqueRemainsSix = editor.getText().includes('#112233 and');
      open('#112233');
      await frame();
      setOpacity(128);
      apply();
      await frame();
      const convertedToEight = editor.getText().includes('#11223380 and');
      const undone = await editor.undo() && editor.getText().includes('#112233 and');
      const redone = await editor.redo() && editor.getText().includes('#11223380 and');
      editor.scrollToLine(1, 'top');
      open('#aabbcc80');
      await frame();
      setOpacity(255);
      apply();
      await frame();
      const existingEightStaysEight = editor.getText().includes('#aabbccff');
      editor.destroy();
      return { transparentDraft, restoredDraft, opaqueRemainsSix, convertedToEight, undone, redone, existingEightStaysEight };
    });
    if (Object.values(opacityResult).some((value) => !value)) {
      throw new Error(`Six/eight-digit opacity semantics failed: ${JSON.stringify(opacityResult)}`);
    }

    const manualWidthResults = await page.evaluate(async () => {
      const app = document.getElementById('app')!;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const cases = [
        { source: '#112233', typed: '#11223380', opacity: '128', opaque: '#112233ff' },
        { source: '#112233', typed: '#112233ff', opacity: '255', opaque: '#112233ff' },
        { source: '#aabbcc80', typed: '#aabbcc', opacity: '255', opaque: '#aabbcc' }
      ];
      const results = [];
      for (const testCase of cases) {
        app.replaceChildren();
        const editor = (window as any).TableStabilityHarness.createEditor({
          parent: app, initialMode: 'live', text: `Intro\nColor ${testCase.source}`, onApplyChanges() {}
        });
        for (let index = 0; index < 3; index += 1) await frame();
        app.querySelector<HTMLButtonElement>(`.meo-md-color-swatch-interactive[data-color-value="${testCase.source}"]`)!.click();
        await frame();
        const valueInput = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')!;
        valueInput.value = testCase.typed;
        valueInput.dispatchEvent(new Event('input', { bubbles: true }));
        const ready = app.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.disabled === false;
        const preview = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-opacity')?.value === testCase.opacity;
        app.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')?.click();
        await frame();
        const applied = editor.getText() === `Intro\nColor ${testCase.typed}`;
        const undone = applied && await editor.undo() && editor.getText() === `Intro\nColor ${testCase.source}`;
        let opaqueAfterSlider = false;
        if (undone) {
          editor.scrollToLine(1, 'top');
          app.querySelector<HTMLButtonElement>(`.meo-md-color-swatch-interactive[data-color-value="${testCase.source}"]`)!.click();
          await frame();
          const nextInput = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')!;
          nextInput.value = testCase.typed;
          nextInput.dispatchEvent(new Event('input', { bubbles: true }));
          const slider = app.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-opacity')!;
          slider.value = '128';
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.value = '255';
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          opaqueAfterSlider = nextInput.value === testCase.opaque;
        }
        results.push({ source: testCase.source, typed: testCase.typed, ready, preview, applied, undone, opaqueAfterSlider });
        editor.destroy();
      }
      return results;
    });
    if (manualWidthResults.some((result) => !result.ready || !result.preview || !result.applied ||
      !result.undone || !result.opaqueAfterSlider)) {
      throw new Error(`Manual HEX width conversion failed: ${JSON.stringify(manualWidthResults)}`);
    }

    const blockBoundaryResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const backtick = String.fromCharCode(96);
      const cases = [
        `# Heading ${backtick}\nParagraph #aabbcc ${backtick}`,
        `open ${backtick}\n# Heading #aabbcc\nclose ${backtick}`
      ];
      const results: string[][] = [];
      for (const text of cases) {
        app.replaceChildren();
        const editor = harness.createEditor({ parent: app, initialMode: 'live', text, onApplyChanges() {} });
        for (let index = 0; index < 3; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        results.push(Array.from(
          app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'),
          (swatch) => swatch.dataset.colorValue ?? swatch.dataset.tooltip
        ));
        editor.destroy();
      }
      return results;
    });
    if (JSON.stringify(blockBoundaryResult) !== JSON.stringify([['#aabbcc'], ['#aabbcc']])) {
      throw new Error(`Live Markdown block boundaries diverged from Preview: ${JSON.stringify(blockBoundaryResult)}`);
    }

    const adversarialExclusionResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const count = 2_500;
      const text = Array.from({ length: count }, (_, index) => `[label #aabbcc](target-${index}) #ddeeff`).join('\n\n');
      app.replaceChildren();
      const editor = harness.createEditor({ parent: app, initialMode: 'live', text, onApplyChanges() {} });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const swatches = Array.from(
        app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'),
        (swatch) => swatch.dataset.colorValue ?? swatch.dataset.tooltip
      );
      const result = {
        count: swatches.length,
        onlyExternalHex: swatches.every((value) => value === '#ddeeff')
      };
      editor.destroy();
      return result;
    });
    if (adversarialExclusionResult.count < 1 || !adversarialExclusionResult.onlyExternalHex) {
      throw new Error(`Live exclusion stress fixture must render only external HEX values in the virtualized viewport: ${JSON.stringify(adversarialExclusionResult)}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table color swatch checks passed');
