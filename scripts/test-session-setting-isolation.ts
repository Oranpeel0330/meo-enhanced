import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable
} from './panel-session-test-helper';

const repoRoot = path.resolve(import.meta.dir, '..');
const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');

const configurationHandlerStart = extensionSource.indexOf('async handleConfigurationChanged(');
const configurationHandlerEnd = extensionSource.indexOf('\n  notifyVscodeCodeThemeChanged(', configurationHandlerStart);
if (configurationHandlerStart < 0 || configurationHandlerEnd < 0) {
  throw new Error('Could not locate the configuration-change handler');
}

const configurationHandler = extensionSource.slice(configurationHandlerStart, configurationHandlerEnd);
const sessionSettingBroadcasts = [
  'gitChangesGutterChanged',
  'gitDiffLineHighlightsChanged',
  'diffBaselineModeChanged',
  'contentMaxWidthChanged',
  'outlinePositionChanged',
  'outlineVisibilityChanged'
];

const leakedBroadcasts = sessionSettingBroadcasts.filter((messageType) => configurationHandler.includes(messageType));
if (leakedBroadcasts.length > 0) {
  throw new Error(`Persisted editor settings still broadcast to open sessions: ${leakedBroadcasts.join(', ')}`);
}

for (const methodName of ['setFindOptions', 'setOutlineVisible']) {
  const methodStart = extensionSource.indexOf(`private async ${methodName}(`);
  const methodEnd = extensionSource.indexOf('\n  private ', methodStart + 1);
  if (methodStart < 0 || methodEnd < 0) {
    throw new Error(`Could not locate ${methodName}`);
  }
  if (extensionSource.slice(methodStart, methodEnd).includes('this.broadcast(')) {
    throw new Error(`${methodName} still updates other open editor sessions`);
  }
}

const document = createPanelSessionTestDocument(
  createPanelSessionTestUri('C:/session-setting-isolation.md'),
  '# Settings isolation'
);
const persistedConfiguration = new Map<string, unknown>();
let beforeConfigurationWrite: (key: string, value: unknown) => Promise<void> = async () => {};
const saveErrors: string[] = [];
const vscodeMock = createPanelSessionVscodeMock(document) as {
  workspace: { getConfiguration(): unknown };
  window: { showErrorMessage(message: string): Promise<void> };
};
vscodeMock.window.showErrorMessage = async message => { saveErrors.push(message); };
vscodeMock.workspace.getConfiguration = () => ({
  get: <T>(key: string, fallback?: T): T | undefined => (
    persistedConfiguration.has(key) ? persistedConfiguration.get(key) as T : fallback
  ),
  inspect: (key: string) => persistedConfiguration.has(key)
    ? { globalValue: persistedConfiguration.get(key) }
    : undefined,
  update: async (key: string, value: unknown) => {
    await beforeConfigurationWrite(key, value);
    if (value === undefined) persistedConfiguration.delete(key);
    else persistedConfiguration.set(key, value);
  }
});
mock.module('vscode', () => vscodeMock);
const { createPanelSessionController } = await import('../src/extension/panelSession');

const defaults = {
  previewAppearance: 'light' as 'light' | 'dark' | 'auto',
  previewFontFamily: '',
  previewSourceColoring: true,
  editorAppearance: 'light' as 'light' | 'dark' | 'auto'
};

const createPanel = () => {
  const messages: Array<Record<string, unknown>> = [];
  const panel = {
    active: true,
    webview: {
      postMessage: async (message: Record<string, unknown>) => {
        messages.push(message);
        return true;
      },
      onDidReceiveMessage: () => panelSessionDisposable()
    },
    onDidChangeViewState: () => panelSessionDisposable(),
    onDidDispose: () => panelSessionDisposable()
  };
  const controller = createPanelSessionController(createPanelSessionControllerParams({
    panel,
    document,
    readDiskText: () => document.text,
    pendingDraftRecovery: {
      remember: (_text: string | null, version: number) => version,
      discardIfCurrent: () => true,
      recover: async () => false,
      settleForTermination: async () => false,
      preserveRetired: async () => false,
      hasPending: () => false
    },
    overrides: {
      getPreviewAppearance: () => defaults.previewAppearance,
      setPreviewAppearance: async (value: typeof defaults.previewAppearance) => {
        defaults.previewAppearance = value;
      },
      getPreviewFontFamily: () => defaults.previewFontFamily,
      setPreviewFontFamily: async (value: string) => {
        defaults.previewFontFamily = value;
      },
      getPreviewSourceColoring: () => defaults.previewSourceColoring,
      setPreviewSourceColoring: async (value: boolean) => {
        defaults.previewSourceColoring = value;
      },
      getEditorAppearance: () => defaults.editorAppearance,
      setEditorAppearance: async (value: typeof defaults.editorAppearance) => {
        defaults.editorAppearance = value;
      }
    }
  }) as never);
  return { controller, messages };
};

