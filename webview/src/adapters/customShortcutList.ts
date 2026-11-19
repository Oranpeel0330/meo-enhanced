import { createElement as icon, Pencil, Plus } from 'lucide';
import type { CustomShortcut } from '../../../src/foundation/editingPreferences';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import {
  customShortcutActionTitle, customShortcutActionTitles, customShortcutScopeTitles, customShortcutSearchKeywords, customShortcutTitle, sectionTitles,
  settingsSearchMatches, settingsText
} from '../application/settingsCatalog';
import { button, element, iconButton, keycaps } from './customShortcutControls';

const keywords = [...sectionTitles.customShortcuts, ...customShortcutSearchKeywords];

export function filterCustomShortcuts(rules: readonly CustomShortcut[], query: string) {
  return rules.filter(rule => settingsSearchMatches(query, ...keywords,
    customShortcutTitle(rule, 'zh-CN'), customShortcutTitle(rule, 'en'), ...rule.strokes, ...customShortcutScopeTitles[rule.scope],
    ...rule.actions.flatMap(action => [customShortcutActionTitle(action, 'zh-CN'), customShortcutActionTitle(action, 'en'),
      ...(action.type === 'mode' ? customShortcutActionTitles.mode : [])])));
}

export function renderCustomShortcutList(options: {
  rules: readonly CustomShortcut[];
  language: UiLanguage;
  query: string;
  open: (rule?: CustomShortcut) => void;
  createRemovalButton: (rule: CustomShortcut) => HTMLButtonElement;
}) {
  const { language, query } = options;
  const rules = filterCustomShortcuts(options.rules, query);
  if (!rules.length && !settingsSearchMatches(query, ...keywords)) return null;
  const t = (zh: string, en: string) => settingsText(language, zh, en);
  const section = element('section', 'settings-section');
  section.id = 'meo-settings-customShortcuts';
  const heading = element('div', 'settings-shortcut-section-heading');
  const add = button(t('新建动作', 'New action'), () => options.open());
  add.dataset.addCustomShortcut = '';
  add.prepend(icon(Plus, { width: 14, height: 14, 'aria-hidden': 'true' }));
  heading.append(element('h3', 'settings-section-title', t(...sectionTitles.customShortcuts)), add);
  section.append(heading);
  for (const rule of rules) {
    const row = element('div', 'settings-item settings-custom-shortcut-row');
    row.dataset.customShortcut = rule.id;
    const title = element('div', 'settings-item-text settings-custom-shortcut-copy');
    const summary = rule.actions.map(action => customShortcutActionTitle(action, language)).join(' → ');
    const [scopeZh, scopeEn] = customShortcutScopeTitles[rule.scope];
    const scope = t(scopeZh, scopeEn);
    title.append(element('span', 'settings-item-title', customShortcutTitle(rule, language)),
      element('span', 'settings-custom-shortcut-summary', scope + ' · ' + summary));
    const keys = element('div', 'settings-shortcut-keys');
    keys.append(...(rule.strokes.length ? keycaps(rule.strokes, t('然后', 'then')) : [element('span', 'settings-unassigned', t('未设置', 'Unassigned'))]));
    const controls = element('div', 'settings-shortcut-row-tools');
    const edit = iconButton(Pencil, t('编辑', 'Edit'), () => options.open(rule));
    edit.dataset.customShortcutEdit = rule.id;
    controls.append(edit, options.createRemovalButton(rule));
    row.append(title, keys, controls);
    section.append(row);
  }
  if (!rules.length && !query) section.append(element('p', 'settings-description settings-custom-shortcut-empty', t(
    '组合编辑器命令或插入片段，再给动作绑定按键。',
    'Combine editor commands or insert snippets, and assign keys to run the action.')));
  return section;
}
