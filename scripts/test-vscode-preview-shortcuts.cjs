// Real workbench commands and menus, using only the runner's disposable profile.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { findActiveWebview, readWebviewPoint } = require('./native-input-delivery.cjs');

exports.run = async () => {
  const output = process.env.MEO_SHORTCUT_OUTPUT;
  assert.ok(output && path.isAbsolute(output));
  const workspace = path.join(output, 'workspace');
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), workspace.toLowerCase());
  const file = path.join(workspace, 'preview-shortcuts.md');
  const text = '# Reading\n\nSelect and copy this paragraph.\n\n<textarea>Editable field.</textarea>\n\n' + 'More content.\n\n'.repeat(40);
  fs.writeFileSync(file, text);
  const report = { vscode: vscode.version, runs: [], passed: false };
  const previousClipboard = await vscode.env.clipboard.readText();
  let browser;
  try {
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    report.phase = 'connect';
    browser = await puppeteer.connect({ browserURL: process.env.MEO_SHORTCUT_BROWSER_URL, defaultViewport: null });
    report.phase = 'open';
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'meoEnhanced.editor');
    report.phase = 'find-webview';
    let target;
    const deadline = Date.now() + 30000;
    while (!target && Date.now() < deadline) {
      try { target = await findActiveWebview(browser, 'Select and copy this paragraph.'); }
      catch { /* The new disposable document has not been presented yet. */ }
      if (!target) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(target, 'MEO webview did not open');
    const { frame, page } = target;
    await frame.waitForFunction(() => document.querySelector('.editor-host')?.inert === false
      && document.querySelector('.editor-loading')?.hidden === true);
    await page.bringToFront();
    report.phase = 'baseline';
    const chord = async (key, alt = false) => {
      await page.keyboard.down('Control');
      if (alt) await page.keyboard.down('Alt');
      try { await page.keyboard.press(key); }
      finally { if (alt) await page.keyboard.up('Alt'); await page.keyboard.up('Control'); }
    };
    const expectClipboard = async (expected, label) => {
      const deadline = Date.now() + 5000;
      let actual;
      while ((actual = await vscode.env.clipboard.readText()) !== expected) {
        if (Date.now() > deadline) {
          report.clipboardFailure = { label, expected, actual,
            workbench: await page.evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.className })),
            document: await frame.evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.className,
              previewSelection: document.querySelector('.preview-frame')?.contentWindow?.getSelection()?.toString() })) };
          throw Error(`${label}: Copy did not copy the Preview selection`);
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    };
    const readMenuItems = () => page.evaluate(() => [...document.querySelectorAll('.context-view .action-label')]
      .filter(label => label.getBoundingClientRect().height > 0)
      .map(label => ({ label: label.textContent.trim(), disabled: !!label.closest('[aria-disabled="true"], .disabled'),
        keybinding: label.closest('.action-menu-item')?.querySelector('.keybinding')?.textContent.trim() || '' })));
    const readMenuLayout = () => page.evaluate(() => {
      const menu = [...document.querySelectorAll('.context-view .monaco-menu')].find(element => element.getBoundingClientRect().height > 0);
      const row = menu.querySelector('.action-menu-item'), label = row.querySelector('.action-label');
      const rect = menu.getBoundingClientRect(), style = getComputedStyle(label);
      return { width: rect.width, height: rect.height, rowHeight: row.getBoundingClientRect().height,
        fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
    const previewMenus = report.previewMenus = [];
    const expectQuickInput = async (surface, gesture, commands) => {
      await page.waitForFunction(() => {
        const widget = document.querySelector('.quick-input-widget');
        return widget && widget.getBoundingClientRect().height > 0 && getComputedStyle(widget).display !== 'none';
      }, { timeout: 4000 });
      const value = await page.$eval('.quick-input-widget input', input => input.value);
      assert.equal(value.startsWith('>'), commands, `${surface}: ${gesture} opened the wrong workbench UI (${value})`);
      report.runs.push({ surface, gesture, value });
      if (surface === 'preview' && gesture === 'Ctrl+Alt+P') await page.screenshot({ path: path.join(output, 'command-center.png') });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => {
        const widget = document.querySelector('.quick-input-widget');
        return !widget || getComputedStyle(widget).display === 'none' || widget.getBoundingClientRect().height === 0;
      }, { timeout: 4000 });
    };
    // A toolbar/editor baseline proves the profile binding and native test input work.
    await frame.$eval('[data-mode="live"]', button => button.click());
    await frame.waitForFunction(() => document.querySelector('#app')?.dataset.mode === 'live'
      && document.querySelector('.editor-host')?.inert === false
      && document.querySelector('.editor-loading')?.hidden === true
      && !document.querySelector('.mode-group [aria-busy="true"]'));
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await frame.$eval('.editor-host .cm-content', content => content.focus({ preventScroll: true }));
    report.baseline = await frame.evaluate(() => ({ mode: document.querySelector('#app')?.dataset.mode,
      focused: document.hasFocus(), editorFocused: !!document.activeElement?.closest('.cm-content'),
      inert: document.querySelector('.editor-host')?.inert, active: document.activeElement?.className }));
    assert.equal(report.baseline.focused, true, 'The native baseline starts in the focused document');
    assert.equal(report.baseline.editorFocused, true, 'Activate the group before focusing the interactive editor');
    await chord('p', true);
    await expectQuickInput('live', 'Ctrl+Alt+P', true);
    for (const surface of ['preview', 'side']) {
      report.phase = surface;
      if (surface === 'side') {
        await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Light Modern', vscode.ConfigurationTarget.Global);
        await page.waitForFunction(() => !!document.querySelector('.monaco-workbench.vs'));
      }
      await frame.$eval(`[data-mode="${surface === 'preview' ? 'preview' : 'source'}"]`, button => button.click());
      if (surface === 'side') await frame.$eval('.source-preview-button', button => button.click());
      await frame.waitForFunction(() => document.querySelector('.preview-status')?.hidden === true
        && document.querySelector('.preview-loading')?.hidden === true
        && document.querySelector('.preview-host')?.hidden === false
        && document.querySelector('.preview-frame')?.contentDocument?.documentElement.inert === false
        && !!document.querySelector('.preview-frame')?.contentDocument?.getElementById('reading'));
      const preview = await (await frame.$('.preview-frame')).contentFrame();
      assert.ok(preview);
      for (const gesture of ['Ctrl+Alt+P', 'F1', 'Ctrl+Alt+O', 'Ctrl+K Ctrl+M']) {
        await preview.evaluate(() => { document.body.tabIndex = -1; document.body.focus({ preventScroll: true }); });
        if (gesture === 'F1') await page.keyboard.press('F1');
        else if (gesture === 'Ctrl+K Ctrl+M') { await chord('k'); await chord('m'); }
        else await chord(gesture === 'Ctrl+Alt+P' ? 'p' : 'o', true);
        await expectQuickInput(surface, gesture, gesture !== 'Ctrl+Alt+O');
      }
      report.phase = `${surface}-context-menu`;
      const points = await preview.evaluate(() => {
        const paragraph = document.querySelector('main.meo-export-doc p');
        const range = document.createRange(); range.selectNodeContents(paragraph);
        getSelection().removeAllRanges();
        const rect = range.getBoundingClientRect();
        return { left: rect.left + 1, right: rect.right - 1, y: rect.top + rect.height / 2 };
      });
      // Retained editor tabs and other workbench views can all have iframe
      // rectangles. Resolve this document's owner, then verify its hit target.
      const previewPoint = async point => {
        const local = await frame.$eval('.preview-frame', element => {
          const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top };
        });
        return (await readWebviewPoint({ frame, page }, { x: local.x + point.x, y: local.y + point.y })).root;
      };
      const start = await previewPoint({ x: points.left, y: points.y });
      const end = await previewPoint({ x: points.right, y: points.y });
      report.webviewOwners ??= [];
      report.webviewOwners.push({ surface, owner: start.owner, nonzeroWorkbenchFrames: await page.evaluate(() =>
        [...document.querySelectorAll('iframe')].filter(node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }).length) });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      const selected = 'Select and copy this paragraph.';
      assert.equal(await preview.evaluate(() => getSelection().toString()), selected);
      const sentinel = `MEO_PREVIEW_CONTEXT_COPY_${surface}`;
      await vscode.env.clipboard.writeText(sentinel);
      await chord('c');
      await expectClipboard(selected, `${surface}: native Ctrl+C`);
      await vscode.env.clipboard.writeText(sentinel);
      const menuPoint = await previewPoint({ x: points.left + 10, y: points.y });
      await page.mouse.click(menuPoint.x, menuPoint.y, { button: 'right' });
      await page.waitForFunction(() => [...document.querySelectorAll('.context-view .action-label')]
        .some(label => /^(Copy|复制)$/.test(label.textContent.trim()) && label.getBoundingClientRect().height > 0), { timeout: 5000 });
      const menuItems = await readMenuItems();
      for (const pattern of [/^(Cut|剪切)$/, /^(Paste|粘贴)$/]) {
        assert.equal(menuItems.find(item => pattern.test(item.label))?.disabled, true,
          `${surface}: read-only Preview must disable ${pattern} (${JSON.stringify(menuItems)})`);
      }
      assert.equal(menuItems.find(item => /^(Copy|复制)$/.test(item.label))?.disabled, false);
      assert.equal(menuItems.length, 3, 'Readonly clipboard entries must replace, not duplicate, the defaults');
      assert.ok(menuItems.every(item => item.keybinding), 'Preview must show the native clipboard shortcut column');
      previewMenus.push({ surface, items: menuItems, layout: await readMenuLayout() });
      await page.waitForFunction(() => {
        let element = [...document.querySelectorAll('.context-view .monaco-menu')].find(node => node.getBoundingClientRect().height > 0);
        if (!element) return false;
        if (element.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')) return false;
        for (; element; element = element.parentElement) if (Number(getComputedStyle(element).opacity) < 0.999) return false;
        return true;
      });
      await page.screenshot({ path: path.join(output, `context-menu-${surface}.png`) });
      const copy = await page.evaluate(() => {
        const label = [...document.querySelectorAll('.context-view .action-label')]
          .find(label => /^(Copy|复制)$/.test(label.textContent.trim()) && label.getBoundingClientRect().height > 0);
        const rect = label.getBoundingClientRect();
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const hit = document.elementFromPoint(point.x, point.y)?.closest('.action-menu-item')?.querySelector('.action-label')?.textContent.trim();
        window.__meoMenuClickReceipt = undefined;
        window.__meoMenuClickObserver = event => {
          window.__meoMenuClickReceipt = { trusted: event.isTrusted,
            label: event.target?.closest('.action-menu-item')?.querySelector('.action-label')?.textContent.trim() };
        };
        window.addEventListener('pointerdown', window.__meoMenuClickObserver, { once: true, capture: true });
        return { ...point, hit };
      });
      let receipt;
      try {
        assert.match(copy.hit ?? '', /^(Copy|复制)$/, 'The native menu Copy point must hit the Copy row');
        await page.mouse.click(copy.x, copy.y);
      }
      finally {
        receipt = await page.evaluate(() => {
          window.removeEventListener('pointerdown', window.__meoMenuClickObserver, true);
          delete window.__meoMenuClickObserver;
          const receipt = window.__meoMenuClickReceipt; delete window.__meoMenuClickReceipt;
          return receipt;
        });
        report.menuCopyClicks ??= []; report.menuCopyClicks.push({ surface, point: copy, receipt });
      }
      assert.ok(receipt?.trusted && /^(Copy|复制)$/.test(receipt.label ?? ''), 'The native Copy row must receive the actual press');
      await expectClipboard(selected, `${surface}: menu`);
      assert.equal(await preview.evaluate(() => getSelection().toString()), selected);
      await vscode.env.clipboard.writeText(sentinel);
      await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
      await expectClipboard(selected, `${surface}: host command`);
      await vscode.commands.executeCommand('editor.action.clipboardCutAction');
      await vscode.env.clipboard.writeText(sentinel);
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(file))).getText(), text,
        `${surface}: read-only Preview clipboard commands must not edit Source`);
      report.runs.push({ surface, gesture: 'selected-text context menu / Copy / host Copy', exact: true });
      await preview.evaluate(() => {
        const input = document.querySelector('textarea');
        input.value = 'Editable field.';
        input.focus({ preventScroll: true }); input.select();
      });
      const inputPoint = await preview.$eval('textarea', input => {
        const rect = input.getBoundingClientRect(); return { x: rect.left + 8, y: rect.top + rect.height / 2 };
      });
      const inputRoot = await previewPoint(inputPoint);
      await page.mouse.click(inputRoot.x, inputRoot.y, { button: 'right' });
      await page.waitForFunction(() => [...document.querySelectorAll('.context-view .action-label')]
        .some(label => /^(Paste|粘贴)$/.test(label.textContent.trim()) && label.getBoundingClientRect().height > 0), { timeout: 5000 });
      const inputMenuItems = await readMenuItems();
      assert.equal(inputMenuItems.length, 3);
      assert.ok(inputMenuItems.every(item => !item.disabled), 'Editable inputs must retain the enabled native menu');
      await page.keyboard.press('Escape');
      await chord('c');
      await expectClipboard('Editable field.', `${surface}: native input Ctrl+C`);
      await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
      await expectClipboard('Editable field.', `${surface}: input`);
      await vscode.commands.executeCommand('editor.action.clipboardCutAction');
      assert.equal(await preview.$eval('textarea', input => input.value), '');
      await vscode.env.clipboard.writeText('Native pasted input');
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      await preview.waitForFunction(() => document.querySelector('textarea').value === 'Native pasted input', { timeout: 5000 });
      report.runs.push({ surface, gesture: 'native input Copy / Cut / Paste', exact: true });
      await vscode.commands.executeCommand('meoEnhanced.preview.cut');
      await vscode.commands.executeCommand('meoEnhanced.preview.paste');
    }
    for (const mode of ['live', 'source']) {
      report.phase = `${mode}-context-menu`;
      await frame.$eval(`[data-mode="${mode}"]`, button => button.click());
      await frame.waitForFunction(mode => document.querySelector('#app')?.dataset.mode === mode
        && document.querySelector('.editor-host')?.inert === false
        && document.querySelector('.editor-loading')?.hidden === true
        && !document.querySelector('.mode-group [aria-busy="true"]'), {}, mode);
      const point = await frame.$eval('.editor-host .cm-content', element => {
        const rect = element.getBoundingClientRect(); return { x: rect.left + 10, y: rect.top + 10 };
      });
      const editorRoot = (await readWebviewPoint({ frame, page }, point)).root;
      await page.mouse.click(editorRoot.x, editorRoot.y, { button: 'right' });
      await page.waitForFunction(() => [...document.querySelectorAll('.context-view .action-label')]
        .some(label => /^(Copy|复制)$/.test(label.textContent.trim()) && label.getBoundingClientRect().height > 0));
      const items = await readMenuItems();
      assert.equal(items.length, 3);
      assert.ok(items.every(item => !item.disabled), `${mode}: native editing menus must stay enabled`);
      const layout = await readMenuLayout();
      for (const preview of previewMenus) {
        assert.deepEqual(preview.items.map(item => item.keybinding), items.map(item => item.keybinding),
          `${preview.surface}: clipboard shortcut labels must match the native editor menu`);
        assert.deepEqual(preview.layout, layout, `${preview.surface}: native menu dimensions and typography must match ${mode}`);
      }
      report.menuComparison = { preview: previewMenus, native: { mode, items, layout } };
      await page.keyboard.press('Escape');
      report.runs.push({ surface: mode, gesture: 'enabled native context menu', exact: true });
    }
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'Host shortcuts must not change the document');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal(document.getText(), text, 'Host shortcuts must not change the in-memory document');
    assert.equal(document.isDirty, false, 'Host shortcuts must not leave pending edits');
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error);
    if (browser) {
      try { await (await browser.pages())[0]?.screenshot({ path: path.join(output, 'failure.png') }); }
      catch (captureError) { report.captureError = String(captureError); }
    }
    throw error;
  } finally {
    browser?.disconnect();
    await vscode.env.clipboard.writeText(previousClipboard);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  }
};
