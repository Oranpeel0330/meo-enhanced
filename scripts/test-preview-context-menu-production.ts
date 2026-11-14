import assert from 'node:assert/strict';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames } from './input-presentation-test-helpers';

const selectedText = 'Select this text.';
let primaryError: unknown;
try {
  const manifest = await Bun.file('package.json').json();
  // Extension menu references need declared metadata; a bare native command
  // can execute through the API yet disappear from a contributed menu.
  assert.deepEqual(manifest.contributes.menus['webview/context'].map((entry: any) => entry.command), [
    'meoEnhanced.preview.cut', 'meoEnhanced.preview.copy', 'meoEnhanced.preview.paste'
  ]);
  for (const entry of manifest.contributes.menus['webview/context']) {
    assert.ok(manifest.contributes.commands.some((command: any) => command.command === entry.command));
  }
  for (const action of ['copy', 'cut', 'paste']) {
    const command = `meoEnhanced.preview.${action}`;
    const descriptor = manifest.contributes.commands.find((entry: any) => entry.command === command);
    assert.ok(descriptor);
    assert.equal(descriptor.enablement, action === 'copy' ? undefined : 'meoEnhanced.previewClipboardEditable');
    assert.equal(manifest.contributes.menus.commandPalette.find((entry: any) => entry.command === command)?.when, 'false');
    const binding = manifest.contributes.keybindings.find((entry: any) => entry.command === command);
    const key = action === 'copy' ? 'c' : action === 'cut' ? 'x' : 'v';
    assert.equal(binding.key, `ctrl+${key}`);
    assert.equal(binding.mac, `cmd+${key}`);
    assert.equal(binding.when, 'webviewId == meoEnhanced.editor && webviewSection == preview-readonly');
    for (const language of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const labels = await Bun.file(language).json();
      assert.ok(labels[`command.preview.${action}`]);
    }
  }
  for (const large of [false, true]) for (const surface of ['full', 'side'] as const) {
    const text = '# Reading\n\n' + selectedText + '\n\n'
      + '<textarea>Editable value.</textarea>\n\n<input value="Readonly value" readonly>\n\n<input type="checkbox">\n\n'
      + '<fieldset disabled><textarea>Disabled value.</textarea></fieldset>\n\n'
      + (large ? 'Reading content with enough paragraphs to require a bounded window.\n\n'.repeat(5000) : 'Other content.')
      + '\n\nDocument end.';
    assert.equal(assessLargeDocument(text).windowedPreview, large);
    const page = await browser.newPage();
    const host = await open(page, text, false, surface === 'full' ? 'preview' : 'source');
    try {
      if (surface === 'side') await page.click('.source-preview-button');
      const ready = () => page.waitForFunction(() => {
        const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame');
        return document.querySelector<HTMLElement>('.preview-status')?.hidden
          && !document.querySelector<HTMLElement>('.preview-host')?.hidden
          && iframe?.contentDocument?.querySelector('main.meo-export-doc p')
          && !iframe.contentDocument.documentElement.inert;
      });
      await ready(); await frames(page);
      await page.evaluate(() => {
        const scope = window as any;
        scope.__contextMenus = [];
        scope.__consumeContextMenu = true;
        scope.__hostLastFocused = document.querySelector('.cm-content');
        window.addEventListener('focusin', () => { scope.__hostLastFocused = document.activeElement; });
        // Same boundary and cancellation as VS Code's Webview menu listener.
        window.addEventListener('contextmenu', event => {
          scope.__contextMenus.push({ x: event.clientX, y: event.clientY,
            target: (event.target as Element).className });
          scope.__menuFocusTarget = scope.__hostLastFocused?.className;
          scope.__menuContext = JSON.parse((event.target as HTMLElement).dataset.vscodeContext ?? '{}');
          if (scope.__consumeContextMenu) event.preventDefault();
        });
      });
      const selectAndRightClick = async () => {
        const frame = await (await page.$('.preview-frame'))!.contentFrame();
        assert.ok(frame);
        const state = await frame.evaluate(() => {
          const paragraph = document.querySelector('main.meo-export-doc p')!;
          const range = document.createRange(); range.selectNodeContents(paragraph);
          getSelection()!.removeAllRanges();
          const rect = range.getBoundingClientRect();
          return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2,
            top: paragraph.getBoundingClientRect().top,
            scrollTop: document.scrollingElement!.scrollTop,
            windowed: document.documentElement.dataset.meoPreviewWindowed === 'true',
            nodes: document.querySelectorAll('[data-meo-preview-block]').length };
        });
        assert.equal(state.windowed, large, 'The large case must exercise the actual windowed Preview');
        if (large) assert.ok(state.nodes < 1000, 'Right-click must retain bounded mounted content');
        const bounds = await page.$eval('.preview-frame', element => {
          const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top };
        });
        await page.mouse.move(bounds.x + state.left + 1, bounds.y + state.y);
        await page.mouse.down();
        await page.mouse.move(bounds.x + state.right - 1, bounds.y + state.y, { steps: 8 });
        await page.mouse.up();
        assert.equal(await frame.evaluate(() => getSelection()!.toString()), selectedText);
        // Preview forbids authored scripts. Register observers from the outer
        // realm, as production does, rather than adding blocked frame scripts.
        await page.evaluate(() => {
          (window as any).__childMenuCanceled = undefined;
          const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
          doc.defaultView!.addEventListener('contextmenu', event => {
            (window as any).__childMenuCanceled = event.defaultPrevented;
          }, { once: true });
        });
        const point = { x: Math.round(bounds.x + state.left + 12), y: Math.round(bounds.y + state.y) };
        await page.mouse.click(point.x, point.y, { button: 'right' });
        const after = await frame.evaluate(() => ({ selection: getSelection()!.toString(),
          top: document.querySelector('main.meo-export-doc p')!.getBoundingClientRect().top,
          scrollTop: document.scrollingElement!.scrollTop }));
        assert.equal(after.selection, selectedText, 'Opening the host menu must retain the reading selection');
        assert.ok(Math.abs(after.top - state.top) <= 1);
        assert.ok(Math.abs(after.scrollTop - state.scrollTop) <= 1);
        return { frame, point, after: { ...after, canceled: await page.evaluate(() => (window as any).__childMenuCanceled) } };
      };
      const { frame, point, after } = await selectAndRightClick();
      assert.deepEqual(await page.evaluate(() => (window as any).__contextMenus),
        [{ ...point, target: 'preview-frame' }], `${surface}/${large}: right click must reach the host once at the correct position`);
      assert.equal(after.canceled, true, 'A handled host menu must suppress the inner browser menu');
      assert.equal(await page.evaluate(() => (window as any).__menuFocusTarget), 'preview-frame',
        'The host must remember Preview before its menu borrows focus');
      assert.deepEqual(await page.evaluate(() => (window as any).__menuContext),
        { webviewSection: 'preview-readonly', 'meoEnhanced.previewClipboardEditable': false, preventDefaultContextMenuItems: true },
        'Reading content must use the readonly host menu');
      assert.equal(await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        doc.addEventListener('copy', event => {
          (window as any).__copiedSelection = doc.defaultView!.getSelection()!.toString();
          event.preventDefault();
        }, { once: true });
        // VS Code executes clipboard commands on the outer content Document.
        document.querySelector<HTMLElement>('.preview-frame')!.blur();
        (window as any).__hostLastFocused?.focus({ preventScroll: true });
        return document.execCommand('copy');
      }), true);
      assert.equal(await page.evaluate(() => (window as any).__copiedSelection), selectedText,
        'Host copy must use the focused Preview selection');
      await page.evaluate(() => document.execCommand('cut'));
      await frames(page);
      assert.equal(host.readHost(), text, 'Host Cut from read-only Preview must not edit the Source document');

      await page.evaluate(() => { (window as any).__contextMenus = []; });
      await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.body
        .addEventListener('contextmenu', event => event.preventDefault(), { once: true }));
      await page.mouse.click(point.x, point.y, { button: 'right' });
      assert.deepEqual(await page.evaluate(() => (window as any).__contextMenus), [], 'Already handled menus must stay inside Preview');
      await frame.evaluate(() => document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      assert.deepEqual(await page.evaluate(() => (window as any).__contextMenus), [], 'Synthetic page events must not open host menus');

      await page.evaluate(() => { (window as any).__consumeContextMenu = false; });
      assert.equal((await selectAndRightClick()).after.canceled, false, 'Without a host menu, keep the native browser default');
      await page.evaluate(() => { (window as any).__consumeContextMenu = true; (window as any).__contextMenus = []; });
      const updatedText = text.replace('# Reading', '# Reading updated');
      await host.replaceHostText(updatedText);
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.getElementById('reading-updated'));
      await ready(); await frames(page);
      await selectAndRightClick();
      assert.equal(await page.evaluate(() => (window as any).__contextMenus.length), 1, 'Refresh must retain exactly one menu listener');
      if (surface === 'full') {
        await page.click('[data-mode="source"]');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
          && !document.querySelector('.mode-group [aria-busy="true"]'));
        await page.click('[data-mode="preview"]');
      } else {
        await page.click('.source-preview-button');
        await page.click('.source-preview-button');
      }
      await ready(); await frames(page);
      await page.evaluate(() => { (window as any).__contextMenus = []; });
      const returned = await selectAndRightClick();
      assert.equal(await page.evaluate(() => (window as any).__contextMenus.length), 1, 'Reopening must not duplicate host menus');
      if (large) {
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          write: async (items: ClipboardItem[]) => { (window as any).__copiedAll = await (await items[0]!.getType('text/plain')).text(); },
          writeText: async (value: string) => { (window as any).__copiedAll = value; }
        } }));
        await page.keyboard.down('Control');
        try { await page.keyboard.press('a'); } finally { await page.keyboard.up('Control'); }
        await page.evaluate(() => document.execCommand('copy'));
        await page.waitForFunction(() => typeof (window as any).__copiedAll === 'string');
        const copied = await page.evaluate(() => (window as any).__copiedAll as string);
        assert.ok(copied.includes(selectedText) && copied.includes('Document end.'));
        assert.equal(copied.match(/Reading content with enough paragraphs/g)?.length, 5000,
          'Host copy must retain the existing complete logical selection, including unmounted blocks');
      }
      assert.equal(await returned.frame.evaluate(() => document.documentElement.dataset.meoPreviewWindowed === 'true'), large);
      for (const [selector, editable] of [['textarea', true], ['input[readonly]', false], ['input[type="checkbox"]', false], ['fieldset textarea', false]] as const) {
        const point = await page.evaluate(selector => {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
          const bounds = frame.getBoundingClientRect();
          const rect = frame.contentDocument!.querySelector(selector)!.getBoundingClientRect();
          return { x: bounds.left + rect.left + Math.min(8, rect.width / 2), y: bounds.top + rect.top + rect.height / 2 };
        }, selector);
        await page.mouse.click(point.x, point.y, { button: 'right' });
        assert.deepEqual(await page.evaluate(() => (window as any).__menuContext), {
          webviewSection: editable ? 'preview-input' : 'preview-readonly',
          'meoEnhanced.previewClipboardEditable': editable,
          preventDefaultContextMenuItems: !editable
        }, `${surface}/${large}: ${selector} must publish its actual editing capability`);
      }
      assert.equal(host.readHost(), updatedText, 'Reading menus and copy must not edit the document');
      assert.deepEqual(host.errors, []);
      console.log(`PASS ${surface} ${large ? 'windowed' : 'ordinary'} Preview context menu: coordinates, selection, host copy, cancellation and refresh`);
    } finally { host.dispose(); await page.close(); }
  }
} catch (error) { primaryError = error; throw error; }
finally {
  try {
    if (primaryError !== undefined) await closeTestBrowser(browser, primaryError);
    else await closeTestBrowser(browser);
  } finally { server.stop(true); }
}
