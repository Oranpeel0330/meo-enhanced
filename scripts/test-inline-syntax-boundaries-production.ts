import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { inlineSyntaxBoundaryFixtures } from './inline-syntax-boundary-fixtures';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-inline-syntax-boundaries-'));

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame += 1) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

async function snapshot(page: Page, selector: string, witnessTexts: readonly string[] = []) {
  return page.evaluate(({ selector, witnessTexts }) => {
    const root = document.querySelector(selector)!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: string[][] = [];
    const targetElements: HTMLElement[] = [];
    const visibleText: string[] = [];
    const witnesses = witnessTexts.map(text => ({ text, styles: [] as string[][] }));
    const selectors = {
      emphasis: '.meo-md-em, em, i', strong: '.meo-md-strong, strong, b',
      strikethrough: '.meo-md-strike, s, del', highlight: '.meo-md-highlight, mark',
      code: '.meo-md-inline-code, code, .meo-md-code-block, .meo-md-code-line, .meo-md-codeblock',
      subscript: '.meo-md-subscript, sub', superscript: '.meo-md-superscript, sup'
    };
    while (walker.nextNode()) {
      const element = walker.currentNode.parentElement!;
      if (element.closest('button, .katex, .meo-md-code-language, .meo-md-codeblock-language')) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      if (!Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)) continue;
      const text = walker.currentNode.textContent ?? '';
      if (!element.closest('.meo-md-marker, .meo-md-marker-active, .meo-md-code-marker, .meo-md-code-marker-active, .meo-md-escape-marker')) visibleText.push(text);
      if (text.includes('TARGET')) {
        targets.push(Object.entries(selectors).filter(([, css]) => element.closest(css)).map(([name]) => name).sort());
        targetElements.push(element);
      }
      for (const witness of witnesses) if (text.includes(witness.text)) witness.styles.push(Object.entries(selectors).filter(([, css]) => element.closest(css)).map(([name]) => name).sort());
    }
    return {
      targets, witnesses, text: visibleText.join(''),
      visibleMarkers: Array.from(root.querySelectorAll('.meo-md-marker-active, .meo-md-code-marker-active')).filter(element => element.getBoundingClientRect().width > 0).length,
      links: targetElements.map(element => element.closest('a')?.getAttribute('href') ?? element.closest('[data-meo-link-href]')?.getAttribute('data-meo-link-href')).filter(Boolean),
      mathCount: root.querySelectorAll('.meo-md-math, .meo-export-math').length
    };
  }, { selector, witnessTexts });
}

const failures: string[] = [];

