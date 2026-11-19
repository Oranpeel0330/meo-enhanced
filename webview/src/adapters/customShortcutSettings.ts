import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, createElement as icon, Info, Plus, Search, Trash2, TriangleAlert, X } from 'lucide';
import {
  canBindCommand, customShortcutActionAvailableAt, customShortcutActionFitsScope,
  customShortcutConflicts, customShortcutStepOutOfOrder, shortcutReplacements, type CustomShortcutConflict, type ShortcutPlatform
} from '../../../src/application/editingPreferences';
import {
  customShortcutScopes, isCustomShortcut, shortcutTargetModes,
  type CustomShortcut, type CustomShortcutAction, type EditingPreferences, type EditingPreferencesChange
} from '../../../src/foundation/editingPreferences';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import type { EditingPreferencesUpdateResult } from '../../../src/protocol/editingPreferences';
import {
  commandTitle, commandTitles, customShortcutActionTitle, customShortcutActionTitles, customShortcutScopeTitles, customShortcutTitle,
  normalizeSettingsSearch, sectionTitles, settingsSearchMatches, settingsText, shortcutSearchKeywords, shortcutSections, shortcutTargetModeLabels
} from '../application/settingsCatalog';
import { createRequestPrefix } from './requestIdentity';
import { createSegmentedControl } from './segmentedControl';
import { createTooltip } from './tooltip';
import { button, element, iconButton } from './customShortcutControls';
import { filterCustomShortcuts, renderCustomShortcutList } from './customShortcutList';
import { createCustomShortcutRecorder } from './customShortcutRecorder';

const scopeDescriptions = {
  global: ['Live、Source 和 Preview 中都可触发。设置、搜索等输入框里不会触发。',
    'Works in Live, Source, and Preview. Excludes Settings, Search, and other input fields.'],
  editor: ['在 Live 和 Source 的编辑区触发，包含普通内容和表格单元格。',
    'Works in both Live and Source, including prose and table cells.'],
  live: ['在 Live 的编辑区触发，包含普通内容和表格单元格。',
    'Works in Live, including prose and table cells.'],
  source: ['在 Source 的编辑区触发，包含普通内容和表格单元格。',
    'Works in Source, including prose and table cells.'],
} as const satisfies Record<CustomShortcut['scope'], readonly [string, string]>;
const actionChoices = [
  { action: { type: 'snippet', template: '' } as const, labels: customShortcutActionTitles.snippet, keywords: ['Markdown 模板', 'Markdown template'] },
  { action: { type: 'mode', mode: 'source' } as const, labels: customShortcutActionTitles.mode, keywords: ['Live Source Preview 模式', 'Live Source Preview mode'] },
  ...Object.entries(shortcutSections).flatMap(([section, commands]) => commands.filter(canBindCommand).map(command => ({
    action: { type: 'command', command } as const,
    labels: commandTitles[command],
    keywords: [...sectionTitles[section as keyof typeof sectionTitles], ...shortcutSearchKeywords[command]]
  })))
];
const snippetTokens = [
  ['当前日期', 'Current date', '${CURRENT_YEAR}-${CURRENT_MONTH}-${CURRENT_DATE}'],
  ['当前时间', 'Current time', '${CURRENT_HOUR}:${CURRENT_MINUTE}:${CURRENT_SECOND}'],
  ['文件名', 'File name', '${TM_FILENAME}'],
  ['文件名（无扩展名）', 'File name without extension', '${TM_FILENAME_BASE}'],
  ['选中文字', 'Selected text', '${TM_SELECTED_TEXT}'],
  ['占位符', 'Tab stop', '${1:内容}'],
  ['最终光标', 'Final cursor', '$0']
] as const;

function field(name: string, control: HTMLElement) {
  const label = element('label', 'settings-shortcut-field');
  label.append(element('span', 'settings-item-title', name), control);
  return label;
}

function chevron() {
  return icon(ChevronDown, { class: 'settings-shortcut-chevron', width: 14, height: 14, 'aria-hidden': 'true' });
}

type EditorSession = {
  draft: CustomShortcut;
  readonly original: CustomShortcut | undefined;
  saving: boolean;
  error: string | undefined;
  conflictsChanged: boolean;
};

