import { commandContext, defaultShortcuts, resolveShortcut, shortcutFromStroke, type ShortcutPlatform, type ShortcutStroke } from '../../../src/application/editingPreferences';
import type { CustomShortcut, EditorCommandId, ShortcutOverrides } from '../../../src/foundation/editingPreferences';
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const isPrimaryModifier = (event: KeyboardEvent): boolean => event.metaKey !== event.ctrlKey && (event.metaKey || event.ctrlKey);
export const isShortcutKey = (event: KeyboardEvent, key: string, code: string): boolean => event.key.toLowerCase() === key || event.code === code;
export { normalizeDocumentText as normalizeEol } from '../../../src/foundation/documentText';

type EditorMode = 'live' | 'source';
type ActiveShortcutScope = 'global' | 'editor' | 'table';

export function createCustomShortcutMatcher() {
  let pending: { first: string; at: number; rules: readonly CustomShortcut[]; target: EventTarget | null; scope: ActiveShortcutScope; mode: EditorMode } | null = null;
  return {
    cancel() { pending = null; },
    match(event: KeyboardEvent, stroke: ShortcutStroke, rules: readonly CustomShortcut[], scope: ActiveShortcutScope, mode: EditorMode): CustomShortcut | 'waiting' | null {
      const eligible = (rule: CustomShortcut) => rule.scope === 'global' || rule.scope === scope
        || scope === 'editor' && rule.scope === mode;
      const first = shortcutFromStroke(stroke);
      if (pending && pending.rules === rules && pending.target === event.target && pending.scope === scope
        && pending.mode === mode && event.timeStamp - pending.at <= 1500) {
        if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return null;
        if (event.repeat && first === pending.first) return 'waiting';
        const second = shortcutFromStroke(stroke, true);
        const prefix = pending.first;
        const rule = rules.find(rule => eligible(rule) && rule.strokes.length === 2
          && rule.strokes[0] === prefix && rule.strokes[1] === second);
        pending = null;
        if (rule) return event.repeat ? 'waiting' : rule;
      }
      pending = null;
      if (!first) return null;
      const exact = rules.find(rule => eligible(rule) && rule.strokes.length === 1 && rule.strokes[0] === first);
      if (exact) return event.repeat ? 'waiting' : exact;
      if (!rules.some(rule => eligible(rule) && rule.strokes.length === 2 && rule.strokes[0] === first)) return null;
      if (!event.repeat) pending = { first, at: event.timeStamp, rules, target: event.target, scope, mode };
      return 'waiting';
    }
  };
}

