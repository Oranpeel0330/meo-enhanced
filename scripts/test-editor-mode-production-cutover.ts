import { importedCallCount, importedInstanceMethodCallCount } from './source-import-contracts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');
const effectAdapterSource = readFileSync(
  new URL('../webview/src/adapters/editorModeEffectAdapter.ts', import.meta.url),
  'utf8'
);
const previewAdapterSource = readFileSync(
  new URL('../webview/src/adapters/previewWebviewAdapter.ts', import.meta.url),
  'utf8'
);
const hostSessionSource = readFileSync(
  new URL('../src/extension/panelSession.ts', import.meta.url),
  'utf8'
);

for (const legacyPattern of [
  /\blet currentMode\b/,
  /\blet lastEditableMode\b/,
  /\blet hasLocalModePreference\b/,
  /\bconst applyMode\b/,
  /\bmountInitialEditor\b/,
  /\bscheduleInitialEditorMount\b/,
  /\binitialMountRecoveryAttempted\b/,
  /\bmodeToggleShouldRestoreEditorFocus\b/
]) {
  assert.equal(legacyPattern.test(source), false, `Legacy Editor Mode rule returned: ${legacyPattern}`);
}

assert.equal(
  importedCallCount(source, 'createEditorModeApplication'),
  1
);
assert.equal(
  importedCallCount(source, 'createEditorModeEffectAdapter'),
  1
);
assert.equal(importedCallCount(source, 'createEditorModeRuntime'), 1);
assert.equal(importedInstanceMethodCallCount(source, 'createEditorModeApplication', 'dispatch'), 0);
assert.equal(importedInstanceMethodCallCount(source, 'createEditorModeEffectAdapter', 'execute'), 0);
assert.equal(
  (source.match(/editor\.setMode\(mode, viewport, \{ deferViewportRestore \}\)/g) ?? []).length,
  1,
  'Editor mode application must apply its captured viewport through the injected Effect capability'
);
assert.equal(
  /const deferViewportRestore = deferEditorViewportUntilPreviewExit[\s\S]*?pendingEditorViewportAfterPreviewExit === viewport;[\s\S]*?editor\.setMode\(mode, viewport, \{ deferViewportRestore \}\)/.test(source),
  true,
  'Deferred editor reveals must keep the captured Effect viewport current until final geometry'
);
assert.equal(
  (source.match(/restoreViewport\(viewport, owner\)\s*\{\s*editor\?\.restoreViewportAnchorToken\?\.\(viewport, owner\);\s*\}/g) ?? []).length,
  1,
  'Viewport restoration must remain a single injected Effect capability'
);
assert.equal(
  (source.match(/type: 'setMode'/g) ?? []).length,
  1,
  'setMode Command may only be emitted by the injected postMode capability'
);
assert.equal(
  source.includes("type: 'toggleMode', source: 'host-command'"),
  true,
  'Host toggleMode must enter the Runtime as an Application input'
);
assert.equal(source.includes('editorModeRuntime.dispose()'), true);
assert.equal(
  /\blet\s+(?:currentMode|mode|lastEditableMode|pendingTransition|transitionSequence)\b/.test(effectAdapterSource),
  false,
  'Effect Adapter must not copy Application mode or transition state'
);
assert.equal(previewAdapterSource.includes('restoreActive'), false);
assert.equal(
  /\blet\s+mode:\s*EditorMode\b|\bgetMode:\s*\(\)\s*=>\s*mode\b/.test(hostSessionSource),
  false,
  'Host must persist accepted effects without copying the current Editor Mode owner'
);

console.log('Editor Mode production cutover guards passed');

// Formatting, renamed imports, comments and shadowed locals do not change the contract.
const renamed = "import { createEditorModeApplication as build } from './application';\n";
assert.equal(importedCallCount(renamed + 'const owner = build(\n);', 'createEditorModeApplication'), 1);
assert.equal(importedCallCount(renamed + '// build()\nconst text = "build()"; function nested(build: () => void) { build(); }', 'createEditorModeApplication'), 0);
assert.equal(importedCallCount(renamed + 'build(); build();', 'createEditorModeApplication'), 2);
assert.equal(importedInstanceMethodCallCount(renamed + 'const owner = build(); owner.dispatch({});',
  'createEditorModeApplication', 'dispatch'), 1);
assert.equal(importedInstanceMethodCallCount(renamed + 'const owner = build(); function nested(owner: any) { owner.dispatch({}); }',
  'createEditorModeApplication', 'dispatch'), 0);
assert.equal(importedInstanceMethodCallCount(renamed + 'let owner; owner = build(); owner?.dispatch({});',
  'createEditorModeApplication', 'dispatch'), 1);
