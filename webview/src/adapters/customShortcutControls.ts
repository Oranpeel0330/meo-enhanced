import { createElement as icon, type Plus } from 'lucide';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(text: string, onClick: () => void, className = 'settings-button') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export function iconButton(symbol: typeof Plus, label: string, onClick: () => void) {
  const node = button('', onClick, 'settings-close settings-shortcut-icon');
  node.append(icon(symbol, { width: 16, height: 16, 'aria-hidden': 'true' }));
  node.setAttribute('aria-label', label);
  node.dataset.tooltip = label;
  return node;
}

export function keycaps(keys: readonly string[], then: string) {
  return keys.flatMap((stroke, index) => [
    ...(index > 0 ? [element('span', 'settings-shortcut-then', then)] : []),
    element('kbd', 'settings-key', stroke)
  ]);
}
