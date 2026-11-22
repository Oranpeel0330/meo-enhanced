import {
  defaultInputAssistance, editorCommandIds, insertCurrentTimeExampleId, insertCurrentTimeExampleName, isCustomShortcut, type CustomShortcut, type CustomShortcutAction,
  type CustomShortcutScope, type EditingPreferences, type EditingPreferencesChange, type EditorCommandId, type ShortcutOverrides, type ShortcutPlatform, type ShortcutReplacement
} from '../foundation/editingPreferences';
import { parseShortcutSnippet, shortcutSnippetSupportsTable } from './shortcutSnippet';

export type { ShortcutPlatform } from '../foundation/editingPreferences';
export function shortcutPlatformFor(platform: string): ShortcutPlatform {
  if (/^win/i.test(platform)) return 'windows';
  return /mac|darwin|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other';
}
export type ShortcutContext = 'global' | 'editor' | 'table' | 'native';
const shortcutLocations = ['outsideEditor', 'prose', 'table', 'tableInput'] as const;
export type ShortcutLocation = typeof shortcutLocations[number];
const shortcutModes = ['live', 'source'] as const;
export type ShortcutStroke = {
  readonly key: string;
  readonly code?: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly composing?: boolean;
  readonly altGraph?: boolean;
};

const fixedCommands = new Set<EditorCommandId>(['copy', 'cut', 'paste', 'selection', 'home', 'enter', 'tab', 'escape', 'delete', 'indent', 'tableNav']);
const globalCommands = new Set<EditorCommandId>(['save', 'saveAs', 'find', 'replace', 'mode', 'preview', 'openFileTree', 'resetWindowZoom']);
const tableCommands = new Set<EditorCommandId>([
  'cellBreak', 'rowAbove', 'rowBelow', 'rowDelete', 'columnBefore', 'columnAfter', 'columnDelete',
  'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight', 'alignLeft', 'alignCenter', 'alignRight', 'copyMarkdown', 'copyCsv'
]);
// A step must have the same meaning in the raw Source cell and the Live cell input.
const cellEditingCommands = new Set<EditorCommandId>([
  'undo', 'redo', 'bold', 'italic', 'inlineCode', 'strike', 'highlight', 'underline', 'kbd',
  'link', 'wikiLink', 'inlineMath', 'selectionComment'
]);

export function commandContext(command: EditorCommandId): ShortcutContext {
  if (fixedCommands.has(command)) return 'native';
  if (globalCommands.has(command)) return 'global';
  return tableCommands.has(command) ? 'table' : 'editor';
}

export function canBindCommand(command: EditorCommandId): boolean { return !fixedCommands.has(command); }

export function defaultShortcuts(platform: ShortcutPlatform): Record<EditorCommandId, readonly string[]> {
  const primary = platform === 'mac' ? 'Cmd' : 'Ctrl';
  const result = Object.fromEntries(editorCommandIds.map(id => [id, [] as readonly string[]])) as Record<EditorCommandId, readonly string[]>;
  Object.assign(result, {
    save: [`${primary} + S`], saveAs: [`${primary} + Shift + S`], undo: [`${primary} + Z`], redo: platform === 'mac' ? ['Cmd + Shift + Z'] : ['Ctrl + Y', 'Ctrl + Shift + Z'],
    find: [`${primary} + F`], replace: platform === 'mac' ? ['Cmd + Alt + F'] : ['Ctrl + H'],
    all: [`${primary} + A`], copy: [`${primary} + C`], cut: [`${primary} + X`], paste: [`${primary} + V`],
    lineComment: [`${primary} + /`], selectionComment: ['Alt + Shift + A'], formatHtml: ['Alt + Shift + F'],
    bold: [`${primary} + B`], italic: [`${primary} + I`], mode: ['Alt + Shift + M'],
    moveUp: ['Alt + ArrowUp'], moveDown: ['Alt + ArrowDown'], copyUp: ['Alt + Shift + ArrowUp'], copyDown: ['Alt + Shift + ArrowDown'],
    deleteLine: platform === 'mac' ? ['Cmd + Shift + K'] : ['Ctrl + Shift + K'],
    cellBreak: ['Shift + Enter', 'Ctrl + Enter'], indent: ['Tab', 'Shift + Tab'], tableNav: ['Tab', 'Shift + Tab'],
    enter: ['Enter', 'Shift + Enter'], tab: ['Tab', 'Shift + Tab'], escape: ['Escape'], delete: ['Backspace', 'Delete']
  });
  if (platform === 'windows') Object.assign(result, {
    codeBlock: ['Ctrl + Shift + K'], deleteLine: [], strike: ['Alt + Shift + 5'],
    rowBelow: ['Ctrl + Enter'], cellBreak: ['Shift + Enter'],
    moveRowUp: ['Alt + ArrowUp'], moveRowDown: ['Alt + ArrowDown'],
    openFileTree: ['Ctrl + Shift + 3']
  });
  return result;
}