async function checkLocalSource(page: Page) {
  const paddedCode = '`` Padded \\| code ``';
  const fragments: ReadonlyArray<readonly [string, string, string?]> = [
    ['**Alpha**', 'Alpha'], ['_Beta_', 'Beta'], ['~~Gamma~~', 'Gamma'],
    ['==Delta==', 'Delta'], ['`Epsilon`', 'Epsilon'], ['~lower~', 'lower'],
    ['^upper^', 'upper'], ['[Label](https://example.test/target "title")', 'Label'],
    ['[[Wiki]]', 'Wiki'], ['<kbd>Tab</kbd>', 'Tab'], ['$x+1$', 'x+1'],
    ['$y+2$', 'y+2'], ['![Figure](fixture.svg)', 'Figure'], ['<code>HtmlCode</code>', 'HtmlCode'],
    ['**RefLabel**', 'RefLabel', '[**RefLabel**][ref]'], ['[^note]', 'note'], ['<https://auto.test>', 'auto'],
    ['**LinkedBold**', 'LinkedBold', '[**LinkedBold**](https://example.test/wrapped-label "title")'],
    ['**PairedLabel**', 'PairedLabel', '[**PairedLabel** ![LabelImage](fixture.svg)](https://example.test/with-image)'],
    ['`PathCode`', 'PathCode', '**Tool `PathCode` and _SiblingWitness_**'],
    [paddedCode, 'Padded'],
    ['_Inner_', 'Inner', '**Parent _Inner_ tail**']
  ];
  const formatWitnesses: Record<string, readonly [string, keyof CSSStyleDeclaration]> = {
    Alpha: ['strong', 'fontWeight'], Beta: ['em', 'fontStyle'], Gamma: ['.meo-md-strike', 'textDecorationLine'],
    Delta: ['mark', 'backgroundColor'], Epsilon: ['code', 'backgroundColor'], lower: ['sub', 'verticalAlign'],
    upper: ['sup', 'verticalAlign'], Label: ['.meo-md-link', 'color'], Wiki: ['.meo-md-link', 'color'],
    Tab: ['kbd', 'borderBottomWidth'], HtmlCode: ['code', 'fontFamily'], auto: ['.meo-md-link', 'color'],
    LinkedBold: ['.meo-md-link strong', 'fontWeight'], PathCode: ['strong code', 'fontFamily'], Padded: ['code', 'fontFamily']
  };
  const text = fragments.map(([raw, , markup]) => markup ?? raw).join(' and ')
    + ' then **LeftEdge**`RightEdge` afterward<br>Break witness<BR />Last witness';
  for (const large of [false, true]) for (const table of [false, true]) {
    const suffix = '\n\n[ref]: https://example.test/reference\n\n[^note]: Footnote body.\n\nAfter.'
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    const source = (table ? `| Header |\n| --- |\n| ${text} |` : `> ## ${text}`) + suffix;
    const root = table ? 'tbody .meo-md-html-table-cell-preview' : '.cm-content';
    await page.evaluate(({ source, large }) => {
      const harness = (window as any).InlineCodeLayoutHarness;
      (window as any).boundaryEditor?.destroy();
      harness.applyBuiltInVisualBaseline(large ? 'light' : 'dark');
      harness.setImageSrcResolver(() => 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="48"><rect width="24" height="48" fill="teal"/></svg>'
      ));
      const editor = (window as any).boundaryEditor = harness.createEditor({
        parent: document.getElementById('app'), text: source, initialMode: 'live', onApplyChanges() {}
      });
      editor.view.dispatch({ selection: { anchor: source.indexOf('After.') } });
    }, { source, large });
    await page.waitForFunction(large => (window as any).InlineCodeLayoutHarness
      .usesLargeDocumentDerivedWorkBudget((window as any).boundaryEditor.view.state) === large, {}, large);
    await page.waitForSelector('.cm-content .meo-md-image-img');
    const readFormats = (witnesses: typeof formatWitnesses) => page.$eval(root, (root, witnesses) => {
      const formats: Record<string, unknown> = {};
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        for (const [word, [selector, property]] of Object.entries(witnesses)) {
          if (word in formats || !node.textContent?.includes(word)) continue;
          const element = node.parentElement?.closest(selector);
          if (element) formats[word] = getComputedStyle(element)[property];
        }
      }
      return formats;
    }, witnesses);
    const readingFormats = table ? await readFormats(formatWitnesses) : {};
    if (table) assert.equal(Object.keys(readingFormats).length, Object.keys(formatWitnesses).length, 'all reading style witnesses are visible in the cell');
    const pointIn = (selector: string, word: string, offset = 2) => page.$eval(selector, (element, { word, offset }) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text && !text.textContent?.includes(word)) text = walker.nextNode();
      if (!text) throw new Error(`Missing click target ${word}`);
      const start = text.textContent!.indexOf(word);
      const range = document.createRange();
      range.setStart(text, start + offset);
      range.setEnd(text, start + offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 5, y: rect.top + rect.height / 2 };
    }, { word, offset });
    const boldPoint = await pointIn(`${root} ${table ? 'strong' : '.meo-md-strong'}`, 'Alpha');
    const reading = table ? await page.$eval('tbody tr', row => row.getBoundingClientRect().height) : 0;
    await page.mouse.move(boldPoint.x, boldPoint.y);
    await settle(page);
    assert.equal(await page.$(table ? 'tbody .meo-md-table-inline-source' : '.cm-content .meo-md-strong-marker-active'), null,
      'hover preserves the reading presentation');
    await page.mouse.click(boldPoint.x, boldPoint.y);
    if (table) {
      assert(await page.$eval('tbody textarea', input => input === document.activeElement
        && input.selectionStart === input.value.indexOf('Alpha') + 2), 'table click maps through the hidden markers');
    } else {
      assert.equal(await page.evaluate(() => (window as any).boundaryEditor.view.state.selection.main.head),
        source.indexOf('Alpha') + 2, 'prose click maps through the hidden markers');
    }
    const placeCaret = (raw: string, offset: number) => page.evaluate(({ raw, offset, table }) => {
      if (table) {
        const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
        const pos = input.value.indexOf(raw) + offset;
        input.setSelectionRange(pos, pos);
        input.dispatchEvent(new Event('selectionchange'));
      } else {
        const view = (window as any).boundaryEditor.view;
        const pos = view.state.doc.toString().indexOf(raw) + offset;
        view.focus();
        view.dispatch({ selection: { anchor: pos } });
      }
    }, { raw, offset, table });
    const visibleText = () => page.$eval(root, root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let result = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('button, .katex')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some(rect => rect.width > .5 && rect.height > .5)) result += node.textContent;
      }
      return result;
    });
    for (const [raw, word] of fragments) {
      await placeCaret(raw, raw.indexOf(word) + 1);
      await settle(page);
      const visible = await visibleText();
      assert.ok(visible.includes(raw), `${table ? 'table' : 'prose'} reveals ${raw}: ${visible}`);
      for (const [neighbor] of fragments) if (neighbor !== raw)
        assert.ok(!visible.includes(neighbor), `${raw} leaves ${neighbor} rendered: ${visible}`);
      if (raw === '_Inner_') assert.ok(visible.includes('**Parent _Inner_ tail**'));
      if (raw === '`PathCode`') assert.ok(visible.includes('**Tool `PathCode` and SiblingWitness**'), 'other children of an active ancestor stay rendered');
      if (raw === '**LinkedBold**') assert.ok(visible.includes('[**LinkedBold**](https://example.test/wrapped-label "title")'));
      if (raw === '**RefLabel**') assert.ok(visible.includes('[**RefLabel**][ref]'));
      if (raw === '**PairedLabel**') {
        assert.ok(visible.includes('](https://example.test/with-image)'));
        assert.ok(await page.$(`${root} img[alt="LabelImage"]`), 'an image next to the active label fragment stays rendered');
      }
      if (table) {
        const witness = formatWitnesses[word];
        if (witness) assert.deepEqual(await readFormats({ [word]: witness }), { [word]: readingFormats[word] },
          `revealing ${raw} retains the displayed style of ${word}`);
        const ticks = /^`+/.exec(raw)?.[0];
        if (ticks || raw.startsWith('<code>')) {
          const code = await page.$eval(`${root} .meo-md-table-inline-source code`, code => ({
            text: code.textContent,
            markers: Array.from(code.querySelectorAll(':scope > .meo-md-table-inline-marker'), marker => marker.textContent)
          }));
          assert.deepEqual(code, ticks ? { text: raw, markers: [ticks, ticks] } : { text: word, markers: [] },
            `${raw} places its delimiters in the appropriate painted region`);
        }
        assert.ok(await page.$eval('tbody tr', row => row.getBoundingClientRect().height) >= reading - 1,
          `${raw} retains its row's reading height`);
      } else {
        assert.ok(visible.includes('>') && visible.includes('##'), 'the current quote and heading prefixes remain editable');
      }
    }
    for (const [raw, offset] of [['**Alpha**', 0], ['**Alpha**', '**Alpha**'.length], ['`Epsilon`', 0], ['`Epsilon`', '`Epsilon`'.length]] as const) {
      await placeCaret(raw, offset);
      await settle(page);
      assert.ok((await visibleText()).includes(raw), `${table ? 'table' : 'prose'} reveals ${raw} at endpoint ${offset}`);
    }
    for (const [raw, offset, key, neighbor] of [
      ['**LeftEdge**', '**LeftEdge**'.length - 1, 'ArrowRight', '`RightEdge`'],
      ['`RightEdge`', 1, 'ArrowLeft', '**LeftEdge**']
    ] as const) {
      await placeCaret(raw, offset);
      await settle(page);
      await page.keyboard.press(key);
      await settle(page);
      const visible = await visibleText();
      assert.ok(visible.includes(raw) && !visible.includes(neighbor), `a shared boundary keeps the approached fragment: ${visible}`);
      const atBoundary = await page.evaluate(({ raw, key, table }) => {
        const offset = key === 'ArrowRight' ? raw.length : 0;
        if (table) {
          const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
          return input.selectionStart === input.value.indexOf(raw) + offset;
        }
        const view = (window as any).boundaryEditor.view;
        return view.state.selection.main.head === view.state.doc.toString().indexOf(raw) + offset;
      }, { raw, key, table });
      assert.ok(atBoundary, `${key} lands on the shared source boundary`);
    }
    await placeCaret('**Alpha**', '**Alpha**'.length + 1);
    await settle(page);
    assert.ok(!(await visibleText()).includes('**Alpha**'), 'an intervening space keeps the fragment rendered');
    await placeCaret('https://example.test/wrapped-label', 8);
    await settle(page);
    const linkTarget = await visibleText();
    assert.ok(linkTarget.includes('[LinkedBold](https://example.test/wrapped-label "title")'), 'editing the target leaves nested text formatting rendered');
    await placeCaret('Break witness', 2);
    await settle(page);
    const visibleBreak = await visibleText();
    assert.ok(visibleBreak.includes('Break witness<BR />Last witness') && !visibleBreak.includes('afterward<br>'),
      'only the active logical line displays its terminating break');
    const nestedPoint = await pointIn(`${root} .meo-md-link[data-meo-link-href="https://example.test/wrapped-label"]`, 'LinkedBold');
    await page.mouse.click(nestedPoint.x, nestedPoint.y);
    await settle(page);
    assert.ok((await visibleText()).includes('[**LinkedBold**](https://example.test/wrapped-label "title")'));
    if (table) {
      assert(await page.$eval('tbody textarea', input => input === document.activeElement
        && input.selectionStart === input.value.indexOf('LinkedBold') + 2), 'reflow keeps the clicked label offset in the cell');
    } else {
      assert.equal(await page.evaluate(() => (window as any).boundaryEditor.view.state.selection.main.head),
        source.indexOf('LinkedBold') + 2, 'reflow keeps the clicked label offset in prose');
    }
    if (!large && process.env.MEO_TEST_SCREENSHOTS) {
      fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, `local-source-${table ? 'table' : 'prose'}.png`) });
    }
    if (table) {
      await placeCaret(paddedCode, 4);
      await settle(page);
      const projected = `${root} .meo-md-table-inline-source`;
      const appearance = await page.$eval(projected, el => {
        const markers = Array.from(el.querySelectorAll('.meo-md-table-inline-marker'));
        const code = el.querySelector('code')!;
        return {
          markers: markers.map(marker => marker.textContent),
          visible: markers.every(marker => marker.getBoundingClientRect().width > 0),
          ink: markers.map(marker => getComputedStyle(marker).webkitTextFillColor),
          codeInk: getComputedStyle(code).webkitTextFillColor,
          background: getComputedStyle(code).backgroundColor
        };
      });
      assert.deepEqual(appearance.markers, ['``', '``']);
      assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)', 'the code region paints its background');
      assert.ok(appearance.visible && appearance.ink[0] === appearance.ink[1] && appearance.ink[0] !== appearance.codeInk,
        'visible source punctuation uses the theme syntax color within the code region');
      if (!large && process.env.MEO_TEST_SCREENSHOTS) {
        await page.screenshot({ path: path.join(process.env.MEO_TEST_SCREENSHOTS, 'local-source-table-code.png') });
      }
      const delimiter = await pointIn(`${projected} .meo-md-table-inline-marker`, '``', 1);
      await page.mouse.click(delimiter.x, delimiter.y);
      assert(await page.$eval('tbody textarea', (input, raw) => input.selectionStart === input.value.indexOf(raw) + 1, paddedCode),
        'the second backtick maps to the original source offset');
      const closing = await pointIn(`${projected} code > .meo-md-table-inline-marker:last-child`, '``', 0);
      await page.mouse.click(closing.x, closing.y);
      assert(await page.$eval('tbody textarea', (input, raw) => input.selectionStart === input.value.indexOf(raw) + raw.length - 2, paddedCode),
        'the closing backticks map to the correct end of the payload');
      const escape = await pointIn(`${projected} code`, '\\|', 0);
      await page.mouse.click(escape.x, escape.y);
      assert(await page.$eval('tbody textarea', input => input.selectionStart === input.value.indexOf('\\|')),
        'the restored escape character inside styled code has a precise caret');
      const composition = await page.createCDPSession();
      try {
        await composition.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
        const preedit = await page.$eval('tbody textarea', input => ({
          value: input.value,
          markerVisibility: getComputedStyle(input.parentElement!.querySelector('.meo-md-table-inline-marker')!).visibility,
          codeVisibility: getComputedStyle(input.parentElement!.querySelector('.meo-md-table-inline-source code')!).visibility
        }));
        assert.ok(preedit.value.includes(' Padded zhong\\| code '), 'the native input receives the composition at the clicked offset');
        assert.equal(preedit.markerVisibility, 'hidden', 'the native composition owns the punctuation paint');
        assert.equal(preedit.codeVisibility, 'hidden', 'the native composition owns the text paint');
        await composition.send('Input.insertText', { text: '中' });
      } finally {
        await composition.detach();
      }
      assert.equal(await page.$eval(`${projected} code`, code => code.textContent), paddedCode.replace('Padded ', 'Padded 中'));
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => (window as any).boundaryEditor.undo()), true);
    }
    assert.equal(await page.evaluate(() => (window as any).boundaryEditor.getText()), source);
    if (table) await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const view = (window as any).boundaryEditor.view;
      const old = 'https://example.test/reference';
      const from = view.state.doc.toString().indexOf(old);
      view.dispatch({ changes: { from, to: from + old.length, insert: 'https://example.test/updated' } });
    });
    await page.waitForSelector(`${table ? 'tbody' : '.cm-content'} .meo-md-link[data-meo-link-href="https://example.test/updated"]`,
      { timeout: 5000 });
  }
  console.log('Local inline source passed in Live prose and table cells.');
}

