// Real workbench commands and menus, using only the runner's disposable profile.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

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
    let frame;
    const deadline = Date.now() + 30000;
    while (!frame && Date.now() < deadline) {
      const pages = await browser.pages();
      for (const page of pages) for (const candidate of page.frames()) {
        if (!candidate.url().includes('/fake.html')) continue;
        try {
          if (await candidate.evaluate(() => !!document.querySelector('.editor-host .cm-content'))) frame = candidate;
        } catch (error) {
          if (!/detached|Execution context was destroyed|Cannot find context/i.test(String(error))) throw error;
        }
      }
      if (!frame) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(frame, 'MEO webview did not open');
    await frame.waitForFunction(() => !document.querySelector('.editor-wrapper')?.classList.contains('meo-preload-editor-shell'));
    // Wait for VS Code's active content frame before exercising host shortcuts.
    await frame.waitForFunction(() => window.frameElement?.id === 'active-frame');
    report.phase = 'baseline';
    const page = frame.page();
    const chord = async (key, alt = false) => {
      await page.keyboard.down('Control');
      if (alt) await page.keyboard.down('Alt');
      try { await page.keyboard.press(key); }
      finally { if (alt) await page.keyboard.up('Alt'); await page.keyboard.up('Control'); }
    };
    const expectClipboard = async (expected, label) => {
      const deadline = Date.now() + 5000;
      while (await vscode.env.clipboard.readText() !== expected) {
        if (Date.now() > deadline) throw Error(`${label}: Copy did not copy the Preview selection`);
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
    const previewMenus = [];
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
    await frame.$eval('.editor-host .cm-content', content => content.focus({ preventScroll: true }));
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
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
      // Electron Webviews cross CDP targets, so frameElement()/boundingBox()
      // cannot resolve their owners reliably. Use the visible workbench mount.
      const mounts = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + element.clientLeft, y: rect.top + element.clientTop, width: rect.width, height: rect.height };
      }).filter(rect => rect.width > 0 && rect.height > 0));
      assert.equal(mounts.length, 1);
      const local = await frame.$eval('.preview-frame', element => {
        const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top };
      });
      const bounds = { x: mounts[0].x + local.x, y: mounts[0].y + local.y };
      await page.mouse.move(bounds.x + points.left, bounds.y + points.y);
      await page.mouse.down();
      await page.mouse.move(bounds.x + points.right, bounds.y + points.y, { steps: 8 });
      await page.mouse.up();
      const selected = 'Select and copy this paragraph.';
      assert.equal(await preview.evaluate(() => getSelection().toString()), selected);
      const sentinel = `MEO_PREVIEW_CONTEXT_COPY_${surface}`;
      await vscode.env.clipboard.writeText(sentinel);
      await chord('c');
      await expectClipboard(selected, `${surface}: native Ctrl+C`);
      await vscode.env.clipboard.writeText(sentinel);
      await page.mouse.click(bounds.x + points.left + 10, bounds.y + points.y, { button: 'right' });
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
        const rect = label.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(copy.x, copy.y);
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
      await page.mouse.click(bounds.x + inputPoint.x, bounds.y + inputPoint.y, { button: 'right' });
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
        && !document.querySelector('.mode-group [aria-busy="true"]'), {}, mode);
      const mount = await page.$eval('iframe', element => {
        const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top };
      });
      const point = await frame.$eval('.editor-host .cm-content', element => {
        const rect = element.getBoundingClientRect(); return { x: rect.left + 10, y: rect.top + 10 };
      });
      await page.mouse.click(mount.x + point.x, mount.y + point.y, { button: 'right' });
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
