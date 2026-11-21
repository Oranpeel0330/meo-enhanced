import { commandContext, customShortcutActionAvailableAt, customShortcutActionCanContinue, customShortcutCanRunAt, resolveShortcut,
  shortcutPlatformFor, shortcutStrokeCandidates, type ShortcutLocation, type ShortcutPlatform, type ShortcutStroke } from '../../../src/application/editingPreferences';
import type { CustomShortcut, CustomShortcutAction, EditorCommandId, ShortcutOverrides } from '../../../src/foundation/editingPreferences';
export const webviewShortcutPlatform = shortcutPlatformFor(navigator.platform);
export const isPrimaryModifier = (event: KeyboardEvent): boolean => event.metaKey !== event.ctrlKey && (event.metaKey || event.ctrlKey);
export const isShortcutKey = (event: KeyboardEvent, key: string, code: string): boolean => event.key.toLowerCase() === key || event.code === code;
export { normalizeDocumentText as normalizeEol } from '../../../src/foundation/documentText';

type EditorMode = 'live' | 'source';

export function createCustomShortcutMatcher() {
  let pending: { first: string; at: number; rules: readonly CustomShortcut[]; target: EventTarget | null; location: ShortcutLocation; mode: EditorMode } | null = null;
  return {
    cancel() { pending = null; },
    match(event: KeyboardEvent, stroke: ShortcutStroke, rules: readonly CustomShortcut[], location: ShortcutLocation, mode: EditorMode,
      available?: (action: CustomShortcutAction) => boolean): CustomShortcut | 'waiting' | null {
      const eligible = (rule: CustomShortcut) => customShortcutCanRunAt(rule, location, mode, available);
      const first = shortcutStrokeCandidates(stroke);
      if (pending && pending.rules === rules && pending.target === event.target && pending.location === location
        && pending.mode === mode && event.timeStamp - pending.at <= 1500) {
        if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return null;
        if (event.repeat && first.includes(pending.first)) return 'waiting';
        const second = shortcutStrokeCandidates(stroke, true);
        const prefix = pending.first;
        const rule = rules.find(rule => rule.strokes[0] === prefix && second.includes(rule.strokes[1]) && eligible(rule));
        pending = null;
        if (rule) return event.repeat ? 'waiting' : rule;
      }
      pending = null;
      const matched = first.find(key => rules.some(rule => rule.strokes[0] === key && eligible(rule)));
      if (!matched) return null;
      const candidates = rules.filter(rule => rule.strokes[0] === matched && eligible(rule));
      const exact = candidates.find(rule => rule.strokes.length === 1);
      if (exact) return event.repeat ? 'waiting' : exact;
      if (!candidates.length) return null;
      if (!event.repeat) pending = { first: matched, at: event.timeStamp, rules, target: event.target, location, mode };
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
  reportCustomShortcutError?: (rule: CustomShortcut, index: number, error: unknown) => void;
  canInsertSnippet?: (template: string) => boolean;
  insertSnippet?: (template: string) => boolean;
  setMode?: (mode: 'live' | 'source' | 'preview') => void | Promise<void>;
  platform?: ShortcutPlatform;
  requestSave: () => void;
  requestSaveAs?: () => void | Promise<void>;
  openFindPanel: (target: 'find' | 'replace') => void;
  requestMode: (mode: 'live' | 'source') => void | Promise<void>;
  requestPreview?: () => void | Promise<void>;
  requestPlainPaste?: () => void | Promise<void>;
  requestTableCopy?: (format: 'markdown' | 'csv') => void | Promise<void>;
  requestWorkbenchAction?: (action: 'openFileTree' | 'resetWindowZoom') => void;
}
export const handleEditorShortcut = (event: KeyboardEvent, context: ShortcutHandlerContext): boolean => {
  const editor = context.editor;
  const matcher = context.customShortcutMatcher;
  if (event.isComposing || event.keyCode === 229 || editor?.view?.compositionStarted || event.getModifierState?.('AltGraph')) {
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
    if (input && !editor?.view?.dom.contains(input)) { matcher?.cancel(); return false; }
  }
  const editorFocused = editor?.hasFocus() ?? false;
  const detached = !!editor && context.editorSurfaceActive && (target as Node | null)?.nodeName === 'BODY';
  const editable = context.editorSurfaceActive && (editorFocused || detached);
  const table = editable && (editor.isTableFocused?.() ?? false);
  const scope = table ? 'table' : editable ? 'editor' : 'global';
  const platform = context.platform ?? webviewShortcutPlatform;
  const stroke = { key: event.key, code: event.code, ctrl: !!event.ctrlKey, meta: !!event.metaKey, alt: !!event.altKey, shift: !!event.shiftKey, composing: event.isComposing, altGraph: event.getModifierState?.('AltGraph') ?? false };
  const nestedInput = targetElement?.matches('input, textarea') && !targetElement.closest('.meo-md-html-table-wrap');
  const consume = () => { event.preventDefault(); event.stopPropagation(); };
  const rules = context.customShortcuts;
  if (editor && matcher && rules?.length) {
    const editingLocation = (focused: boolean): ShortcutLocation => {
      if (!context.editorSurfaceActive || !focused || nestedInput) return 'outsideEditor';
      if (editor.isCustomShortcutTableFocused?.() ?? editor.isTableFocused?.()) return editor.isTableInputFocused?.() ? 'tableInput' : 'table';
      return editor.view?.hasFocus && targetElement && editor.view.contentDOM.contains(targetElement) ? 'prose' : 'outsideEditor';
    };
    const available = (action: CustomShortcutAction) => action.type === 'snippet'
      ? context.canInsertSnippet?.(action.template) ?? Boolean(context.insertSnippet)
      : action.type === 'command' && commandContext(action.command) !== 'global'
        ? editor.canRunCustomShortcutCommand?.(action.command) ?? true : true;
    const location = editingLocation(editorFocused);
    const rule = matcher.match(event, stroke, rules, location, context.editableMode, available);
    if (rule === 'waiting') { consume(); return true; }
    if (rule) {
      let handled = false;
      for (const [index, action] of rule.actions.entries()) {
        if (!customShortcutActionAvailableAt(action, location)) continue;
        const report = (error: unknown) => context.reportCustomShortcutError?.(rule, index, error);
        try {
          const currentLocation = editingLocation(editor.hasFocus());
          if (currentLocation !== location
            && !customShortcutCanRunAt({ scope: rule.scope, actions: [action] }, currentLocation, context.editableMode)) continue;
          if (!available(action)) continue;
          const result = action.type === 'snippet' ? context.insertSnippet?.(action.template) ?? false
            : action.type === 'mode' ? context.setMode?.(action.mode) ?? Boolean(context.setMode)
              : runShortcutCommand(action.command, context, report);
          if (result === false) continue;
          handled = true;
          if (typeof result !== 'boolean') {
            void result.catch(report);
            break;
          }
          if (!customShortcutActionCanContinue(action)) break;
        } catch (error) {
          handled = true;
          report(error);
          break;
        }
      }
      if (handled) { consume(); return true; }
    }
  }
  const command = resolveShortcut(stroke, context.shortcuts ?? {}, platform, scope, rules);
  if (command === 'openFileTree' || command === 'resetWindowZoom') {
    if (!context.requestWorkbenchAction) return false;
    consume();
    if (!event.repeat) context.requestWorkbenchAction(command);
    return true;
  }
  if (!editor) return false;
  if (nestedInput && command && !['undo', 'redo', 'plain'].includes(command) && commandContext(command) !== 'global') return false;
  if (detached && !editorFocused && command && !['undo', 'redo'].includes(command) && commandContext(command) !== 'global') return false;
  if (!command) {
    // A cleared/reassigned gesture must not fall through to CodeMirror's old default map.
    const removedDefault = editable && resolveShortcut(stroke, {}, platform, scope);
    if (removedDefault) { consume(); return true; }
    return false;
  }
  consume();
  runShortcutCommand(command, context);
  return true;
};

function runShortcutCommand(command: EditorCommandId, context: ShortcutHandlerContext, report?: (error: unknown) => void): boolean | Promise<void | boolean> {
  const editor = context.editor;
  switch (command) {
    case 'save': context.requestSave(); break;
    case 'saveAs': return context.requestSaveAs?.() ?? Boolean(context.requestSaveAs);
    case 'find': case 'replace': context.openFindPanel(command); break;
    case 'mode': return context.requestMode(context.editableMode === 'live' ? 'source' : 'live') ?? true;
    case 'preview': return context.requestPreview?.() ?? Boolean(context.requestPreview);
    case 'openFileTree': case 'resetWindowZoom':
      if (!context.requestWorkbenchAction) return false;
      context.requestWorkbenchAction(command);
      return true;
    case 'undo': return editor.undo() ?? true;
    case 'redo': return editor.redo() ?? true;
    case 'all': editor.selectAll(); break;
    case 'plain': return context.requestPlainPaste?.() ?? Boolean(context.requestPlainPaste);
    case 'copyMarkdown': case 'copyCsv': return context.requestTableCopy?.(command === 'copyCsv' ? 'csv' : 'markdown') ?? Boolean(context.requestTableCopy);
    default: return editor.executeCommand?.(command, report) ?? false;
  }
  return true;
}
