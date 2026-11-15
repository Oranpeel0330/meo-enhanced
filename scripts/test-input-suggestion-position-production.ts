import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error' && /plugin crashed/i.test(message.text())) errors.push(message.text()); });
const filler = 'background paragraph\n\n'.repeat(5000);
assert.equal(assessLargeDocument(filler).boundedEditorWork, true);
let phase = 'setup';
type Sample = { anchor: number; anchorTop: number; anchorBottom: number; left: number; top: number; width: number };
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}body{--meo-content-editor-foreground:var(--meo-ui-text);--meo-token-foreground-color:var(--meo-ui-text)}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const prepare = async (mode: string, large: boolean, source: string, appearance: string, preferAbove = false) => {
    const text = source + (large ? '\n\n' + filler : '');
    await page.evaluate(({ mode, large, text, cursor, appearance, input }) => {
      const g = window as any, h = g.EditingFeaturesHarness;
      if (g.positionFrame) cancelAnimationFrame(g.positionFrame);
      g.editor?.destroy(); h.applyUiTheme(appearance, true);
      g.editor = h.createEditor({ parent: document.getElementById('app'), text, initialMode: mode,
        initialInputAssistance: input, onApplyChanges() {}, requestLinkCandidates: async (request: any) =>
          request.kind === 'headings' ? [{ label: 'Alpha', insert: 'alpha', anchor: 'alpha' }, { label: 'Also', insert: 'also', anchor: 'also' }]
            : [{ label: 'alpha.md', insert: 'alpha.md', kind: 'file' }, { label: 'also.md', insert: 'also.md', kind: 'file' }] });
      g.editor.view.dispatch({ selection: { anchor: cursor }, scrollIntoView: true }); g.editor.view.focus();
      g.shiftSuggestion = h.StateEffect.define();
      const presentation = h.StateField.define({ create: () => h.Decoration.none,
        update: (value: any, tr: any) => {
          for (const effect of tr.effects) if (effect.is(g.shiftSuggestion)) return h.Decoration.set([
            h.Decoration.line({ attributes: { style: 'padding-left: 60px !important' } }).range(effect.value)
          ]);
          return value.map(tr.changes);
        }, provide: (field: any) => h.EditorView.decorations.from(field) });
      g.editor.view.dispatch({ effects: h.StateEffect.appendConfig.of(presentation) });
      if (h.usesLargeDocumentDerivedWorkBudget(g.editor.view.state) !== large) throw new Error('Unexpected production derived-work budget');
      g.positionSamples = [];
      g.measureSuggestion = () => {
        const popup = document.querySelector<HTMLElement>('.meo-input-suggestions:not([hidden])');
        if (!popup) return null;
        // DOM ranges observe actual glyphs without coordsAtPos forcing a layout refresh.
        const at = g.editor.view.domAtPos(g.positionAnchor), range = document.createRange();
        range.setStart(at.node, at.offset);
        if (at.node.nodeType === Node.TEXT_NODE && at.offset < at.node.length) range.setEnd(at.node, at.offset + 1);
        const anchor = range.getBoundingClientRect(), menu = popup.getBoundingClientRect();
        return { anchor: anchor.left, anchorTop: anchor.top, anchorBottom: anchor.bottom, left: menu.left, top: menu.top, width: menu.width };
      };
      g.sampleSuggestion = () => {
        const sample = g.measureSuggestion(); if (sample) g.positionSamples.push(sample);
        g.positionFrame = requestAnimationFrame(g.sampleSuggestion);
      };
    }, { mode, large, text, cursor: source.length, appearance, input: { ...defaultInputAssistance, emoji: true, slashPreferAbove: preferAbove } });
    return source.length;
  };
  const startSampling = (anchor: number) => page.evaluate(anchor => {
    const g = window as any; g.positionAnchor = anchor; g.positionSamples = [];
    g.positionFrame = requestAnimationFrame(g.sampleSuggestion);
  }, anchor);
  const settle = async () => {
    await page.waitForFunction(() => {
      const g = window as any;
      return !g.EditingFeaturesHarness.isLiveInputDerivedWorkPending(g.editor.view.state)
        && !!document.querySelector('.meo-input-suggestions:not([hidden])');
    }, { timeout: 4000 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const sample = () => page.evaluate(() => (window as any).measureSuggestion()) as Promise<Sample>;
  const trace = () => page.evaluate(() => {
    const g = window as any; cancelAnimationFrame(g.positionFrame); return g.positionSamples;
  }) as Promise<Sample[]>;
  const aligned = (samples: Sample[], label: string) => {
    assert.ok(samples.length >= 2, label + ': observed multiple visible frames');
    assert.ok(samples.every(s => Math.abs(s.left - s.anchor) <= 1), label + ': menu follows glyph geometry in every visible frame: ' + JSON.stringify(samples));
  };

  for (const large of [false, true]) {
    phase = `natural list continuation, large=${large}`;
    const anchor = await prepare('live', large, '1. item\n', large ? 'dark' : 'light');
    await startSampling(anchor); await page.keyboard.type('/'); await settle();
    assert.equal(await page.$eval('.cm-activeLine', line => line.classList.contains('meo-md-container-prose')), true, phase + ': actual lazy continuation was rendered');
    const before = await sample();
    await page.keyboard.press('ArrowDown'); await settle();
    assert.deepEqual(await sample(), before, phase + ': candidate navigation never catches up to stale coordinates');
    const frames = await trace(); aligned(frames, phase);
    if (large) assert.ok(Math.max(...frames.map(s => s.anchor)) - Math.min(...frames.map(s => s.anchor)) > 10,
      phase + ': trace actually crosses the deferred indentation change');
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), '1. item\n/' + (large ? '\n\n' + filler : ''));
    if (process.env.MEO_TEST_SCREENSHOTS) {
      await mkdir(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.MEO_TEST_SCREENSHOTS, `suggestions-${large ? 'dark' : 'light'}.png`) });
    }
  }

  const cases = [
    { kind: 'slash', source: '', typed: '/', more: 'b', start: 0 },
    { kind: 'emoji', source: '', typed: ':s', more: 't', start: 0 },
    { kind: 'documents', source: '', typed: '[[a', more: 'l', start: 2 },
    { kind: 'paths', source: '', typed: '[label](a', more: 'l', start: 8 },
    { kind: 'headings', source: '', typed: '[[guide#a', more: 'l', start: 8 },
    { kind: 'math', source: '$', typed: '\\s', more: 'q', start: 0 },
    { kind: 'html', source: '', typed: '<d', more: 'i', start: 1 }
  ];
  for (const mode of ['source', 'live']) for (const large of [false, true]) for (const item of cases) {
    phase = `${mode}/${item.kind}, large=${large}`;
    const label = phase;
    const anchor = await prepare(mode, large, 'Introduction\n\n'.repeat(8) + item.source, large ? 'dark' : 'light', large);
    await startSampling(anchor + item.start); await page.keyboard.type(item.typed); phase = label + ': opened'; await settle();
    assert.equal(await page.$eval('.meo-input-suggestions', menu => (menu as HTMLElement).dataset.suggestionKind), item.kind, phase);
    const initial = await sample();
    assert.equal(initial.top < initial.anchorTop, large, phase + ': actually opens on the requested side');
    await page.keyboard.type(item.more); phase = label + ': filtered'; await settle();
    assert.equal((await sample()).left, initial.left, phase + ': filtering retains the query start');
    await page.keyboard.press('ArrowDown'); phase = label + ': selected'; await settle();
    assert.equal((await sample()).left, initial.left, phase + ': changing candidates retains the query start');
    await trace();
    // A real effect-only CodeMirror presentation update changes horizontal geometry
    // without text, selection, viewport or height changes, just like deferred lists.
    await page.evaluate(() => {
      const g = window as any, h = g.EditingFeaturesHarness, view = g.editor.view;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      g.beforeText = g.editor.getText(); g.beforeSelection = view.state.selection.main.toJSON();
      g.positionSamples = []; g.positionFrame = requestAnimationFrame(g.sampleSuggestion);
      view.dispatch({ effects: g.shiftSuggestion.of(line.from) });
    });
    phase = label + ': presentation changed'; await settle();
    const moved = await sample();
    assert.ok(moved.anchor - initial.anchor > 30, phase + ': the actual query moved horizontally');
    aligned(await trace(), phase);
    assert.equal(await page.evaluate(() => {
      const g = window as any;
      return g.editor.getText() === g.beforeText && JSON.stringify(g.editor.view.state.selection.main.toJSON()) === JSON.stringify(g.beforeSelection);
    }), true, phase + ': positioning preserves text and selection');
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const g = window as any; g.editor.view.dispatch({ effects: g.EditingFeaturesHarness.StateEffect.appendConfig.of([]) });
    });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    assert.equal(await page.$('.meo-input-suggestions:not([hidden])'), null, phase + ': queued positioning cannot reopen a dismissed menu');
  }
  assert.deepEqual(errors, []);
  console.log('Input suggestion positioning passed: natural list reflow and seven kinds, ordinary/optimized, Live/Source, above/below, light/dark.');
} catch (error) { throw new Error(phase, { cause: error }); }
finally { await closeTestBrowser(browser); }