const firstPanel = createPanel();
await firstPanel.controller.handleMessage({ type: 'ready', pageId: 'settings-isolation-page-1' });
const firstInit = firstPanel.messages.find((message) => message.type === 'init');
assert.ok(firstInit, 'the first panel must receive its frozen Init settings');
const firstMessageCount = firstPanel.messages.length;
assert.equal(firstInit.contentMaxWidth, 800, 'existing sessions default to 800px');
await Promise.all([
  firstPanel.controller.handleMessage({ type: 'setContentMaxWidth', enabled: true, width: 950 }),
  firstPanel.controller.handleMessage({ type: 'setContentMaxWidth', enabled: false, width: 1250 })
]);
assert.equal(persistedConfiguration.get('contentMaxWidth.value'), 1250);
assert.equal(persistedConfiguration.get('contentMaxWidth.visible'), false);
assert.equal(firstInit.contentMaxWidth, 800, 'saving a default must not change the open session snapshot');
await firstPanel.controller.handleMessage({ type: 'setContentMaxWidth', enabled: true });
assert.equal(persistedConfiguration.get('contentMaxWidth.value'), 1250, 'toggling retains the custom width');

await firstPanel.controller.handleMessage({ type: 'setPreviewAppearance', appearance: 'dark' });
await firstPanel.controller.handleMessage({ type: 'setPreviewFontFamily', fontFamily: 'Inter' });
await firstPanel.controller.handleMessage({ type: 'setPreviewSourceColoring', enabled: false });
await firstPanel.controller.handleMessage({ type: 'setEditorAppearance', appearance: 'dark' });
await firstPanel.controller.handleMessage({ type: 'setGitDiffDetailsVisible', visible: true });
assert.equal(
  firstPanel.messages.length,
  firstMessageCount,
  'persisted appearance defaults must not broadcast into the current panel'
);
assert.deepEqual(
  {
    previewAppearance: firstInit.previewAppearance,
    previewFontFamily: firstInit.previewFontFamily,
    previewSourceColoring: firstInit.previewSourceColoring,
    editorAppearance: firstInit.editorAppearance,
    gitDiffDetailsVisible: firstInit.gitDiffDetailsVisible
  },
  {
    previewAppearance: 'light',
    previewFontFamily: '',
    previewSourceColoring: true,
    editorAppearance: 'light',
    gitDiffDetailsVisible: false
  },
  'the current panel must retain its original Init snapshot'
);

const secondPanel = createPanel();
await secondPanel.controller.handleMessage({ type: 'ready', pageId: 'settings-isolation-page-2' });
const secondInit = secondPanel.messages.find((message) => message.type === 'init');
assert.ok(secondInit, 'a later panel must receive an Init snapshot');
assert.equal(secondInit.contentMaxWidth, 1250, 'later sessions inherit the saved pixel width');
assert.equal(secondInit.contentMaxWidthEnabled, true);
assert.deepEqual(
  {
    previewAppearance: secondInit.previewAppearance,
    previewFontFamily: secondInit.previewFontFamily,
    previewSourceColoring: secondInit.previewSourceColoring,
    editorAppearance: secondInit.editorAppearance,
    gitDiffDetailsVisible: secondInit.gitDiffDetailsVisible
  },
  {
    previewAppearance: 'dark',
    previewFontFamily: 'Inter',
    previewSourceColoring: false,
    editorAppearance: 'dark',
    gitDiffDetailsVisible: true
  },
  'persisted appearance changes must become defaults only for later panels'
);
// A delayed failed write must finish before the next save and must not roll
// back a newer projection. A failure of the latest write reports saved values.
let releaseWrite!: () => void;
let enteredWrite!: () => void;
const entered = new Promise<void>(resolve => { enteredWrite = resolve; });
const held = new Promise<void>(resolve => { releaseWrite = resolve; });
beforeConfigurationWrite = async (key, value) => {
  if (key === 'contentMaxWidth.value' && value === 1400) { enteredWrite(); await held; throw new Error('held width failure'); }
};
const delayed = firstPanel.controller.handleMessage({ type: 'setContentMaxWidth', enabled: true, width: 1400 });
await entered;
const newer = firstPanel.controller.handleMessage({ type: 'setContentMaxWidth', enabled: true, width: 1600 });
assert.equal(persistedConfiguration.get('contentMaxWidth.value'), 1250, 'new saves wait for the pending write');
releaseWrite(); await Promise.all([delayed, newer]);
assert.equal(persistedConfiguration.get('contentMaxWidth.value'), 1600);
assert.equal(firstPanel.messages.length, firstMessageCount, 'an obsolete failure cannot replace the newer projection');
assert.equal(saveErrors.length, 0);
beforeConfigurationWrite = async key => { if (key === 'contentMaxWidth.value') throw new Error('latest width failure'); };
await firstPanel.controller.handleMessage({ type: 'setContentMaxWidth', enabled: false, width: 1900 });
assert.deepEqual(firstPanel.messages.at(-1), { type: 'contentMaxWidthChanged', enabled: true, width: 1600 });
assert.equal(saveErrors.length, 1, 'the latest save failure is visible and can be retried');
beforeConfigurationWrite = async () => {};
await firstPanel.controller.handleMessage({ type: 'setContentMaxWidth', enabled: false, width: 1900 });
assert.equal(persistedConfiguration.get('contentMaxWidth.value'), 1900);
assert.equal(persistedConfiguration.get('contentMaxWidth.visible'), false);
firstPanel.controller.dispose();
secondPanel.controller.dispose();

console.log('session setting isolation checks passed');