const namedKeys: Record<string, string> = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight', plus: 'Plus'
};

export function normalizeShortcut(value: string, secondStroke = false): string | null {
  const parts = value.trim().split(/\s*\+\s*/);
  const rawKey = parts.pop();
  if (!rawKey) return null;
  const modifiers = new Set<string>();
  for (const modifier of parts) {
    const canonical = { ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Cmd', meta: 'Cmd', command: 'Cmd', alt: 'Alt', option: 'Alt', shift: 'Shift' }[modifier.toLowerCase()];
    if (!canonical || modifiers.has(canonical)) return null;
    modifiers.add(canonical);
  }
  const key = namedKeys[rawKey.toLowerCase()] ?? (/^f(?:[1-9]|1\d|2[0-4])$/i.test(rawKey) ? rawKey.toUpperCase()
    : rawKey.length === 1 ? rawKey.toUpperCase() : null);
  if (!key || key === 'Tab' || key === 'Escape' && modifiers.size === 0) return null;
  if (!secondStroke && modifiers.size === 0 && !/^F\d+$/.test(key)) return null;
  if (!secondStroke && modifiers.size === 1 && modifiers.has('Shift') && key.length === 1) return null;
  return [...['Ctrl', 'Cmd', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier)), key].join(' + ');
}

export function shortcutFromStroke(stroke: ShortcutStroke, secondStroke = false): string | null {
  if (stroke.composing || stroke.altGraph || ['Control', 'Meta', 'Alt', 'Shift', 'Process', 'Dead', 'Unidentified'].includes(stroke.key)) return null;
  let key = stroke.key === ' ' ? 'Space' : stroke.key === '+' ? 'Plus' : stroke.key;
  if (key === '／') key = '/';
  // Physical letters retain shortcuts while an IME or alternate layout is active.
  if (stroke.code && /^Key[A-Z]$/.test(stroke.code)) key = stroke.code.slice(3);
  // Layouts such as German use Shift+7 for '/'. That Shift produces the key;
  // an explicit Shift on the dedicated slash key remains a separate modifier.
  const shift = stroke.shift && !(key === '/' && stroke.code && stroke.code !== 'Slash' && stroke.code !== 'NumpadDivide');
  return normalizeShortcut([
    ...(stroke.ctrl ? ['Ctrl'] : []), ...(stroke.meta ? ['Cmd'] : []),
    ...(stroke.alt ? ['Alt'] : []), ...(shift ? ['Shift'] : []), key
  ].join(' + '), secondStroke);
}

export function shortcutStrokeCandidates(stroke: ShortcutStroke, secondStroke = false): readonly string[] {
  const key = shortcutFromStroke(stroke, secondStroke);
  if (!key) return [];
  // Preserve shortcuts recorded as the shifted character while also matching
  // defaults expressed as a key on the number row.
  const digit = /^Digit([0-9])$/.exec(stroke.code ?? '')?.[1];
  const physical = digit && stroke.shift && (stroke.ctrl || stroke.alt || stroke.meta) && !key.endsWith(' + /')
    ? shortcutFromStroke({ ...stroke, key: digit }, secondStroke) : null;
  return physical && physical !== key ? [key, physical] : [key];
}

const protectedDefaultCommands: readonly EditorCommandId[] = [
  'saveAs', 'formatHtml', 'codeBlock', 'strike', 'rowBelow', 'moveRowUp', 'moveRowDown', 'openFileTree'
];
const shiftedNumberRowKeys: Readonly<Record<string, string>> = {
  'Alt + Shift + %': 'Alt + Shift + 5', 'Ctrl + Shift + #': 'Ctrl + Shift + 3', 'Ctrl + Shift + )': 'Ctrl + Shift + 0'
};

function sameShortcutKey(left: string, right: string, platform: ShortcutPlatform): boolean {
  return left === right || platform === 'windows' && (shiftedNumberRowKeys[left] ?? left) === (shiftedNumberRowKeys[right] ?? right);
}