export function createCustomShortcutSettings(options: {
  owner: HTMLDialogElement;
  platform: ShortcutPlatform;
  preferences: () => EditingPreferences;
  save: (change: EditingPreferencesChange, key: string) => Promise<EditingPreferencesUpdateResult>;
  refresh: () => void;
  focusSearch: () => void;
  setEditing: (editing: boolean) => void;
}) {
  let session: EditorSession | null = null;
  let editorLanguage: UiLanguage | undefined;
  let refreshEditor: (() => void) | undefined;
  let dismissEditorLayer: (() => boolean) | undefined;
  let disposeEditorLayer: (() => void) | undefined;
  let armedRemoval: { control: HTMLButtonElement; reset: () => void; timer: number } | null = null;
  let pendingRemoval: { id: string } | null = null;
  let failedRemoval: string | null = null;
  const stepTooltips: ReturnType<typeof createTooltip>[] = [];
  const editor = element('div', 'settings-shortcut-page');
  editor.hidden = true;
  options.owner.append(editor);

  function focusList(id?: string) {
    const target = (id ? options.owner.querySelector<HTMLButtonElement>('[data-custom-shortcut-edit="' + id + '"]') : null)
      ?? options.owner.querySelector<HTMLButtonElement>('[data-add-custom-shortcut]');
    if (target) target.focus({ preventScroll: true });
    else options.focusSearch();
  }

  function closeEditor(restoreFocus: boolean) {
    const current = session;
    if (!current) return;
    session = null;
    refreshEditor = dismissEditorLayer = undefined;
    disposeEditorLayer?.();
    disposeEditorLayer = undefined;
    editorLanguage = undefined;
    clearRemovalConfirmation();
    clearStepTooltips();
    editor.hidden = true;
    editor.replaceChildren();
    options.setEditing(false);
    if (restoreFocus) focusList(current.draft.id);
  }

  function clearStepTooltips() {
    for (const tooltip of stepTooltips.splice(0)) tooltip.dispose();
  }

  function clearRemovalConfirmation() {
    if (!armedRemoval) return false;
    const armed = armedRemoval;
    armedRemoval = null;
    window.clearTimeout(armed.timer);
    armed.reset();
    return true;
  }

  function deleteButton(
    label: string,
    confirmLabel: string,
    onConfirm: () => void,
    hint = label
  ) {
    const control = button('', () => {
      if (armedRemoval?.control === control) {
        clearRemovalConfirmation();
        onConfirm();
        return;
      }
      clearRemovalConfirmation();
      present(true);
      armedRemoval = { control, reset: () => present(false), timer: window.setTimeout(clearRemovalConfirmation, 3000) };
    }, 'settings-close settings-shortcut-icon');
    function present(armed: boolean) {
      control.classList.toggle('is-delete-armed', armed);
      control.replaceChildren(icon(armed ? Check : Trash2, { width: 16, height: 16, 'aria-hidden': 'true',
        ...(armed ? { 'stroke-width': 2.5 } : {}) }));
      control.setAttribute('aria-label', armed ? confirmLabel : label);
      control.dataset.tooltip = armed ? confirmLabel : hint;
    }
    control.dataset.tooltipLiveUpdate = 'true';
    control.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.repeat) event.preventDefault();
      if (event.key === 'Escape' && armedRemoval?.control === control) {
        event.preventDefault();
        clearRemovalConfirmation();
      }
    });
    control.addEventListener('blur', () => { if (armedRemoval?.control === control) clearRemovalConfirmation(); });
    present(false);
    return control;
  }

  async function removeRule(id: string) {
    if (pendingRemoval) return;
    const request = { id };
    pendingRemoval = request;
    failedRemoval = null;
    const result = await options.save({ type: 'deleteCustomShortcut', id }, id);
    if (pendingRemoval !== request) return;
    pendingRemoval = null;
    failedRemoval = result.ok ? null : id;
    options.refresh();
    if (result.ok) focusList();
    else options.owner.querySelector<HTMLButtonElement>('[data-custom-shortcut-remove="' + id + '"]')?.focus({ preventScroll: true });
  }

  function openEditor(language: UiLanguage, rule?: CustomShortcut) {
    clearRemovalConfirmation();
    const draft = rule ?? { id: createRequestPrefix(), name: '', scope: 'editor', strokes: [], actions: [] };
    session = { draft, original: rule, saving: false, error: undefined, conflictsChanged: false };
    renderEditor(session, language);
    editor.hidden = false;
    options.setEditing(true);
    editor.querySelector<HTMLInputElement>('[name="name"]')?.focus();
  }

  function renderEditor(current: EditorSession, language: UiLanguage) {
    const hadFocus = editor.contains(document.activeElement);
    disposeEditorLayer?.();
    editorLanguage = language;
    const t = (zh: string, en: string) => settingsText(language, zh, en);
    const orderWarning = t('必须最后执行', 'Must run last');
    const actionLabel = (action: CustomShortcutAction) => customShortcutActionTitle(action, language);
    function stepLocationNote(action: CustomShortcutAction, scope: CustomShortcut['scope'], includePreviewLimit = true): string {
      if (!customShortcutActionFitsScope(action, scope)) return t('在此范围内跳过', 'Skipped in this scope');
      if (!customShortcutActionAvailableAt(action, 'prose')) return t('仅在单元格内执行', 'Only in table cells');
      const editingAreaOnly = includePreviewLimit && scope === 'global' && !customShortcutActionAvailableAt(action, 'outsideEditor');
      if (!customShortcutActionAvailableAt(action, 'table')) return editingAreaOnly
        ? t('仅在正文编辑区执行', 'Only in editor prose') : t('仅在表格外执行', 'Only outside tables');
      return editingAreaOnly ? t('仅在编辑区执行', 'Editor only') : '';
    }
    const form = element('form', 'settings-custom-shortcut-form');
    const header = element('header', 'settings-shortcut-page-header');
    const title = element('h2', 'settings-section-title', current.original ? t('编辑自定义动作', 'Edit custom action') : t('新建自定义动作', 'New custom action'));
    title.id = 'meo-shortcut-editor-title';
    const back = iconButton(ArrowLeft, t('返回自定义动作', 'Back to custom actions'), () => closeEditor(true));
    header.append(back, title);
    const body = element('div', 'settings-shortcut-page-body');
    const fields = element('div', 'settings-shortcut-page-fields');
    const basics = element('div', 'settings-shortcut-basics');
    const name = element('input', 'settings-shortcut-field-input');
    name.name = 'name';
    name.maxLength = 100;
    name.value = customShortcutTitle(current.draft, language);
    name.placeholder = t('例如，插入会议纪要', 'e.g. Insert meeting notes');
    let closeMenu: ((restoreFocus: boolean) => void) | undefined;

    function showMenu(panel: HTMLElement, trigger: HTMLButtonElement, align: 'match' | 'start' | 'end', onClose: () => void) {
      closeMenu?.(false);
      const events = new AbortController();
      const { signal } = events;
      const close = (restoreFocus: boolean) => {
        events.abort();
        closeMenu = undefined;
        trigger.setAttribute('aria-expanded', 'false');
        panel.hidden = true;
        onClose();
        if (restoreFocus) trigger.focus({ preventScroll: true });
      };
      closeMenu = close;
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');

      const place = () => {
        const bounds = body.getBoundingClientRect();
        const target = trigger.getBoundingClientRect();
        if (!trigger.isConnected || target.bottom <= bounds.top || target.top >= bounds.bottom) { close(false); return; }
        const margin = 8, gap = 4;
        const width = Math.min(align === 'match' ? target.width : 320, bounds.width - 2 * margin);
        const left = align === 'end' ? target.right - width : target.left;
        const below = Math.max(0, bounds.bottom - margin - target.bottom - gap);
        const above = Math.max(0, target.top - gap - bounds.top - margin);
        panel.style.width = width + 'px';
        panel.style.left = Math.max(bounds.left + margin, Math.min(left, bounds.right - margin - width)) + 'px';
        panel.style.maxHeight = '';
        const openAbove = panel.offsetHeight > below && above > below;
        panel.style.maxHeight = (openAbove ? above : below) + 'px';
        panel.style.top = openAbove ? '' : target.bottom + gap + 'px';
        panel.style.bottom = openAbove ? innerHeight - target.top + gap + 'px' : '';
      };
      place();
      const dismissOutside = (event: Event) => {
        if (event.target instanceof Node && !trigger.contains(event.target) && !panel.contains(event.target)) close(false);
      };
      document.addEventListener('pointerdown', dismissOutside, { capture: true, signal });
      document.addEventListener('focusin', dismissOutside, { signal });
      window.addEventListener('resize', place, { signal });
      window.addEventListener('blur', () => close(false), { signal });
      body.addEventListener('scroll', place, { passive: true, signal });
    }

    const scopeTitle = t('生效范围', 'Scope');
    const scopeMenu = element('div', 'preview-dropdown-panel settings-shortcut-scope-menu');
    scopeMenu.id = 'meo-shortcut-scope-menu';
    scopeMenu.hidden = true;
    scopeMenu.setAttribute('role', 'listbox');
    scopeMenu.setAttribute('aria-label', scopeTitle);
    const scopeCaption = element('span', 'settings-shortcut-scope-caption');
    scopeCaption.id = 'meo-shortcut-scope-caption';
    const scope = button('', () => {
      if (scopeMenu.hidden) openScope();
      else closeMenu?.(true);
    }, 'settings-shortcut-field-input settings-shortcut-scope');
    scope.id = 'meo-shortcut-scope';
    scope.dataset.shortcutScope = '';
    scope.setAttribute('aria-haspopup', 'listbox');
    scope.setAttribute('aria-expanded', 'false');
    scope.setAttribute('aria-controls', scopeMenu.id);
    scope.setAttribute('aria-labelledby', 'meo-shortcut-scope-label ' + scopeCaption.id);
    scope.append(scopeCaption, chevron());
    const scopeOptions = customShortcutScopes.map(value => {
      const [zh, en] = customShortcutScopeTitles[value];
      const [descriptionZh, descriptionEn] = scopeDescriptions[value];
      const control = button(t(zh, en), () => {
        revise({ scope: value });
        closeMenu?.(true);
        renderActions();
      }, 'preview-dropdown-option');
      control.tabIndex = -1;
      control.dataset.shortcutScopeOption = value;
      control.setAttribute('role', 'option');
      scopeMenu.append(control);
      return { value, control, description: t(descriptionZh, descriptionEn), hint: undefined as ReturnType<typeof createTooltip> | undefined };
    });
    function openScope() {
      showMenu(scopeMenu, scope, 'match', () => { for (const { hint } of scopeOptions) hint?.hide(); });
      scopeOptions.find(({ value }) => value === current.draft.scope)?.control.focus();
    }
    scope.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      if (scopeMenu.hidden) openScope();
    });
    scopeMenu.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        closeMenu?.(true);
        return;
      }
      const index = scopeOptions.findIndex(({ control }) => control === document.activeElement);
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, scopeOptions.length - 1)
        : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
          : event.key === 'Home' ? 0 : event.key === 'End' ? scopeOptions.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      scopeOptions[next]?.control.focus();
    });

    function revise(change: Partial<CustomShortcut>) {
      current.draft = { ...current.draft, ...change };
      current.error = undefined;
      current.conflictsChanged = false;
      validate();
    }

    name.addEventListener('input', () => revise({ name: name.value, useDefaultName: undefined }));
    const scopeField = field(scopeTitle, scope);
    scopeField.firstElementChild!.id = 'meo-shortcut-scope-label';
    basics.append(field(t('名称', 'Name'), name), scopeField);

    const keyRecorder = createCustomShortcutRecorder({
      language, strokes: () => current.draft.strokes,
      onRecord: strokes => revise({ strokes }), onChange: validate
    });

    const actionsSection = element('section', 'settings-shortcut-edit-section');
    const actionsHeading = element('div', 'settings-shortcut-section-heading');
    const actions = element('ol', 'settings-shortcut-actions-list');
    const emptySteps = element('p', 'settings-description settings-shortcut-empty-actions',
      t('选择编辑器命令、插入 Markdown 片段，或切换模式。', 'Choose an editor command, insert a Markdown snippet, or switch modes.'));
    const picker = element('div', 'preview-dropdown-panel settings-shortcut-picker');
    picker.id = 'meo-shortcut-step-picker';
    picker.hidden = true;
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', t('选择步骤', 'Choose a step'));
    let pickingIndex: number | null = null;
    const pickerSearch = element('input', 'settings-shortcut-picker-input');
    pickerSearch.type = 'search';
    pickerSearch.placeholder = t('搜索步骤', 'Search steps');
    pickerSearch.setAttribute('aria-label', pickerSearch.placeholder);
    const searchBox = element('div', 'settings-shortcut-picker-search');
    const pickerResults = element('div', 'settings-shortcut-picker-results');
    const pickerClear = button('', () => {
      pickerSearch.value = '';
      renderChoices();
      pickerSearch.focus();
    }, 'settings-shortcut-picker-clear');
    pickerClear.setAttribute('aria-label', t('清除步骤搜索', 'Clear step search'));
    pickerClear.append(icon(X, { width: 12, height: 12, 'stroke-width': 1.5, 'aria-hidden': 'true' }));
    searchBox.append(icon(Search, { width: 13, height: 13, 'aria-hidden': 'true' }), pickerSearch, pickerClear);
    picker.append(searchBox, pickerResults);
    const add = button(t('添加步骤', 'Add step'), () => openPicker(current.draft.actions.length));
    add.dataset.shortcutAddAction = '';
    add.setAttribute('aria-controls', picker.id);
    add.setAttribute('aria-expanded', 'false');
    add.prepend(icon(Plus, { width: 14, height: 14, 'aria-hidden': 'true' }));
    actionsHeading.append(element('h3', 'settings-shortcut-edit-label', t('步骤', 'Steps')), add);
    actionsSection.append(actionsHeading, emptySteps, actions);

    function stepTrigger(index: number) {
      return actions.querySelector<HTMLButtonElement>('[data-shortcut-action="' + index + '"]') ?? add;
    }

    function openPicker(index: number) {
      if (pickingIndex === index) {
        closeMenu?.(true);
        return;
      }
      const trigger = stepTrigger(index);
      pickerSearch.value = '';
      renderChoices();
      showMenu(picker, trigger, trigger === add ? 'end' : 'start', () => { pickingIndex = null; });
      if (!picker.hidden) {
        pickingIndex = index;
        pickerSearch.focus({ preventScroll: true });
      }
    }

    function renderChoices() {
      const query = normalizeSettingsSearch(pickerSearch.value);
      pickerClear.hidden = !pickerSearch.value;
      const choices = actionChoices.filter(choice => settingsSearchMatches(query, ...choice.labels, ...choice.keywords));
      pickerResults.replaceChildren(...choices.map(choice => {
        const [zh, en] = choice.labels;
        const disabled = !customShortcutActionFitsScope(choice.action, current.draft.scope);
        const option = button('', () => {
          if (disabled || pickingIndex === null) return;
          const index = pickingIndex;
          const updated = [...current.draft.actions];
          const previous = updated[index];
          const next = choice.action;
          updated[index] = previous && previous.type === next.type && next.type !== 'command' ? previous : next;
          closeMenu?.(false);
          revise({ actions: updated });
          renderActions();
          const input = actions.querySelector<HTMLElement>('[data-shortcut-action-details="' + index + '"] :is(textarea, [aria-pressed="true"])');
          if (input) input.focus();
          else stepTrigger(index).focus();
        }, 'preview-dropdown-option');
        option.dataset.shortcutChoice = choice.action.type === 'command' ? choice.action.command : choice.action.type;
        if (disabled) option.setAttribute('aria-disabled', 'true');
        option.append(element('span', 'settings-shortcut-picker-name', t(zh, en)));
        const restriction = stepLocationNote(choice.action, current.draft.scope, false);
        if (restriction) {
          const note = element('span', 'settings-shortcut-picker-restriction', restriction);
          note.dataset.tooltip = restriction;
          note.dataset.tooltipKind = 'fulltext';
          option.append(note);
        }
        return option;
      }));
      if (!choices.length) pickerResults.append(element('p', 'settings-description settings-shortcut-picker-empty', t('没有匹配的步骤', 'No matching steps')));
      pickerResults.scrollTop = 0;
    }
    pickerSearch.addEventListener('input', renderChoices);
    picker.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu?.(true);
        return;
      }
      const choices = [...pickerResults.querySelectorAll<HTMLButtonElement>('button')];
      const index = choices.findIndex(choice => choice === document.activeElement);
      if (event.key === 'Enter' && event.target === pickerSearch) {
        event.preventDefault();
        choices.find(choice => !choice.hasAttribute('aria-disabled'))?.click();
      } else if (['ArrowDown', 'ArrowUp'].includes(event.key) && (event.target === pickerSearch || index !== -1)) {
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? choices[index + 1] : choices[index === -1 ? choices.length - 1 : index - 1];
        (next ?? pickerSearch).focus();
      }
    });

    function setAction(index: number, action: CustomShortcutAction) {
      revise({ actions: current.draft.actions.map((value, at) => index === at ? action : value) });
    }

    const updateStepNotes: Array<(location: string, outOfOrder: boolean) => void> = [];
    function renderActions() {
      clearRemovalConfirmation();
      clearStepTooltips();
      updateStepNotes.length = 0;
      const items = current.draft.actions.map((action, index) => {
        const group = element('li', 'settings-shortcut-action');
        const number = element('span', 'settings-shortcut-step-number', String(index + 1));
        number.setAttribute('aria-hidden', 'true');
        const content = element('div', 'settings-shortcut-step-content');
        const row = element('div', 'settings-shortcut-action-heading');
        const summary = element('div', 'settings-shortcut-step-summary');
        const label = button('', () => openPicker(index), 'settings-button settings-subtle settings-shortcut-action-name');
        const caption = element('span', 'settings-shortcut-step-caption', actionLabel(action));
        label.append(caption, chevron());
        const notes = element('div', 'settings-shortcut-step-notes');
        summary.append(label, notes);
        updateStepNotes.push((location, outOfOrder) => {
          const annotations = [
            { kind: 'location', text: location, graphic: Info },
            { kind: 'warning', text: outOfOrder ? orderWarning : '', graphic: TriangleAlert }
          ];
          for (const { kind, text, graphic } of annotations) {
            const id = `meo-shortcut-step-${kind}-${index}`;
            const existing = notes.querySelector<HTMLElement>('#' + id);
            if (existing?.textContent === text) continue;
            existing?.remove();
            if (!text) continue;
            const note = element('span', `settings-shortcut-step-note settings-shortcut-step-${kind}`);
            note.id = id;
            note.dataset.tooltip = text;
            note.dataset.tooltipKind = 'fulltext';
            note.append(icon(graphic, { width: 14, height: 14, 'aria-hidden': 'true' }), text);
            if (kind === 'location') notes.prepend(note); else notes.append(note);
          }
          notes.hidden = notes.childElementCount === 0;
          if (notes.hidden) label.removeAttribute('aria-describedby');
          else label.setAttribute('aria-describedby', Array.from(notes.children, note => note.id).join(' '));
        });
        label.dataset.shortcutAction = String(index);
        const stepName = t('更换步骤 ', 'Change step ') + (index + 1) + ' · ';
        label.setAttribute('aria-label', stepName + actionLabel(action));
        label.setAttribute('aria-controls', picker.id);
        label.setAttribute('aria-expanded', 'false');
        const tools = element('div', 'settings-shortcut-row-tools');
        for (const delta of [-1, 1]) {
          const to = index + delta;
          const move = iconButton(delta < 0 ? ArrowUp : ArrowDown, delta < 0 ? t('上移步骤', 'Move step up') : t('下移步骤', 'Move step down'), () => {
            const updated = [...current.draft.actions];
            [updated[index], updated[to]] = [updated[to], updated[index]];
            revise({ actions: updated });
            renderActions();
            stepTrigger(to).focus();
          });
          move.disabled = to < 0 || to >= current.draft.actions.length;
          if (current.draft.actions.length > 1) tools.append(move);
        }
        const remove = deleteButton(t('移除步骤', 'Remove step'), t('确认移除', 'Confirm removal'), () => {
          revise({ actions: current.draft.actions.filter((_, at) => at !== index) });
          renderActions();
          stepTrigger(Math.min(index, current.draft.actions.length - 1)).focus();
        });
        remove.dataset.shortcutActionRemove = String(index);
        tools.append(remove);
        row.append(summary, tools);
        content.append(row);
        const details = element('div', 'settings-shortcut-action-details');
        details.dataset.shortcutActionDetails = String(index);
        if (action.type === 'snippet') {
          const input = element('textarea', 'settings-shortcut-field-input');
          input.name = 'template';
          input.rows = 3;
          input.maxLength = 20_000;
          input.setAttribute('spellcheck', 'false');
          input.value = action.template;
          input.placeholder = t('输入 Markdown 片段', 'Enter a Markdown snippet');
          input.addEventListener('input', () => setAction(index, { type: 'snippet', template: input.value }));
          const choices = element('div', 'image-location-variables settings-shortcut-tokens');
          for (const [zh, en, placeholder] of snippetTokens) {
            const value = placeholder === '${1:内容}' ? t('${1:内容}', '${1:Text}') : placeholder;
            const insert = button(t(zh, en), () => {
              if (input.value.length - input.selectionEnd + input.selectionStart + value.length > input.maxLength) return;
              input.setRangeText(value, input.selectionStart, input.selectionEnd, 'end');
              setAction(index, { type: 'snippet', template: input.value });
              input.focus();
            }, 'settings-button image-location-token');
            stepTooltips.push(createTooltip(insert, { content: { text: value } }));
            insert.dataset.shortcutToken = placeholder;
            choices.append(insert);
          }
          const tokenLabel = element('p', 'settings-description', t('插入变量或占位符', 'Insert variable or tab stop'));
          details.append(field(t('Markdown 片段', 'Markdown snippet'), input), tokenLabel, choices);
        } else if (action.type === 'mode') {
          const modeLabel = t('目标模式', 'Target mode');
          const mode = createSegmentedControl({
            ariaLabel: modeLabel,
            className: 'settings-segmented settings-shortcut-mode',
            buttonClassName: 'settings-choice-button',
            datasetKey: 'shortcutMode',
            role: 'group',
            options: shortcutTargetModes.map(value => ({ value, label: shortcutTargetModeLabels[value] })),
          });
          mode.setActive(action.mode);
          for (const target of shortcutTargetModes) {
            mode.getButton(target).addEventListener('click', () => {
              mode.setActive(target);
              setAction(index, { type: 'mode', mode: target });
              caption.textContent = actionLabel({ type: 'mode', mode: target });
              label.setAttribute('aria-label', stepName + caption.textContent);
            });
          }
          details.append(element('span', 'settings-item-title', modeLabel), mode.element);
        }
        if (details.childElementCount) content.append(details);
        group.append(number, content);
        return group;
      });
      actions.replaceChildren(...items);
      emptySteps.hidden = items.length > 0;
      validate();
    }

    const footer = element('footer', 'settings-footer settings-shortcut-page-footer');
    const footerNotes = element('div', 'settings-shortcut-footer-notes');
    footerNotes.setAttribute('role', 'status');
    const skipHint = element('p', 'settings-shortcut-footer-note settings-shortcut-skip-hint');
    skipHint.append(icon(Info, { width: 14, height: 14, 'aria-hidden': 'true' }),
      element('span', '', t('执行时会自动跳过不适用的步骤', 'Automatically skips steps that don’t apply')));
    const feedback = element('p', 'settings-shortcut-footer-note settings-shortcut-feedback');
    const feedbackText = element('span', '');
    feedback.append(icon(TriangleAlert, { width: 14, height: 14, 'aria-hidden': 'true' }), feedbackText);
    footerNotes.append(skipHint, feedback);
    const buttons = element('div', 'settings-actions');
    const cancel = button(t('取消', 'Cancel'), () => closeEditor(true));
    const submit = button(t('保存', 'Save'), () => { void commit(); }, 'settings-button settings-primary');
    submit.dataset.shortcutSave = '';
    buttons.append(cancel, submit);
    footer.append(footerNotes, buttons);
    fields.append(basics, keyRecorder.element, actionsSection);
    body.append(fields);
    form.append(header, body, footer, scopeMenu, picker);

    let shownConflicts: readonly CustomShortcutConflict[] = [];
    function validate() {
      const draft = current.draft;
      const captured = keyRecorder.captured;
      const stepNotes = draft.actions.map((action, index) => ({
        location: stepLocationNote(action, draft.scope),
        outOfOrder: customShortcutStepOutOfOrder(draft, index)
      }));
      stepNotes.forEach(({ location, outOfOrder }, index) => updateStepNotes[index]?.(location, outOfOrder));
      const conflicts = customShortcutConflicts({ ...draft, strokes: captured?.length ? captured : draft.strokes }, options.preferences(), options.platform);
      shownConflicts = conflicts;
      const fixed = conflicts.some(conflict => conflict.fixed);
      const invalidScope = draft.actions.length > 0 && !draft.actions.some(action => customShortcutActionFitsScope(action, draft.scope));
      const invalidOrder = stepNotes.some(note => note.outOfOrder);
      const names = conflicts.map(conflict => conflict.type === 'command'
        ? commandTitle(conflict.command, language) : customShortcutTitle(conflict, language)).join(t('、', ', '));
      const replacement = t(`将替换「${names}」的键位`, `Will replace keybindings for ${names}`);
      const problem = current.error ? t('保存失败。请重试。', 'Could not save. Try again.')
        : invalidScope ? t('当前范围没有可执行的步骤。', 'No steps can run in this scope.')
          : invalidOrder ? t('调整相关警告后可保存', 'Resolve the warnings to save')
            : fixed ? t('此按键由系统命令保留：', 'Reserved keybinding: ') + names
              : current.conflictsChanged ? t('键位冲突已变化，请重新确认', 'Keybinding conflicts changed. Please confirm again')
                + (conflicts.length ? t('。', '. ') + replacement : '')
                : conflicts.length ? replacement : '';
      skipHint.hidden = invalidScope || !stepNotes.some(note => note.location);
      if (feedbackText.textContent !== problem) feedbackText.textContent = problem;
      feedback.classList.toggle('is-error', Boolean(current.error));
      if (current.error) {
        feedback.dataset.tooltip = current.error;
        feedback.tabIndex = 0;
      } else {
        delete feedback.dataset.tooltip;
        feedback.removeAttribute('tabindex');
      }
      feedback.hidden = !problem;
      submit.textContent = current.saving ? t('保存中…', 'Saving…')
        : conflicts.length && !fixed ? t('替换并保存', 'Replace and save') : t('保存', 'Save');
      submit.classList.toggle('settings-primary', !conflicts.length || fixed);
      submit.classList.toggle('settings-warning', !!conflicts.length && !fixed);
      submit.disabled = current.saving || captured !== null || invalidScope || invalidOrder || fixed || !isCustomShortcut(draft);
      back.disabled = cancel.disabled = current.saving;
      body.inert = current.saving;
      add.disabled = draft.actions.length >= 12;
      const [scopeZh, scopeEn] = customShortcutScopeTitles[draft.scope];
      scopeCaption.textContent = t(scopeZh, scopeEn);
      const unavailableInPreview = draft.actions.length > 0 && !draft.actions.some(action => customShortcutActionAvailableAt(action, 'outsideEditor'));
      for (const { value, control, description, hint } of scopeOptions) {
        control.setAttribute('aria-selected', String(value === draft.scope));
        hint?.setContent(value === 'global' && unavailableInPreview
          ? { text: t('这个动作在预览中没有可执行的步骤。', 'No steps in this action run in Preview.'), detail: description, kind: 'description' }
          : { text: description, kind: 'description' });
      }
    }

    form.addEventListener('submit', event => event.preventDefault());
    async function commit() {
      if (submit.disabled) return;
      const confirmedReplacements = shortcutReplacements(shownConflicts);
      current.saving = true;
      current.error = undefined;
      current.conflictsChanged = false;
      validate();
      const result = await options.save({ type: 'saveCustomShortcut', shortcut: current.draft, confirmedReplacements }, current.draft.id);
      if (session !== current) return;
      current.saving = false;
      if (result.ok) closeEditor(true);
      else {
        current.conflictsChanged = result.error.code === 'shortcut-conflicts-changed';
        if (!current.conflictsChanged) current.error = result.error.message;
        refreshEditor?.();
        editor.querySelector<HTMLButtonElement>('[data-shortcut-save]')?.focus();
      }
    }
    refreshEditor = validate;
    dismissEditorLayer = () => {
      if (keyRecorder.cancel()) return true;
      if (!closeMenu) return false;
      closeMenu(true);
      return true;
    };
    disposeEditorLayer = () => {
      closeMenu?.(false);
      for (const { hint } of scopeOptions) hint?.dispose();
    };
    editor.replaceChildren(form);
    for (const option of scopeOptions) {
      option.hint = createTooltip(option.control, { placement: 'left', sideAlign: 'start', immediate: true,
        content: { text: option.description, kind: 'description' } });
    }
    renderActions();
    keyRecorder.refresh();
    if (hadFocus) name.focus({ preventScroll: true });
  }

  return {
    close() {
      clearRemovalConfirmation();
      pendingRemoval = null;
      failedRemoval = null;
      closeEditor(false);
    },
    dismiss() {
      if (clearRemovalConfirmation()) return true;
      if (!session) return false;
      if (!session.saving && !dismissEditorLayer?.()) closeEditor(true);
      return true;
    },
    presentEditor(language: UiLanguage) {
      if (session && editorLanguage !== language) renderEditor(session, language);
      else refreshEditor?.();
    },
    count(query: string) { return filterCustomShortcuts(options.preferences().customShortcuts ?? [], query).length; },
    render(language: UiLanguage, query: string) {
      clearRemovalConfirmation();
      const t = (zh: string, en: string) => settingsText(language, zh, en);
      return renderCustomShortcutList({
        rules: options.preferences().customShortcuts ?? [], language, query, open: rule => openEditor(language, rule),
        createRemovalButton(rule) {
          const label = t('删除', 'Delete');
          const hint = pendingRemoval?.id === rule.id ? t('删除中…', 'Deleting…')
            : failedRemoval === rule.id ? t('删除失败。请重试。', 'Could not delete. Try again.') : label;
          const remove = deleteButton(label, t('确认删除', 'Confirm deletion'), () => { void removeRule(rule.id); }, hint);
          remove.disabled = pendingRemoval !== null;
          remove.dataset.customShortcutRemove = rule.id;
          return remove;
        }
      });
    }
  };
}