async function main(): Promise<void> {
  const build = await Bun.build({ entrypoints: [path.join(repoRoot, 'scripts/test-inline-code-layout-entry.ts')], outdir: tempDir, target: 'browser', format: 'iife', naming: 'bundle.js' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    const live = await browser.newPage();
    const preview = await browser.newPage();
    await live.bringToFront();
    await live.setViewport({ width: 1250, height: 800 });
    await preview.setViewport({ width: 1250, height: 800 });
    await live.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
    await live.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
    await live.addStyleTag({ content: `
      body .cm-editor { --meo-foreground: #e6edf3; --meo-background: #24292e; color: var(--meo-foreground); }
      html[data-editor-appearance="light"] body .cm-editor { --meo-foreground: #24292e; --meo-background: #fff; }
    ` });
    await live.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await checkLocalSource(live);
    if (process.argv.includes('--local-source-only')) return;
    for (const theme of ['dark', 'light'] as const) {
      for (const fixture of inlineSyntaxBoundaryFixtures) {
        const doc = `${fixture.markdown}\n\nCaret sentinel.`;
        const rendered = exportRuntime.renderPreviewDocument({ markdownText: fixture.markdown, sourceDocumentPath: path.join(repoRoot, 'inline-boundaries.md'), uiLanguage: 'en', styleEnvironment: { previewFontFamily: '', previewShowComments: true } });
        await preview.setContent(`<!doctype html><style>${rendered.styles[theme]}</style><main class="meo-export-content">${rendered.html}</main>`);
        await live.evaluate(({ doc, theme }) => {
          const w = window as any;
          w.boundaryEditor?.destroy();
          w.InlineCodeLayoutHarness.applyBuiltInVisualBaseline(theme);
          w.boundaryEditor = w.InlineCodeLayoutHarness.createEditor({ parent: document.getElementById('app'), text: doc, initialMode: 'live', uiLanguage: 'en', onApplyChanges() {} });
          w.boundaryEditor.view.dispatch({ selection: { anchor: doc.length } });
        }, { doc, theme });
        await settle(live);
        for (const mode of ['live', 'preview', 'live-active'] as const) {
          if (mode === 'live-active') {
            await live.evaluate(anchor => {
              const view = (window as any).boundaryEditor.view;
              view.focus(); view.dispatch({ selection: { anchor } });
            }, doc.indexOf('TARGET') + 2);
            await settle(live);
          }
          const sample = await snapshot(mode === 'preview' ? preview : live, mode === 'preview' ? 'main' : '.cm-content', fixture.witnesses?.map(witness => witness.text));
          try {
            const expected = [...(mode === 'live-active' ? fixture.activeStyles ?? fixture.styles : fixture.styles)].sort();
            assert.deepEqual(sample.targets, [expected], 'target formatting');
            if (mode === 'live-active' && fixture.activeLiteral)
              assert.ok(sample.text.includes(fixture.activeLiteral), 'active HTML reveals its exact source');
            for (const [index, witness] of (fixture.witnesses ?? []).entries()) assert.deepEqual(sample.witnesses[index]!.styles, [[...witness.styles].sort()], `${witness.text} formatting`);
            if (fixture.literal) {
              // Live can reveal escape slashes as source syntax; escaped tags must still stay literal.
              const text = ['html-escaped-pair', 'escaped-style'].includes(fixture.name) && mode !== 'preview' ? sample.text.replace(/\\(?=[<>*])/g, '') : sample.text;
              assert.ok(text.includes(fixture.literal), `missing literal ${fixture.literal}: ${sample.text}`);
            }
            if (fixture.mathCount !== undefined) {
              if (mode === 'live-active' && fixture.mathCount > 0 && sample.mathCount === 0) {
                for (const raw of fixture.markdown.match(/\$[^$\n]+\$/g) ?? []) assert.ok(sample.text.includes(raw), `active formula source ${raw}`);
              }
              else assert.equal(sample.mathCount, fixture.mathCount, 'math count');
            }
            if (fixture.forbiddenLiteral && (mode !== 'live-active' || sample.mathCount > 0)) assert.ok(!sample.text.includes(fixture.forbiddenLiteral), `unexpected literal ${fixture.forbiddenLiteral}`);
            if (fixture.href) assert.deepEqual(sample.links, [fixture.href], 'complete target link');
            if (mode !== 'preview') {
              assert.equal(await live.evaluate(() => (window as any).boundaryEditor.view.state.doc.toString()), doc, 'rendering must preserve the document');
              if (fixture.name === 'code-*') assert.equal(sample.visibleMarkers > 0, mode === 'live-active', 'code marker reveal follows selection');
            }
          } catch (error) { failures.push(`${theme}/${fixture.name}/${mode}: ${String(error)}`); }
        }
        if (fixture.name.startsWith('table-style-')) {
          const cell = 'tbody td:first-child .meo-md-html-table-cell-preview';
          await live.click(cell);
          const input = await live.evaluate(() => {
            const element = document.activeElement as HTMLTextAreaElement;
            return { tag: element.tagName, text: element.value };
          });
          assert.equal(input.tag, 'TEXTAREA', 'native table cell entered editing');
          assert.equal(input.text, fixture.markdown.split('\n')[2]!.slice(1, -1).trim(), 'table source preserves markers');
          await live.keyboard.press('Escape');
          await settle(live);
          const committed = await snapshot(live, '.cm-content');
          assert.deepEqual(committed.targets, [[...fixture.styles].sort()], 'native table cell restores formatting');
          assert.equal(await live.evaluate(() => (window as any).boundaryEditor.view.state.doc.toString()), doc, 'table editing preserves the document');
        }
        if (fixture.name === 'nested-1-0') {
          const closing = doc.indexOf('** OUTSIDE');
          await live.evaluate(({ from, to }) => {
            (window as any).boundaryEditor.view.dispatch({ selection: { anchor: from, head: to } });
          }, { from: closing, to: closing + 2 });
          await live.keyboard.press('Backspace');
          await settle(live);
          const invalidated = await snapshot(live, '.cm-content', ['AFTER']);
          assert.deepEqual(invalidated.targets, [['emphasis']], 'removing outer close releases its style');
          assert.deepEqual(invalidated.witnesses[0]!.styles, [[]], 'released style stays inside remaining markers');
          await live.keyboard.down('Control');
          await live.keyboard.press('z');
          await live.keyboard.up('Control');
          await settle(live);
          assert.equal(await live.evaluate(() => (window as any).boundaryEditor.view.state.doc.toString()), doc, 'undo restores source');
          assert.deepEqual((await snapshot(live, '.cm-content')).targets, [[...fixture.styles].sort()], 'undo restores nested styles');
        }
      }
      console.log(`Inline boundaries: ${theme}, ${inlineSyntaxBoundaryFixtures.length} fixtures checked.`);
    }
  } finally { await browser.close(); }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('Production Live/Preview inline syntax boundaries passed (inactive and selected, dark and light).');
}

try { await main(); } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
