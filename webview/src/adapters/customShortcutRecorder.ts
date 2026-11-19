import { X } from 'lucide';
import { shortcutFromStroke } from '../../../src/application/editingPreferences';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { settingsText } from '../application/settingsCatalog';
import { button, element, iconButton, keycaps } from './customShortcutControls';

export function createCustomShortcutRecorder(options: {
  language: UiLanguage;
  strokes: () => readonly string[];
  onRecord: (strokes: readonly string[]) => void;
  onChange: () => void;
}) {
  const t = (zh: string, en: string) => settingsText(options.language, zh, en);
  const bindings = element('section', 'settings-shortcut-edit-section');
  const bindingHeading = element('h3', 'settings-shortcut-edit-label', t('按键', 'Keybinding'));
  const recorder = element('div', 'settings-shortcut-capture');
  const preview = element('div', 'settings-shortcut-keys');
  const recordHint = element('p', 'settings-description settings-shortcut-record-hint');
  recordHint.setAttribute('role', 'status');
  recordHint.id = 'meo-shortcut-record-hint';
  const recordingInput = element('input', 'settings-recorder settings-shortcut-field-input');
  recordingInput.readOnly = true;
  recordingInput.setAttribute('aria-label', t('录制按键', 'Record keystrokes'));
  recordingInput.setAttribute('aria-describedby', recordHint.id);
  let captured: string[] | null = null;
  const recordField = element('div', 'settings-shortcut-record-field');
  const clearCapture = iconButton(X, t('清空已录按键', 'Clear captured keys'), () => {
    if (captured === null) return;
    recordingInput.focus({ preventScroll: true });
    captured = [];
    refreshRecording();
  });
  clearCapture.classList.add('settings-shortcut-record-clear');
  clearCapture.dataset.shortcutClearRecording = '';
  recordField.append(recordingInput, clearCapture);
  const record = button('', () => { captured = []; refreshRecording(); recordingInput.focus(); });
  record.dataset.shortcutRecord = '';
  const clear = button(t('清除', 'Clear'), () => { options.onRecord([]); refreshRecording(); record.focus(); }, 'settings-button settings-subtle');
  const finish = button(t('完成', 'Done'), () => finishRecording(true, true));
  finish.dataset.shortcutRecordDone = '';
  const cancelRecord = button(t('取消录制', 'Cancel recording'), () => finishRecording(false, true), 'settings-button settings-subtle');
  recorder.append(preview, recordField, record, clear, finish, cancelRecord);
  bindings.append(bindingHeading, recorder, recordHint);

  function refreshRecording() {
    const active = captured !== null;
    const strokes = options.strokes();
    preview.hidden = record.hidden = active;
    clear.hidden = active || !strokes.length;
    recordField.hidden = finish.hidden = cancelRecord.hidden = recordHint.hidden = !active;
    clearCapture.disabled = !captured?.length;
    preview.replaceChildren(...(strokes.length ? keycaps(strokes, t('然后', 'then')) : [element('span', 'settings-unassigned', t('未设置', 'Unassigned'))]));
    record.textContent = strokes.length ? t('重新录制', 'Record again') : t('录制', 'Record');
    recordingInput.value = captured?.join(t('，然后 ', ', then ')) ?? '';
    recordingInput.placeholder = t('按下快捷键', 'Press a shortcut');
    recordHint.textContent = !captured ? '' : captured.length === 0
      ? t('按下第一组按键。按 Esc 取消录制。', 'Press the first keystroke. Press Esc to cancel.')
      : t('可以直接按第二组，或选择「完成」。', 'Press a second keystroke or choose Done.');
    options.onChange();
  }

  function finishRecording(accept: boolean, focus: boolean) {
    if (!captured) return false;
    const strokes = captured;
    captured = null;
    if (accept && strokes.length) options.onRecord(strokes);
    refreshRecording();
    if (focus) record.focus();
    return true;
  }

  recordingInput.addEventListener('keydown', event => {
    if (!captured || event.key === 'Tab' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      finishRecording(false, true);
      return;
    }
    const second = captured.length === 1;
    const stroke = shortcutFromStroke({ key: event.key, code: event.code, ctrl: event.ctrlKey, alt: event.altKey,
      shift: event.shiftKey, meta: event.metaKey, altGraph: event.getModifierState('AltGraph') }, second);
    if (!stroke || event.repeat) return;
    captured.push(stroke);
    if (second) finishRecording(true, true);
    else refreshRecording();
  });
  recorder.addEventListener('focusout', event => {
    // Hiding the launch button hands focus to the recorder in the same click.
    if (event.target === record) return;
    if (!(event.relatedTarget instanceof Node) || !recorder.contains(event.relatedTarget)) finishRecording(true, false);
  });

  return { element: bindings, get captured(): readonly string[] | null { return captured; },
    refresh: refreshRecording, cancel: () => finishRecording(false, true) };
}
