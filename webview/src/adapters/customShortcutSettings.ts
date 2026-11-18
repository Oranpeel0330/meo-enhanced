import {
  canBindCommand, customShortcutActionCanContinue, customShortcutActionFitsScope,
  customShortcutConflicts, shortcutFromStroke, type ShortcutPlatform
} from '../../../src/application/editingPreferences';
import {
  customShortcutScopes, isCustomShortcut, isEditorCommandId, shortcutTargetModes,
  type CustomShortcut, type CustomShortcutAction, type CustomShortcutScope,
  type EditingPreferences, type EditingPreferencesChange
} from '../../../src/foundation/editingPreferences';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { createRequestPrefix } from './requestIdentity';
import {
  commandTitle, commandTitles, customShortcutActionTitles, customShortcutScopeTitles,
  customShortcutSearchKeywords, sectionTitles, settingsSearchMatches, settingsText, shortcutSections
} from '../application/settingsCatalog';

const modeLabels = { live: 'Live', source: 'Source', preview: 'Preview' };

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createButton(text: string, onClick: () => void) {
  const button = createElement('button', 'settings-button', text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function field(name: string, control: HTMLElement): HTMLLabelElement {
  const label = createElement('label', 'settings-custom-field');
  label.append(createElement('span', 'settings-item-title', name), control);
  return label;
}

export function createCustomShortcutSettings(options: {
  platform: ShortcutPlatform;
  preferences: () => EditingPreferences;
  save: (change: EditingPreferencesChange, key: string) => Promise<boolean>;
  refresh: () => void;
}) {
  let draft: CustomShortcut | null = null;
  let saving = false;
  let form: HTMLFormElement | null = null;
  let formLanguage: UiLanguage | null = null;
  let updateValidity: (() => void) | null = null;
  const keywords = [...sectionTitles.customShortcuts, ...customShortcutSearchKeywords];

  function actionLabels(action: CustomShortcutAction): readonly string[] {
    return action.type === 'command' ? commandTitles[action.command]
      : action.type === 'mode' ? [...customShortcutActionTitles.mode, modeLabels[action.mode]] : customShortcutActionTitles.snippet;
  }

  function visibleRules(query: string): readonly CustomShortcut[] {
    return (options.preferences().customShortcuts ?? []).filter(rule => settingsSearchMatches(query, ...keywords,
      rule.name, ...rule.strokes, ...customShortcutScopeTitles[rule.scope], ...rule.actions.flatMap(actionLabels)));
  }

  function closeDraft() {
    if (!draft) return false;
    const id = draft.id;
    draft = null;
    form = null;
    formLanguage = null;
    updateValidity = null;
    options.refresh();
    (document.querySelector<HTMLButtonElement>('[data-custom-shortcut-edit="' + id + '"]')
      ?? document.querySelector<HTMLButtonElement>('[data-add-custom-shortcut]'))?.focus();
    return true;
  }

  function startDraft(rule?: CustomShortcut) {
    draft = rule ?? { id: createRequestPrefix(), name: '', scope: 'editor', strokes: [], actions: [{ type: 'command', command: 'save' }] };
    form = null;
    options.refresh();
    document.querySelector<HTMLInputElement>('.settings-custom-shortcut-form input[name="name"]')?.focus();
  }

  function renderForm(language: UiLanguage): HTMLFormElement {
    if (form && formLanguage === language) { updateValidity?.(); return form; }
    const t = (zh: string, en: string) => settingsText(language, zh, en);
    const next = createElement('form', 'settings-custom-shortcut-form');
    const name = createElement('input', 'settings-custom-input');
    name.name = 'name';
    name.maxLength = 100;
    name.value = draft!.name;
    name.addEventListener('input', () => { if (draft) draft = { ...draft, name: name.value }; updateValidity?.(); });
    const scope = createElement('select', 'settings-custom-input');
    for (const value of customShortcutScopes) {
      const [zh, en] = customShortcutScopeTitles[value];
      scope.add(new Option(t(zh, en), value));
    }
    scope.value = draft!.scope;
    scope.addEventListener('change', () => { if (draft) draft = { ...draft, scope: scope.value as CustomShortcutScope }; updateValidity?.(); });

    const strokes = createElement('div', 'settings-custom-strokes');
    const first = createElement('input', 'settings-recorder');
    const second = createElement('input', 'settings-recorder');
    function record(input: HTMLInputElement, index: 0 | 1) {
      input.readOnly = true;
      input.value = draft!.strokes[index] ?? '';
      input.placeholder = t('按下快捷键', 'Press a shortcut');
      input.addEventListener('keydown', event => {
        if (event.key === 'Tab' || event.isComposing
          || event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return;
        event.stopPropagation();
        event.preventDefault();
        if (!draft || event.repeat) return;
        const value = shortcutFromStroke({ key: event.key, code: event.code, ctrl: event.ctrlKey,
          alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, altGraph: event.getModifierState('AltGraph') }, index === 1);
        if (!value) return;
        draft = { ...draft, strokes: index === 0 ? [value, ...draft.strokes.slice(1)] : [draft.strokes[0], value] };
        input.value = value;
        updateValidity?.();
      });
    }
    record(first, 0); record(second, 1);
    strokes.append(field(t('第一组按键', 'First keystroke'), first), field(t('第二组按键（可选）', 'Second keystroke (optional)'), second),
      createButton(t('清除按键', 'Clear keys'), () => {
        if (!draft) return;
        draft = { ...draft, strokes: [] };
        first.value = second.value = '';
        first.focus();
        updateValidity?.();
      }),
      createButton(t('清除第二组', 'Clear second'), () => {
        if (!draft) return;
        draft = { ...draft, strokes: draft.strokes.slice(0, 1) };
        second.value = '';
        second.focus();
        updateValidity?.();
      }));

    const actions = createElement('div', 'settings-custom-actions');
    function setAction(index: number, action: CustomShortcutAction) {
      if (!draft) return;
      draft = { ...draft, actions: draft.actions.map((current, at) => index === at ? action : current) };
      updateValidity?.();
    }
    function renderActions() {
      actions.replaceChildren();
      for (const [index, action] of draft!.actions.entries()) {
        const group = createElement('div', 'settings-custom-action');
        const select = createElement('select', 'settings-custom-input');
        select.add(new Option(t(...customShortcutActionTitles.snippet), '$snippet'));
        select.add(new Option(t(...customShortcutActionTitles.mode), '$mode'));
        for (const [section, commands] of Object.entries(shortcutSections)) {
          const category = document.createElement('optgroup');
          const [zh, en] = sectionTitles[section as keyof typeof sectionTitles];
          category.label = t(zh, en);
          for (const command of commands.filter(canBindCommand)) category.append(new Option(commandTitle(command, language), command));
          select.append(category);
        }
        select.value = action.type === 'command' ? action.command : '$' + action.type;
        select.addEventListener('change', () => {
          const value = select.value;
          if (value === '$snippet') setAction(index, { type: 'snippet', template: '' });
          else if (value === '$mode') setAction(index, { type: 'mode', mode: 'source' });
          else if (isEditorCommandId(value)) setAction(index, { type: 'command', command: value });
          renderActions();
          actions.querySelectorAll<HTMLSelectElement>('select[name="action"]')[index]?.focus();
        });
        select.name = 'action';
        group.append(field(t('动作', 'Action'), select));
        if (action.type === 'snippet') {
          const template = createElement('textarea', 'settings-custom-input');
          template.name = 'template';
          template.rows = 4;
          template.maxLength = 20_000;
          template.value = action.template;
          template.placeholder = '## ${1:Title}\n\n$0';
          template.addEventListener('input', () => setAction(index, { type: 'snippet', template: template.value }));
          const syntax = createElement('details', 'settings-custom-syntax');
          const hint = createElement('p', 'settings-description', t(
            '可用 ${CURRENT_YEAR}、${CURRENT_MONTH}、${CURRENT_DATE}、${CURRENT_HOUR}、${CURRENT_MINUTE}、${CURRENT_SECOND}、${TM_FILENAME}、${TM_FILENAME_BASE}、${TM_SELECTED_TEXT} 和 $1、$0 占位符。',
            'Use ${CURRENT_YEAR}, ${CURRENT_MONTH}, ${CURRENT_DATE}, ${CURRENT_HOUR}, ${CURRENT_MINUTE}, ${CURRENT_SECOND}, ${TM_FILENAME}, ${TM_FILENAME_BASE}, ${TM_SELECTED_TEXT} and tab stops such as $1 and $0.'));
          syntax.append(createElement('summary', 'settings-description', t('变量和占位符', 'Variables and tab stops')), hint);
          group.append(field(t('Markdown 片段', 'Markdown snippet'), template), syntax);
        }
        if (action.type === 'mode') {
          const target = createElement('select', 'settings-custom-input');
          for (const mode of shortcutTargetModes) target.add(new Option(modeLabels[mode], mode));
          target.value = action.mode;
          target.addEventListener('change', () => {
            const mode = shortcutTargetModes.find(mode => mode === target.value);
            if (mode) setAction(index, { type: 'mode', mode });
          });
          group.append(field(t('目标模式', 'Target mode'), target));
        }
        if (draft!.actions.length > 1) {
          const controls = createElement('div', 'settings-shortcut-controls');
          if (index > 0) controls.append(createButton(t('上移', 'Move up'), () => {
            if (!draft) return;
            const ordered = [...draft.actions];
            [ordered[index - 1], ordered[index]] = [ordered[index], ordered[index - 1]];
            draft = { ...draft, actions: ordered };
            renderActions();
            actions.querySelectorAll<HTMLSelectElement>('select[name="action"]')[index - 1]?.focus();
          }));
          controls.append(createButton(t('移除动作', 'Remove action'), () => {
            if (!draft) return;
            draft = { ...draft, actions: draft.actions.filter((_, at) => at !== index) };
            renderActions();
            actions.querySelector<HTMLSelectElement>('select')?.focus();
          }));
          group.append(controls);
        }
        actions.append(group);
      }
      updateValidity?.();
    }
    const add = createButton(t('添加动作', 'Add action'), () => {
      if (!draft || draft.actions.length >= 12) return;
      draft = { ...draft, actions: [...draft.actions, { type: 'command', command: 'save' }] };
      renderActions();
      actions.querySelectorAll<HTMLSelectElement>('select[name="action"]')[draft.actions.length - 1]?.focus();
    });
    const message = createElement('p', 'settings-shortcut-conflict');
    message.setAttribute('role', 'status');
    const submit = createButton(t('保存快捷键', 'Save shortcut'), () => { void commit(); });
    const cancel = createButton(t('取消', 'Cancel'), closeDraft);
    const controls = createElement('div', 'settings-shortcut-controls');
    controls.append(submit, cancel);
    const footer = createElement('div', 'settings-custom-footer');
    footer.append(add, controls);
    next.append(field(t('名称', 'Name'), name), field(t('生效范围', 'When active'), scope), strokes, actions, message, footer);

    function validate() {
      if (!draft) return [];
      const conflicts = customShortcutConflicts(draft, options.preferences(), options.platform);
      const invalidScope = draft.actions.some(action => !customShortcutActionFitsScope(action, draft!.scope));
      const invalidOrder = draft.actions.slice(0, -1).some(action => !customShortcutActionCanContinue(action));
      const conflictNames = conflicts.map(conflict => conflict.type === 'command' ? commandTitle(conflict.command, language) : conflict.name);
      message.textContent = invalidScope ? t('请选择该动作支持的生效范围。', 'Choose a scope supported by every action.')
        : invalidOrder ? t('会打开界面或异步完成的动作只能放在最后。', 'An action that opens a control or finishes asynchronously must be last.')
          : conflicts.length ? t('已用于：', 'Already assigned to: ') + conflictNames.join(' · ') : '';
      message.hidden = !message.textContent;
      submit.textContent = conflicts.length ? t('替换原绑定并保存', 'Replace binding and save') : t('保存快捷键', 'Save shortcut');
      submit.classList.toggle('settings-warning', !!conflicts.length);
      submit.disabled = saving || invalidScope || invalidOrder || !isCustomShortcut(draft) || conflicts.some(conflict => conflict.fixed);
      add.disabled = draft.actions.length >= 12;
      second.disabled = !draft.strokes[0];
      return conflicts;
    }
    next.addEventListener('submit', event => event.preventDefault());
    async function commit() {
      const conflicts = validate();
      if (submit.disabled || !draft) return;
      const shortcut = draft;
      saving = true;
      validate();
      const saved = await options.save({ type: 'saveCustomShortcut', shortcut, replaceConflicts: conflicts.length > 0 }, shortcut.id);
      saving = false;
      if (saved && draft === shortcut) closeDraft();
      else updateValidity?.();
    }
    form = next;
    formLanguage = language;
    updateValidity = validate;
    renderActions();
    return next;
  }

  return {
    closeDraft,
    count(query: string) { return visibleRules(query).length; },
    render(language: UiLanguage, query: string): HTMLElement[] {
      const rules = visibleRules(query);
      if (!draft && !rules.length && !settingsSearchMatches(query, ...keywords)) return [];
      const t = (zh: string, en: string) => settingsText(language, zh, en);
      const add = createButton(t('新增快捷键', 'Add shortcut'), () => startDraft());
      const rows: HTMLElement[] = draft ? [] : [add];
      for (const rule of rules) {
        if (rule.id === draft?.id) continue;
        const row = createElement('div', 'settings-item');
        row.dataset.customShortcut = rule.id;
        const title = createElement('div', 'settings-item-text');
        const [scopeZh, scopeEn] = customShortcutScopeTitles[rule.scope];
        const details = [t(scopeZh, scopeEn), ...rule.actions.map(action => {
          if (action.type === 'command') return commandTitle(action.command, language);
          const [zh, en] = customShortcutActionTitles[action.type];
          return t(zh, en);
        })];
        title.append(createElement('div', 'settings-item-title', rule.name), createElement('p', 'settings-description', details.join(' · ')));
        const controls = createElement('div', 'settings-shortcut-controls');
        rule.strokes.forEach((stroke, index) => {
          if (index > 0) controls.append(createElement('span', 'settings-description', t('然后', 'then')));
          controls.append(createElement('kbd', 'settings-key', stroke));
        });
        if (!rule.strokes.length) controls.append(createElement('span', 'settings-unassigned', t('未设置', 'Unassigned')));
        const edit = createButton(t('修改', 'Edit'), () => startDraft(rule));
        edit.dataset.customShortcutEdit = rule.id;
        const remove = createButton(t('删除', 'Delete'), async () => {
          remove.disabled = true;
          const saved = await options.save({ type: 'deleteCustomShortcut', id: rule.id }, rule.id);
          if (saved) document.querySelector<HTMLButtonElement>('[data-add-custom-shortcut]')?.focus();
          else remove.disabled = false;
        });
        edit.disabled = remove.disabled = !!draft;
        controls.append(edit, remove);
        row.append(title, controls);
        rows.push(row);
      }
      add.dataset.addCustomShortcut = '';
      if (draft) rows.push(renderForm(language));
      return rows;
    }
  };
}