export function effectiveShortcuts(
  overrides: ShortcutOverrides, platform: ShortcutPlatform, customShortcuts: readonly CustomShortcut[] = []
): Record<EditorCommandId, readonly string[]> {
  const defaults = defaultShortcuts(platform);
  for (const command of editorCommandIds) {
    const keys = overrides[command];
    if (keys && canBindCommand(command) && keys.every(key => normalizeShortcut(key))) defaults[command] = keys.map(key => normalizeShortcut(key)!);
  }
  // An explicit change to the former owner also keeps its original key from
  // gaining a new meaning on upgrade.
  if (platform === 'windows') {
    if (Object.hasOwn(overrides, 'deleteLine') && !Object.hasOwn(overrides, 'codeBlock')) defaults.codeBlock = [];
    if (Object.hasOwn(overrides, 'cellBreak') && !Object.hasOwn(overrides, 'rowBelow')) defaults.rowBelow = [];
    if (Object.hasOwn(overrides, 'moveUp') && !Object.hasOwn(overrides, 'moveRowUp')) defaults.moveRowUp = [];
    if (Object.hasOwn(overrides, 'moveDown') && !Object.hasOwn(overrides, 'moveRowDown')) defaults.moveRowDown = [];
  }
  for (const added of protectedDefaultCommands) {
    if (Object.hasOwn(overrides, added)) continue;
    defaults[added] = defaults[added].filter(key => !editorCommandIds.some(command =>
      Object.hasOwn(overrides, command) && defaults[command].some(existing => sameShortcutKey(existing, key, platform))
        && builtinLocationsOverlap(command, added, platform))
      && !customShortcuts.some(rule => rule.strokes[0] && sameShortcutKey(rule.strokes[0], key, platform)
        && customShortcutLocations(rule).some(position => builtinCommandAvailableAt(added, position, platform))));
  }
  return defaults;
}

export function shortcutConflicts(command: EditorCommandId, keys: readonly string[], overrides: ShortcutOverrides, platform: ShortcutPlatform,
  customShortcuts: readonly CustomShortcut[] = []): EditorCommandId[] {
  const wanted = keys.map(key => normalizeShortcut(key)).filter((key): key is string => key !== null);
  const context = commandContext(command);
  const bindings = effectiveShortcuts(overrides, platform, customShortcuts);
  return editorCommandIds.filter(other => {
    if (other === command) return false;
    const otherContext = commandContext(other);
    // Native navigation is a fallback. Clipboard chords remain reserved.
    if (otherContext === 'native' && !['copy', 'cut', 'paste'].includes(other)) return false;
    if (context === 'native') return false;
    return bindings[other].some(key => wanted.some(candidate => sameShortcutKey(key, candidate, platform)))
      && (otherContext === 'native' || builtinLocationsOverlap(command, other, platform));
  });
}

export type CustomShortcutConflict =
  | (Extract<ShortcutReplacement, { type: 'command' }> & { readonly fixed: boolean })
  | (Extract<ShortcutReplacement, { type: 'custom' }> & { readonly fixed: false } & Pick<CustomShortcut, 'name' | 'useDefaultName'>);

export function shortcutReplacements(conflicts: readonly CustomShortcutConflict[]): ShortcutReplacement[] {
  return conflicts.filter(conflict => !conflict.fixed).map(conflict => conflict.type === 'command'
    ? { type: conflict.type, command: conflict.command, keys: conflict.keys }
    : { type: conflict.type, id: conflict.id, scope: conflict.scope, keys: conflict.keys });
}

export class ShortcutConflictsChangedError extends Error {
  constructor() { super('Key combination is already assigned'); }
}

function assertConfirmedReplacements(conflicts: readonly CustomShortcutConflict[], confirmed: readonly ShortcutReplacement[]) {
  if (conflicts.some(conflict => conflict.fixed)) throw new ShortcutConflictsChangedError();
  for (const conflict of conflicts) {
    const matches = confirmed.some(replacement => (conflict.type === 'command' && replacement.type === 'command'
      ? conflict.command === replacement.command
      : conflict.type === 'custom' && replacement.type === 'custom' && conflict.id === replacement.id && conflict.scope === replacement.scope)
      && conflict.keys.length === replacement.keys.length && conflict.keys.every(key => replacement.keys.includes(key)));
    if (!matches) throw new ShortcutConflictsChangedError();
  }
}

function customConflict(rule: CustomShortcut): CustomShortcutConflict {
  return { type: 'custom', id: rule.id, name: rule.name, useDefaultName: rule.useDefaultName, scope: rule.scope, keys: rule.strokes, fixed: false };
}

