import {
  defaultInputAssistance, editorCommandIds, isCustomShortcut, type CustomShortcut, type CustomShortcutAction,
  type CustomShortcutScope, type EditingPreferences, type EditingPreferencesChange, type EditorCommandId, type ShortcutOverrides
} from '../foundation/editingPreferences';

export type ShortcutPlatform = 'mac' | 'other';
export type ShortcutContext = 'global' | 'editor' | 'table' | 'native';
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
const globalCommands = new Set<EditorCommandId>(['save', 'saveAs', 'find', 'replace', 'mode', 'preview']);
const tableCommands = new Set<EditorCommandId>([
  'cellBreak', 'rowAbove', 'rowBelow', 'rowDelete', 'columnBefore', 'columnAfter', 'columnDelete',
  'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight', 'alignLeft', 'alignCenter', 'alignRight', 'copyMarkdown', 'copyCsv'
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

export function effectiveShortcuts(overrides: ShortcutOverrides, platform: ShortcutPlatform): Record<EditorCommandId, readonly string[]> {
  const defaults = defaultShortcuts(platform);
  for (const command of editorCommandIds) {
    const keys = overrides[command];
    if (keys && canBindCommand(command) && keys.every(key => normalizeShortcut(key))) defaults[command] = keys.map(key => normalizeShortcut(key)!);
  }
  // Newly introduced defaults must not steal older custom bindings.
  for (const added of ['saveAs', 'formatHtml'] as const) {
    if (!Object.hasOwn(overrides, added) && editorCommandIds.some(command => command !== added
      && canBindCommand(command) && Object.hasOwn(overrides, command)
      && defaults[command].some(key => defaults[added].includes(key)))) defaults[added] = [];
  }
  return defaults;
}

export function shortcutConflicts(command: EditorCommandId, keys: readonly string[], overrides: ShortcutOverrides, platform: ShortcutPlatform): EditorCommandId[] {
  const wanted = new Set(keys.map(key => normalizeShortcut(key)));
  const context = commandContext(command);
  const bindings = effectiveShortcuts(overrides, platform);
  return editorCommandIds.filter(other => {
    if (other === command) return false;
    const otherContext = commandContext(other);
    // Native navigation is a fallback. Clipboard chords remain reserved.
    if (otherContext === 'native' && !['copy', 'cut', 'paste'].includes(other)) return false;
    if (context === 'native') return false;
    return bindings[other].some(key => wanted.has(normalizeShortcut(key)))
      && (context === otherContext || context === 'global' || otherContext === 'global'
        || context === 'editor' || otherContext === 'editor' || otherContext === 'native');
  });
}

export type CustomShortcutConflict =
  | { readonly type: 'command'; readonly command: EditorCommandId; readonly fixed: boolean }
  | { readonly type: 'custom'; readonly id: string; readonly name: string; readonly fixed: false };

export function customShortcutActionFitsScope(action: CustomShortcutAction, scope: CustomShortcutScope): boolean {
  if (action.type === 'snippet') return scope === 'editor' || scope === 'live' || scope === 'source';
  if (action.type === 'mode') return true;
  const context = commandContext(action.command);
  return context === 'global' || context === 'table' && scope === 'table' || context === 'editor' && scope !== 'global';
}

// Actions that may open an input, hand off focus, or finish asynchronously
// can be the final step. Other steps must leave the same edit target available.
export function customShortcutActionCanContinue(action: CustomShortcutAction): boolean {
  return action.type === 'snippet' || action.type === 'command'
    && commandContext(action.command) === 'editor'
    && !['undo', 'redo', 'plain', 'formatHtml', 'insertTable', 'convert', 'image'].includes(action.command);
}

function scopesOverlap(left: CustomShortcutScope, right: CustomShortcutScope): boolean {
  return left === right || left === 'global' || right === 'global'
    || left === 'editor' && (right === 'live' || right === 'source')
    || right === 'editor' && (left === 'live' || left === 'source');
}

export function customShortcutConflicts(
  shortcut: Pick<CustomShortcut, 'id' | 'scope' | 'strokes'>,
  preferences: EditingPreferences,
  platform: ShortcutPlatform
): CustomShortcutConflict[] {
  const [first, second] = shortcut.strokes;
  if (!first) return [];
  const bindings = effectiveShortcuts(preferences.shortcuts, platform);
  const builtin = editorCommandIds.filter(command => {
    const context = commandContext(command);
    if (context === 'native' && !['copy', 'cut', 'paste'].includes(command)) return false;
    return bindings[command].includes(first) && (context === 'editor' && shortcut.scope === 'table'
      || context === 'native' || scopesOverlap(context, shortcut.scope));
  });
  const custom = (preferences.customShortcuts ?? []).filter(other => other.id !== shortcut.id
    && first === other.strokes[0] && (!second || !other.strokes[1] || second === other.strokes[1])
    && scopesOverlap(shortcut.scope, other.scope));
  return [
    ...builtin.map(command => ({ type: 'command' as const, command, fixed: !canBindCommand(command) })),
    ...custom.map(other => ({ type: 'custom' as const, id: other.id, name: other.name, fixed: false as const }))
  ];
}

export function builtinShortcutCustomConflicts(command: EditorCommandId, keys: readonly string[], preferences: EditingPreferences): readonly CustomShortcut[] {
  const context = commandContext(command);
  if (context === 'native') return [];
  return (preferences.customShortcuts ?? []).filter(other => keys.includes(other.strokes[0])
    && (scopesOverlap(context, other.scope) || context === 'editor' && other.scope === 'table'));
}

function normalizeCustomShortcut(value: unknown): CustomShortcut | null {
  if (!isCustomShortcut(value) || !value.actions.every((action, index) => customShortcutActionFitsScope(action, value.scope)
    && (index === value.actions.length - 1 || customShortcutActionCanContinue(action)))) return null;
  const strokes = value.strokes.map((stroke, index) => normalizeShortcut(stroke, index === 1));
  if (!strokes.every((stroke): stroke is string => stroke !== null)) return null;
  const actions = value.actions.map((action): CustomShortcutAction => action.type === 'snippet'
    ? { type: 'snippet', template: action.template.replace(/\r\n?/g, '\n') }
    : action.type === 'mode' ? { type: 'mode', mode: action.mode } : { type: 'command', command: action.command });
  return { id: value.id, name: value.name.trim(), scope: value.scope, strokes, actions };
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
    if (conflicts.length && (!change.replaceConflicts || conflicts.some(conflict => conflict.fixed))) {
      throw new Error('Key combination is already assigned');
    }
    const shortcuts = { ...current.shortcuts };
    const bindings = effectiveShortcuts(shortcuts, platform);
    const customShortcuts = [...current.customShortcuts ?? []];
    for (const conflict of conflicts) {
      if (conflict.type === 'command') shortcuts[conflict.command] = bindings[conflict.command].filter(key => key !== shortcut.strokes[0]);
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
  const conflicts = shortcutConflicts(change.command, keys, current.shortcuts, platform);
  const customConflicts = new Set(builtinShortcutCustomConflicts(change.command, keys, current).map(shortcut => shortcut.id));
  if ((conflicts.length || customConflicts.size) && (!change.replaceConflicts || conflicts.some(command => !canBindCommand(command)))) throw new Error('Key combination is already assigned');
  const shortcuts = { ...current.shortcuts };
  const bindings = effectiveShortcuts(shortcuts, platform);
  for (const conflict of conflicts) shortcuts[conflict] = bindings[conflict].filter(key => !keys.includes(key));
  shortcuts[change.command] = keys;
  return { ...current, shortcuts, ...(customConflicts.size ? {
    customShortcuts: current.customShortcuts?.map(shortcut => customConflicts.has(shortcut.id) ? { ...shortcut, strokes: [] } : shortcut)
  } : {}) };
}

export function resolveShortcut(stroke: ShortcutStroke, overrides: ShortcutOverrides, platform: ShortcutPlatform, context: 'global' | 'editor' | 'table'): EditorCommandId | null {
  const key = shortcutFromStroke(stroke);
  if (!key) return null;
  const bindings = effectiveShortcuts(overrides, platform);
  // Older shortcut recordings kept the Shift needed to type '/'. Honor those
  // explicit bindings before falling back to the layout-independent gesture.
  const candidates = stroke.shift && key.endsWith(' + /') && !key.includes(' + Shift + ')
    ? [key.slice(0, -4) + ' + Shift + /', key] : [key];
  for (const candidate of candidates) {
    const command = editorCommandIds.find(command => canBindCommand(command) && bindings[command].includes(candidate)
      && (commandContext(command) === 'global' || context === 'editor' && commandContext(command) === 'editor'
        || context === 'table' && ['editor', 'table'].includes(commandContext(command))));
    if (command) return command;
  }
  return null;
}