export interface ShortcutHandlerContext {
  editor: any;
  editableMode: 'live' | 'source';
  editorSurfaceActive: boolean;
  shortcuts?: ShortcutOverrides;
  customShortcuts?: readonly CustomShortcut[];
  customShortcutMatcher?: ReturnType<typeof createCustomShortcutMatcher>;
  insertSnippet?: (template: string) => boolean;
  setMode?: (mode: 'live' | 'source' | 'preview') => void;
  platform?: ShortcutPlatform;
  requestSave: () => void;
  requestSaveAs?: () => void;
  openFindPanel: (target: 'find' | 'replace') => void;
  requestMode: (mode: 'live' | 'source') => void;
  requestPreview?: () => void;
  requestPlainPaste?: () => void;
  requestTableCopy?: (format: 'markdown' | 'csv') => void;
}
export const handleEditorShortcut = (event: KeyboardEvent, context: ShortcutHandlerContext): boolean => {
  const editor = context.editor;
  const matcher = context.customShortcutMatcher;
  if (!editor || event.isComposing || event.keyCode === 229 || editor.view?.compositionStarted || event.getModifierState?.('AltGraph')) {
    matcher?.cancel();
    return false;
  }
  const target = event.target;
  // Preview targets belong to the iframe's realm, so instanceof Element from
  // the outer window would miss its input and contenteditable controls.
  const targetElement = typeof (target as Element | null)?.closest === 'function' ? target as Element : null;
  if (targetElement) {
    if (targetElement.closest('[data-meo-settings]')) { matcher?.cancel(); return false; }
    const input = targetElement.closest('input, textarea, [contenteditable="true"]');
    if (input && !editor.view?.dom.contains(input)) { matcher?.cancel(); return false; }
  }
  const editorFocused = editor.hasFocus();
  const detached = context.editorSurfaceActive && (target as Node | null)?.nodeName === 'BODY';
  const editable = context.editorSurfaceActive && (editorFocused || detached);
  const table = editable && (editor.isTableFocused?.() ?? false);
  const scope = table ? 'table' : editable ? 'editor' : 'global';
  const platform = context.platform ?? (isMac ? 'mac' : 'other');
  const stroke = { key: event.key, code: event.code, ctrl: !!event.ctrlKey, meta: !!event.metaKey, alt: !!event.altKey, shift: !!event.shiftKey, composing: event.isComposing, altGraph: event.getModifierState?.('AltGraph') ?? false };
  const nestedInput = targetElement?.matches('input, textarea') && !targetElement.closest('.meo-md-html-table-wrap');
  const consume = () => { event.preventDefault(); event.stopPropagation(); };
  const rules = context.customShortcuts;
  if (matcher && rules?.length) {
    const body = context.editorSurfaceActive && editor.view?.hasFocus
      && targetElement && editor.view.contentDOM.contains(targetElement);
    const ruleScope = context.editorSurfaceActive && editorFocused && table && !nestedInput ? 'table' : body ? 'editor' : 'global';
    const rule = matcher.match(event, stroke, rules, ruleScope, context.editableMode);
    if (rule) {
      consume();
      if (rule !== 'waiting') for (const action of rule.actions) {
        if (action.type === 'snippet') { if (!context.insertSnippet?.(action.template)) break; }
        else if (action.type === 'mode') context.setMode?.(action.mode);
        else if (!runShortcutCommand(action.command, context)) break;
      }
      return true;
    }
  }
  const command = resolveShortcut(stroke, context.shortcuts ?? {}, platform, scope);
  if (nestedInput && command && !['undo', 'redo', 'plain'].includes(command) && commandContext(command) !== 'global') return false;
  if (detached && !editorFocused && command && !['undo', 'redo'].includes(command) && commandContext(command) !== 'global') return false;
  if (!command) {
    // A cleared/reassigned gesture must not fall through to CodeMirror's old default map.
    const key = shortcutFromStroke(stroke);
    const removedDefault = editable && key && Object.entries(defaultShortcuts(platform)).some(([id, keys]) => keys.includes(key) && commandContext(id as Parameters<typeof commandContext>[0]) !== 'native'
      && (commandContext(id as Parameters<typeof commandContext>[0]) !== 'table' || table));
    if (removedDefault) { consume(); return true; }
    return false;
  }
  consume();
  runShortcutCommand(command, context);
  return true;
};

function runShortcutCommand(command: EditorCommandId, context: ShortcutHandlerContext): boolean {
  const editor = context.editor;
  switch (command) {
    case 'save': context.requestSave(); break;
    case 'saveAs': context.requestSaveAs?.(); break;
    case 'find': case 'replace': context.openFindPanel(command); break;
    case 'mode': context.requestMode(context.editableMode === 'live' ? 'source' : 'live'); break;
    case 'preview': context.requestPreview?.(); break;
    case 'undo': editor.undo(); break;
    case 'redo': editor.redo(); break;
    case 'all': editor.selectAll(); break;
    case 'plain': context.requestPlainPaste?.(); break;
    case 'copyMarkdown': case 'copyCsv': context.requestTableCopy?.(command === 'copyCsv' ? 'csv' : 'markdown'); break;
    default: return editor.executeCommand?.(command) ?? false;
  }
  return true;
}
