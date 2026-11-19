import assert from 'node:assert/strict';
import type { CustomShortcut, ShortcutOverrides } from '../src/foundation/editingPreferences';

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'Win32' }
});

const { createCustomShortcutMatcher, handleEditorShortcut } = await import('../webview/src/helpers/shortcuts');

type ShortcutCase = {
  readonly name: string;
  readonly event: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key' | 'code'>;
  readonly editableMode?: 'live' | 'source';
  readonly focused?: boolean;
  readonly editorSurfaceActive?: boolean;
  readonly shortcuts?: ShortcutOverrides;
  readonly platform?: 'mac' | 'other';
  readonly expectedHandled: boolean;
  readonly expectedEffects?: readonly string[];
};

const cases: readonly ShortcutCase[] = [
  {
    name: 'save',
    event: { key: 's', code: 'KeyS', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['save']
  },
  {
    name: 'default Save As uses the document action',
    event: { key: 's', code: 'KeyS', ctrlKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['saveAs']
  },
  {
    name: 'assigned Save As uses the document action',
    shortcuts: { saveAs: ['Ctrl + Alt + S'] },
    event: { key: 's', code: 'KeyS', ctrlKey: true, altKey: true },
    expectedHandled: true,
    expectedEffects: ['saveAs']
  },
  {
    name: 'Save As accepts a Mac binding',
    platform: 'mac',
    event: { key: 's', code: 'KeyS', metaKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['saveAs']
  },
  {
    name: 'Preview body can Save As without editing the hidden editor',
    focused: false,
    editorSurfaceActive: false,
    event: { key: 's', code: 'KeyS', ctrlKey: true, shiftKey: true, target: { nodeName: 'BODY' } as EventTarget },
    expectedHandled: true,
    expectedEffects: ['saveAs']
  },
  {
    name: 'cleared Save As consumes its old default without running it',
    shortcuts: { saveAs: [] },
    event: { key: 's', code: 'KeyS', ctrlKey: true, shiftKey: true },
    expectedHandled: true
  },
  {
    name: 'IME composition has priority over assigned Save As',
    shortcuts: { saveAs: ['Ctrl + Shift + S'] },
    event: { key: 's', code: 'KeyS', ctrlKey: true, shiftKey: true, isComposing: true },
    expectedHandled: false
  },
  {
    name: 'find',
    event: { key: 'f', code: 'KeyF', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['find:find']
  },
  {
    name: 'replace',
    event: { key: 'h', code: 'KeyH', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['find:replace']
  },
  {
    name: 'select all',
    event: { key: 'a', code: 'KeyA', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['selectAll']
  },
  {
    name: 'undo',
    event: { key: 'z', code: 'KeyZ', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['undo']
  },
  {
    name: 'redo with Shift+Z',
    event: { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['redo']
  },
  {
    name: 'redo with Y',
    event: { key: 'y', code: 'KeyY', ctrlKey: true },
    expectedHandled: true,
    expectedEffects: ['redo']
  },
  {
    name: 'toggle Source to Live',
    editableMode: 'source',
    event: { key: 'm', code: 'KeyM', altKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['mode:live']
  },
  {
    name: 'toggle Live to Source',
    editableMode: 'live',
    event: { key: 'm', code: 'KeyM', altKey: true, shiftKey: true },
    expectedHandled: true,
    expectedEffects: ['mode:source']
  },
  {
    name: 'unfocused editor does not select all',
    focused: false,
    event: { key: 'a', code: 'KeyA', ctrlKey: true },
    expectedHandled: false
  },
  {
    name: 'detached table focus leaves body as history shortcut target',
    focused: false,
    event: { key: 'z', code: 'KeyZ', ctrlKey: true, target: { nodeName: 'BODY' } as EventTarget },
    expectedHandled: true,
    expectedEffects: ['undo']
  },
  {
    name: 'body redo restores editor history after detached table focus',
    focused: false,
    event: { key: 'y', code: 'KeyY', ctrlKey: true, target: { nodeName: 'BODY' } as EventTarget },
    expectedHandled: true,
    expectedEffects: ['redo']
  },
  {
    name: 'body focus does not steal select all',
    focused: false,
    event: { key: 'a', code: 'KeyA', ctrlKey: true, target: { nodeName: 'BODY' } as EventTarget },
    expectedHandled: false
  },
  {
    name: 'other unfocused input keeps its own history',
    focused: false,
    event: { key: 'z', code: 'KeyZ', ctrlKey: true, target: { nodeName: 'INPUT' } as EventTarget },
    expectedHandled: false
  },
  {
    name: 'Preview body does not replay hidden editor history',
    focused: false,
    editorSurfaceActive: false,
    event: { key: 'z', code: 'KeyZ', ctrlKey: true, target: { nodeName: 'BODY' } as EventTarget },
    expectedHandled: false
  },
  {
    name: 'IME composition has priority over save',
    event: { key: 's', code: 'KeyS', ctrlKey: true, isComposing: true },
    expectedHandled: false
  },
  {
    name: 'plain text input is not swallowed',
    event: { key: 'x', code: 'KeyX' },
    expectedHandled: false
  }
];

for (const testCase of cases) {
  const effects: string[] = [];
  let prevented = 0;
  let stopped = 0;
  const context = new Proxy({
    editor: {
      hasFocus: () => testCase.focused ?? true,
      selectAll: () => effects.push('selectAll'),
      undo: () => effects.push('undo'),
      redo: () => effects.push('redo')
    },
    editableMode: testCase.editableMode ?? 'source',
    editorSurfaceActive: testCase.editorSurfaceActive ?? true,
    shortcuts: testCase.shortcuts ?? {},
    customShortcutMatcher: undefined,
    customShortcuts: undefined,
    platform: testCase.platform ?? 'other',
    requestSave: () => effects.push('save'),
    requestSaveAs: () => effects.push('saveAs'),
    openFindPanel: (target: 'find' | 'replace') => effects.push(`find:${target}`),
    requestMode: (mode: 'live' | 'source') => effects.push(`mode:${mode}`)
  }, {
    get(target, property, receiver) {
      assert.equal(property in target, true, `${testCase.name}: read undeclared context state ${String(property)}`);
      return Reflect.get(target, property, receiver);
    }
  });
  const event = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
    ...testCase.event
  } as KeyboardEvent;

  const handled = handleEditorShortcut(event, context);
  assert.deepEqual({
    handled,
    effects,
    prevented,
    stopped
  }, {
    handled: testCase.expectedHandled,
    effects: [...(testCase.expectedEffects ?? [])],
    prevented: testCase.expectedHandled ? 1 : 0,
    stopped: testCase.expectedHandled ? 1 : 0
  }, testCase.name);
}

const effects: string[] = [];
const target = { closest: () => null, matches: () => false };
let tableFocused = false;
let tableInputFocused = false;
let snippetTargetAvailable = true;
let rejectedCommand = '';
let throwingCommand = '';
const failures: { id: string; step: number }[] = [];
const customShortcuts: readonly CustomShortcut[] = [
  { id: 'meeting-notes', name: 'Meeting notes', scope: 'editor', strokes: ['Ctrl + K', 'T'],
    actions: [{ type: 'snippet', template: '## ${1:Notes}' }, { type: 'command', command: 'save' }] },
  { id: 'to-source', name: 'Open Source', scope: 'global', strokes: ['Ctrl + Alt + J'],
    actions: [{ type: 'mode', mode: 'source' }] },
  { id: 'mixed', name: 'Format and delete table row', scope: 'editor', strokes: ['Ctrl + Alt + U'],
    actions: [{ type: 'command', command: 'bold' }, { type: 'command', command: 'rowDelete' }] },
  { id: 'table-chord', name: 'Add a row', scope: 'live', strokes: ['Ctrl + Alt + P', 'R'],
    actions: [{ type: 'command', command: 'rowAbove' }] },
  { id: 'cell-snippet', name: 'Cell snippet', scope: 'editor', strokes: ['Ctrl + Alt + H', 'R'],
    actions: [{ type: 'snippet', template: 'Time: ${CURRENT_HOUR}' }] },
  { id: 'move-line-chord', name: 'Move document line', scope: 'editor', strokes: ['Ctrl + Alt + W', 'R'],
    actions: [{ type: 'command', command: 'moveUp' }] },
  { id: 'mixed-table-input', name: 'Move line and delete row', scope: 'editor', strokes: ['Ctrl + Alt + Y'],
    actions: [{ type: 'command', command: 'moveUp' }, { type: 'command', command: 'rowDelete' }] },
  { id: 'dynamic-step', name: 'Move and insert', scope: 'editor', strokes: ['Ctrl + Alt + M'],
    actions: [{ type: 'command', command: 'moveUp' }, { type: 'snippet', template: 'inserted' }] },
  { id: 'no-op', name: 'Move up', scope: 'editor', strokes: ['Ctrl + Alt + N'],
    actions: [{ type: 'command', command: 'moveUp' }] },
  { id: 'async-error', name: 'Save a copy', scope: 'editor', strokes: ['Ctrl + Alt + S'],
    actions: [{ type: 'command', command: 'saveAs' }] }
];
const customShortcutMatcher = createCustomShortcutMatcher();
const context = {
  editor: {
    hasFocus: () => true,
    isTableFocused: () => tableFocused,
    isTableInputFocused: () => tableInputFocused,
    executeCommand: (command: string) => {
      if (command === throwingCommand) throw new Error('step failure');
      if (command === rejectedCommand) return false;
      effects.push(command); return true;
    },
    view: { hasFocus: true, contentDOM: { contains: (element: unknown) => element === target } }
  },
  editableMode: 'live' as const,
  editorSurfaceActive: true,
  customShortcuts,
  customShortcutMatcher,
  reportCustomShortcutError: (rule: CustomShortcut, step: number) => { failures.push({ id: rule.id, step }); },
  canInsertSnippet: () => snippetTargetAvailable,
  insertSnippet: (template: string) => { effects.push('insert:' + template); return true; },
  requestSave: () => { effects.push('save'); },
  requestSaveAs: async () => { throw new Error('asynchronous step failure'); },
  setMode: (mode: string) => { effects.push('mode:' + mode); },
  openFindPanel: () => {},
  requestMode: () => {}
};
const keydown = (key: string, timeStamp: number, extra: Partial<KeyboardEvent> = {}) => handleEditorShortcut({
  key, code: 'Key' + key.toUpperCase(), timeStamp, target,
  preventDefault() {}, stopPropagation() {}, ...extra
} as KeyboardEvent, context);
assert.equal(keydown('k', 0, { ctrlKey: true }), true);
assert.deepEqual(effects, []);
assert.equal(keydown('t', 200), true);
assert.deepEqual(effects, ['insert:## ${1:Notes}', 'save'], 'Actions dispatch in order');
assert.equal(keydown('k', 300, { ctrlKey: true }), true);
assert.equal(keydown('t', 2000), false, 'An expired prefix cannot consume a typed character');
assert.equal(keydown('k', 2100, { ctrlKey: true }), true);
assert.equal(keydown('t', 2200, { isComposing: true }), false, 'IME cancels a pending shortcut');
assert.equal(keydown('t', 2300), false);
assert.equal(keydown('j', 2400, { ctrlKey: true, altKey: true }), true);
assert.equal(effects.at(-1), 'mode:source', 'The explicit mode argument reaches the command');
assert.equal(keydown('j', 2500, { ctrlKey: true, altKey: true, repeat: true }), true);
assert.deepEqual(effects, ['insert:## ${1:Notes}', 'save', 'mode:source'], 'Repeating the key does not replay custom actions');

const ctrlAlt = { ctrlKey: true, altKey: true };
effects.length = 0;
assert.equal(keydown('u', 2600, ctrlAlt), true);
assert.deepEqual(effects, ['bold'], 'In prose the table step is skipped');
assert.equal(keydown('p', 2700, ctrlAlt), false, 'A table-only chord cannot consume its prefix in prose');
assert.equal(keydown('r', 2800), false);
effects.length = 0;
tableFocused = true;
assert.equal(keydown('u', 3000, ctrlAlt), true);
assert.deepEqual(effects, ['bold', 'rowDelete']);
assert.equal(keydown('p', 3100, ctrlAlt), true, 'The same chord can start in a table in the selected mode');
assert.equal(keydown('r', 3200), true);
snippetTargetAvailable = false;
assert.equal(keydown('h', 3250, ctrlAlt), false, 'An ambiguous table selection does not consume the prefix');
snippetTargetAvailable = true;
assert.equal(keydown('h', 3300, ctrlAlt), true);
assert.deepEqual(effects, ['bold', 'rowDelete', 'rowAbove']);
assert.equal(keydown('r', 3400), true);
assert.deepEqual(effects, ['bold', 'rowDelete', 'rowAbove', 'insert:Time: ${CURRENT_HOUR}']);
assert.equal(keydown('k', 3500, { ctrlKey: true }), true);
assert.equal(keydown('t', 3600), true);
assert.equal(effects.at(-1), 'save', 'An inapplicable first step does not stop a later applicable step');
tableInputFocused = true;
effects.length = 0;
assert.equal(keydown('w', 3700, ctrlAlt), false, 'A document-only chord does not start inside a native table input');
assert.equal(keydown('r', 3800), false);
assert.equal(keydown('y', 3900, ctrlAlt), true);
assert.deepEqual(effects, ['rowDelete'], 'An unavailable document command does not block a later table command');
tableFocused = tableInputFocused = false;
effects.length = 0;
rejectedCommand = 'moveUp';
assert.equal(keydown('m', 4000, ctrlAlt), true);
assert.deepEqual(effects, ['insert:inserted'], 'A command returning false lets a later applicable step run');
assert.equal(keydown('n', 4100, ctrlAlt), false, 'If every step returns false, the key falls through');
effects.length = 0;
throwingCommand = 'moveUp';
assert.equal(keydown('m', 4200, ctrlAlt), true);
assert.deepEqual(effects, [], 'A thrown step stops later steps');
assert.deepEqual(failures, [{ id: 'dynamic-step', step: 0 }]);
assert.equal(keydown('s', 4300, ctrlAlt), true);
await Promise.resolve();
assert.deepEqual(failures, [{ id: 'dynamic-step', step: 0 }, { id: 'async-error', step: 0 }]);

console.log('Editor shortcut tests passed');
