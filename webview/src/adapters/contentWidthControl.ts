import { createElement, Minus, Plus, RotateCcw } from 'lucide';
import { DEFAULT_EDITOR_CONTENT_WIDTH, EDITOR_CONTENT_WIDTH_MIN, EDITOR_CONTENT_WIDTH_MAX,
  EDITOR_CONTENT_WIDTH_STEP, isEditorContentWidth } from '../../../src/foundation/editorContentWidth';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { getUiStrings } from '../application/uiLanguage';
import { createTooltip } from './tooltip';

/** The same draft/commit interaction is used by both settings surfaces. */
export function createContentWidthControl(options: {
  get(): number;
  set(value: number): void;
  enabled(): boolean;
  language: UiLanguage;
  reset?: boolean;
  registerInput?: (input: HTMLInputElement) => () => void;
}) {
  let language = options.language;
  let dirty = false;
  let composing = false;
  let errorTooltip: ReturnType<typeof createTooltip> | undefined;
  const element = document.createElement('div'); element.className = 'content-width-field';
  const group = document.createElement('div'); group.className = 'content-width-control';
  const stepper = document.createElement('div'); stepper.className = 'content-width-stepper';
  const button = (icon: typeof Minus, action: string) => {
    const control = document.createElement('button'); control.type = 'button';
    control.className = 'content-width-button'; control.dataset.widthAction = action;
    control.append(createElement(icon, { width: 13, height: 13, 'aria-hidden': 'true' }));
    return control;
  };
  const decrease = button(Minus, 'decrease'), increase = button(Plus, 'increase');
  const input = document.createElement('input'); input.type = 'text'; input.inputMode = 'numeric';
  input.className = 'content-width-input'; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('role', 'spinbutton');
  input.setAttribute('aria-valuemin', String(EDITOR_CONTENT_WIDTH_MIN));
  input.setAttribute('aria-valuemax', String(EDITOR_CONTENT_WIDTH_MAX));
  const unit = document.createElement('span'); unit.className = 'content-width-unit'; unit.textContent = 'px';
  const reset = options.reset ? button(RotateCcw, 'reset') : null;
  const error = document.createElement('span'); error.className = 'content-width-error';
  error.setAttribute('role', 'status'); error.hidden = true;
  stepper.append(decrease, input, unit, increase); group.append(stepper);
  if (reset) group.append(reset);
  element.append(group, error);
  const unregister = options.registerInput?.(input);
  const readDraft = () => /^\d+$/.test(input.value.trim()) ? Number(input.value.trim()) : NaN;
  function clearError() {
    input.removeAttribute('aria-invalid'); input.removeAttribute('aria-description'); error.hidden = true;
    errorTooltip?.dispose(); errorTooltip = undefined;
  }
  function showError() {
    if (error.hidden || !options.enabled()) return;
    errorTooltip ??= createTooltip(stepper, {
      focusTarget: input, content: { text: getUiStrings(language).contentMaxWidthRange, kind: 'description' },
      placement: 'top', manual: true, immediate: true
    });
    errorTooltip.show();
  }
  function present(nextLanguage = language) {
    language = nextLanguage;
    const strings = getUiStrings(language), enabled = options.enabled(), value = options.get();
    input.setAttribute('aria-label', strings.contentMaxWidthLabel);
    decrease.setAttribute('aria-label', language === 'zh-CN' ? '宽度减少100像素' : 'Decrease width by 100 pixels');
    increase.setAttribute('aria-label', language === 'zh-CN' ? '宽度增加100像素' : 'Increase width by 100 pixels');
    reset?.setAttribute('aria-label', language === 'zh-CN' ? '恢复默认宽度800像素' : 'Reset width to 800 pixels');
    error.textContent = strings.contentMaxWidthRange;
    errorTooltip?.setContent({ text: strings.contentMaxWidthRange, kind: 'description' });
    if (!error.hidden) input.setAttribute('aria-description', strings.contentMaxWidthRange);
    if (!dirty || !enabled) { input.value = String(value); dirty = false; clearError(); }
    input.disabled = !enabled;
    input.setAttribute('aria-valuenow', String(value));
    const draft = readDraft(), boundary = dirty && isEditorContentWidth(draft) ? draft : value;
    decrease.disabled = !enabled || boundary <= EDITOR_CONTENT_WIDTH_MIN;
    increase.disabled = !enabled || boundary >= EDITOR_CONTENT_WIDTH_MAX;
    if (reset) reset.disabled = !enabled || !dirty && value === DEFAULT_EDITOR_CONTENT_WIDTH;
  }
  function commit(delta = 0): boolean {
    if (!options.enabled() || composing) return false;
    const value = readDraft();
    if (!isEditorContentWidth(value)) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-description', getUiStrings(language).contentMaxWidthRange);
      error.hidden = false;
      if (document.activeElement === input || stepper.matches(':hover')) showError();
      return false;
    }
    const next = Math.max(EDITOR_CONTENT_WIDTH_MIN, Math.min(EDITOR_CONTENT_WIDTH_MAX, value + delta));
    dirty = false; clearError();
    if (next !== options.get()) options.set(next);
    present(); return true;
  }
  input.addEventListener('input', () => { dirty = true; clearError(); present(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('blur', () => { commit(); errorTooltip?.hide(); });
  input.addEventListener('focus', showError);
  stepper.addEventListener('mouseenter', showError);
  stepper.addEventListener('mouseleave', () => { if (document.activeElement !== input) errorTooltip?.hide(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation(); commit(event.key === 'ArrowUp' ? EDITOR_CONTENT_WIDTH_STEP : -EDITOR_CONTENT_WIDTH_STEP);
    }
  });
  // Keep a pointer press from blurring the draft before its single step/reset.
  for (const control of [decrease, increase, ...(reset ? [reset] : [])]) {
    control.addEventListener('pointerdown', event => { if (event.button === 0 && document.activeElement === input) event.preventDefault(); });
  }
  decrease.addEventListener('click', () => { commit(-EDITOR_CONTENT_WIDTH_STEP); });
  increase.addEventListener('click', () => { commit(EDITOR_CONTENT_WIDTH_STEP); });
  reset?.addEventListener('click', () => { dirty = false; clearError(); options.set(DEFAULT_EDITOR_CONTENT_WIDTH); present(); });
  present();
  return { element, input, present, dispose() { clearError(); unregister?.(); } };
}