function isTableLocation(position: ShortcutLocation): boolean { return position === 'table' || position === 'tableInput'; }

function commandAvailableAt(command: EditorCommandId, position: ShortcutLocation): boolean {
  const context = commandContext(command);
  return context === 'global' || context === 'editor' && position !== 'outsideEditor'
    || context === 'table' && isTableLocation(position);
}

function builtinCommandAvailableAt(command: EditorCommandId, position: ShortcutLocation, platform: ShortcutPlatform): boolean {
  if (platform === 'windows' && (command === 'moveUp' || command === 'moveDown' || command === 'codeBlock')) return position === 'prose';
  return commandAvailableAt(command, position);
}

function builtinLocationsOverlap(left: EditorCommandId, right: EditorCommandId, platform: ShortcutPlatform): boolean {
  return shortcutLocations.some(position =>
    builtinCommandAvailableAt(left, position, platform) && builtinCommandAvailableAt(right, position, platform));
}

export function customShortcutActionAvailableAt(action: CustomShortcutAction, position: ShortcutLocation): boolean {
  if (action.type === 'snippet') return position === 'prose'
    || isTableLocation(position) && shortcutSnippetSupportsTable(parseShortcutSnippet(action.template));
  if (action.type === 'mode') return true;
  return commandAvailableAt(action.command, position) && (!isTableLocation(position)
    || globalCommands.has(action.command) || tableCommands.has(action.command) || cellEditingCommands.has(action.command));
}

function customShortcutScopeIncludesLocation(scope: CustomShortcutScope, position: ShortcutLocation): boolean {
  return scope === 'global' || position !== 'outsideEditor';
}

export function customShortcutActionFitsScope(action: CustomShortcutAction, scope: CustomShortcutScope): boolean {
  return shortcutLocations.some(position => customShortcutScopeIncludesLocation(scope, position)
    && customShortcutActionAvailableAt(action, position));
}

export function customShortcutCanRunAt(
  shortcut: Pick<CustomShortcut, 'scope' | 'actions'>,
  position: ShortcutLocation,
  mode: typeof shortcutModes[number],
  available?: (action: CustomShortcutAction) => boolean
): boolean {
  const { scope, actions } = shortcut;
  return customShortcutScopeIncludesLocation(scope, position)
    && (scope !== 'live' && scope !== 'source' || scope === mode)
    && (position !== 'tableInput' || mode === 'live')
    && actions.some(action => customShortcutActionAvailableAt(action, position) && (available?.(action) ?? true));
}

// Actions that may open an input, hand off focus, or finish asynchronously
// can be the final step. Other steps must leave the same edit target available.
export function customShortcutActionCanContinue(action: CustomShortcutAction): boolean {
  return action.type === 'snippet' || action.type === 'command'
    && (action.command === 'cellBreak' || commandContext(action.command) === 'editor'
      && !['undo', 'redo', 'plain', 'formatHtml', 'insertTable', 'convert', 'image'].includes(action.command));
}

export function customShortcutStepOutOfOrder(shortcut: Pick<CustomShortcut, 'scope' | 'actions'>, index: number): boolean {
  const { scope, actions } = shortcut;
  if (index >= actions.length - 1 || customShortcutActionCanContinue(actions[index])) return false;
  return shortcutLocations.some(position => (scope !== 'source' || position !== 'tableInput') && customShortcutScopeIncludesLocation(scope, position)
    && customShortcutActionAvailableAt(actions[index], position)
    && actions.slice(index + 1).some(action => customShortcutActionAvailableAt(action, position)));
}

function customShortcutLocations(shortcut: Pick<CustomShortcut, 'scope' | 'actions'>): ShortcutLocation[] {
  return shortcutLocations.filter(position => customShortcutScopeIncludesLocation(shortcut.scope, position)
    && shortcut.actions.some(action => customShortcutActionAvailableAt(action, position)));
}

export function customShortcutConflicts(
  shortcut: Pick<CustomShortcut, 'id' | 'scope' | 'strokes' | 'actions'>,
  preferences: EditingPreferences,
  platform: ShortcutPlatform
): CustomShortcutConflict[] {
  const [first, second] = shortcut.strokes;
  if (!first) return [];
  const locations = customShortcutLocations(shortcut);
  const bindings = effectiveShortcuts(preferences.shortcuts, platform, preferences.customShortcuts);
  const builtin = editorCommandIds.flatMap(command => {
    const context = commandContext(command);
    if (context === 'native' && !['copy', 'cut', 'paste'].includes(command)) return [];
    const keys = bindings[command].filter(key => sameShortcutKey(key, first, platform));
    return keys.length && locations.some(position => context === 'native' || builtinCommandAvailableAt(command, position, platform))
      ? [{ type: 'command' as const, command, keys, fixed: !canBindCommand(command) }] : [];
  });
  const custom = (preferences.customShortcuts ?? []).filter(other => other.id !== shortcut.id
    && other.strokes[0] && sameShortcutKey(first, other.strokes[0], platform)
    && (!second || !other.strokes[1] || sameShortcutKey(second, other.strokes[1], platform))
    && locations.some(position => shortcutModes.some(mode =>
      customShortcutCanRunAt(shortcut, position, mode) && customShortcutCanRunAt(other, position, mode))));
  return [
    ...builtin,
    ...custom.map(customConflict)
  ];
}

export function builtinShortcutConflicts(command: EditorCommandId, keys: readonly string[], preferences: EditingPreferences, platform: ShortcutPlatform): CustomShortcutConflict[] {
  const bindings = effectiveShortcuts(preferences.shortcuts, platform, preferences.customShortcuts);
  return [
    ...shortcutConflicts(command, keys, preferences.shortcuts, platform, preferences.customShortcuts).map(other => ({
      type: 'command' as const, command: other, keys: bindings[other].filter(key => keys.some(candidate => sameShortcutKey(candidate, key, platform))), fixed: !canBindCommand(other)
    })),
    ...(preferences.customShortcuts ?? []).filter(other => other.strokes[0] && keys.some(key => sameShortcutKey(key, other.strokes[0], platform))
      && customShortcutLocations(other).some(position => builtinCommandAvailableAt(command, position, platform))).map(customConflict)
  ];
}

function normalizeCustomShortcut(value: unknown): CustomShortcut | null {
  if (!isCustomShortcut(value)
    || !value.actions.some(action => customShortcutActionFitsScope(action, value.scope))
    || value.actions.some((action, index) => action.type === 'command' && !canBindCommand(action.command)
      || customShortcutStepOutOfOrder(value, index))) return null;
  const strokes = value.strokes.map((stroke, index) => normalizeShortcut(stroke, index === 1));
  if (!strokes.every((stroke): stroke is string => stroke !== null)) return null;
  const actions = value.actions.map((action): CustomShortcutAction => action.type === 'snippet'
    ? { type: 'snippet', template: action.template.replace(/\r\n?/g, '\n') }
    : action.type === 'mode' ? { type: 'mode', mode: action.mode } : { type: 'command', command: action.command });
  return { id: value.id, name: value.name.trim(), scope: value.scope, strokes, actions,
    ...(value.useDefaultName ? { useDefaultName: true } : {}) };
}

export function normalizeEditingPreferences(value: unknown): EditingPreferences {
  const record = value && typeof value === 'object' ? value as Partial<EditingPreferences> : {};
  return {
    input: { ...defaultInputAssistance, ...Object.fromEntries(Object.entries(record.input ?? {}).filter(([key, value]) => {
      if (!Object.hasOwn(defaultInputAssistance, key)) return false;
      const fallback = defaultInputAssistance[key as keyof typeof defaultInputAssistance];
      return typeof fallback === 'boolean' ? typeof value === 'boolean' : fallback !== undefined && ['smart', 'always', 'off'].includes(String(value));
    })) },
    shortcuts: Object.fromEntries(Object.entries(record.shortcuts ?? {}).filter(([id, keys]) =>
      editorCommandIds.includes(id as EditorCommandId) && canBindCommand(id as EditorCommandId)
      && Array.isArray(keys) && keys.length <= 4 && keys.every(key => typeof key === 'string' && key.length <= 80 && normalizeShortcut(key))).map(([id, keys]) => [id, [...new Set((keys as string[]).map(key => normalizeShortcut(key)!))]])),
    ...(Array.isArray(record.customShortcuts) ? {
      customShortcuts: [...new Map(record.customShortcuts.flatMap(raw => {
        const shortcut = normalizeCustomShortcut(raw);
        return shortcut ? [[shortcut.id, shortcut] as const] : [];
      })).values()]
    } : {})
  };
}

export function withDefaultCustomShortcuts(preferences: EditingPreferences, platform: ShortcutPlatform): EditingPreferences {
  // An explicit empty list records that the user removed all actions.
  if (preferences.customShortcuts !== undefined) return preferences;
  const example: CustomShortcut = {
    id: insertCurrentTimeExampleId,
    name: insertCurrentTimeExampleName,
    useDefaultName: true,
    scope: 'editor',
    strokes: ['Ctrl + Alt + T'],
    actions: [{ type: 'snippet', template: '${CURRENT_YEAR}-${CURRENT_MONTH}-${CURRENT_DATE} ${CURRENT_HOUR}:${CURRENT_MINUTE}:${CURRENT_SECOND}' }]
  };
  const strokes = customShortcutConflicts(example, preferences, platform).length ? [] : example.strokes;
  return { ...preferences, customShortcuts: [{ ...example, strokes }] };
}

export function changeEditingPreferences(current: EditingPreferences, change: EditingPreferencesChange, platform: ShortcutPlatform): EditingPreferences {
  if (change.type === 'input') return { ...current, input: { ...current.input, [change.key]: change.value } };
  if (change.type === 'resetShortcuts') return { ...current, shortcuts: {}, ...(current.customShortcuts ? {
    customShortcuts: current.customShortcuts.map(shortcut => ({ ...shortcut, strokes: [] }))
  } : {}) };
  if (change.type === 'deleteCustomShortcut') return {
    ...current, customShortcuts: (current.customShortcuts ?? []).filter(shortcut => shortcut.id !== change.id)
  };
  if (change.type === 'saveCustomShortcut') {
    const shortcut = normalizeCustomShortcut(change.shortcut);
    if (!shortcut) throw new Error('Invalid shortcut rule');
    const conflicts = customShortcutConflicts(shortcut, current, platform);
    assertConfirmedReplacements(conflicts, change.confirmedReplacements);
    const shortcuts = { ...current.shortcuts };
    const bindings = effectiveShortcuts(shortcuts, platform, current.customShortcuts);
    const customShortcuts = [...current.customShortcuts ?? []];
    for (const conflict of conflicts) {
      if (conflict.type === 'command') shortcuts[conflict.command] = bindings[conflict.command].filter(key => !conflict.keys.includes(key));
      else {
        const index = customShortcuts.findIndex(other => other.id === conflict.id);
        customShortcuts[index] = { ...customShortcuts[index], strokes: [] };
      }
    }
    const index = customShortcuts.findIndex(other => other.id === shortcut.id);
    if (index === -1) customShortcuts.push(shortcut);
    else customShortcuts[index] = shortcut;
    return { ...current, shortcuts, customShortcuts };
  }
  if (!canBindCommand(change.command)) throw new Error('This platform binding cannot be changed');
  const keys = change.keys.map(key => normalizeShortcut(key));
  if (!keys.every((key): key is string => key !== null) || new Set(keys).size !== keys.length) throw new Error('Invalid key combination');
  const conflicts = builtinShortcutConflicts(change.command, keys, current, platform);
  assertConfirmedReplacements(conflicts, change.confirmedReplacements);
  const shortcuts = { ...current.shortcuts };
  const bindings = effectiveShortcuts(shortcuts, platform, current.customShortcuts);
  const customConflicts = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.type === 'command') shortcuts[conflict.command] = bindings[conflict.command].filter(key => !conflict.keys.includes(key));
    else customConflicts.add(conflict.id);
  }
  shortcuts[change.command] = keys;
  return { ...current, shortcuts, ...(customConflicts.size ? {
    customShortcuts: current.customShortcuts?.map(shortcut => customConflicts.has(shortcut.id) ? { ...shortcut, strokes: [] } : shortcut)
  } : {}) };
}

export function resolveShortcut(stroke: ShortcutStroke, overrides: ShortcutOverrides, platform: ShortcutPlatform, context: 'global' | 'editor' | 'table',
  customShortcuts?: readonly CustomShortcut[]): EditorCommandId | null {
  const candidates = [...shortcutStrokeCandidates(stroke)];
  const [key] = candidates;
  if (!key) return null;
  const bindings = effectiveShortcuts(overrides, platform, customShortcuts);
  // Older shortcut recordings kept the Shift needed to type '/'. Honor those
  // explicit bindings before falling back to the layout-independent gesture.
  if (stroke.shift && key.endsWith(' + /') && !key.includes(' + Shift + ')) candidates.unshift(key.slice(0, -4) + ' + Shift + /');
  const position = context === 'global' ? 'outsideEditor' : context === 'editor' ? 'prose' : 'table';
  for (const candidate of candidates) {
    const command = editorCommandIds.find(command => bindings[command].includes(candidate) && builtinCommandAvailableAt(command, position, platform));
    if (command) return command;
  }
  return null;
}
