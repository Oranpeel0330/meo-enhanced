import { createElement, ExternalLink, type IconNode } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';

const documentJumpIcon: IconNode = [
  ['path', { d: 'M9.375 3.886 A4.75 4.75 0 1 0 9.375 12.114' }],
  ['line', { x1: '4.75', y1: '8', x2: '14', y2: '8' }],
  ['path', { d: 'M11.5 5.5 L14 8 L11.5 10.5' }]
];

export function createLinkOpenIcon(isDocumentFragment: boolean, size = 24): SVGElement {
  const attributes = { width: size, height: size, 'aria-hidden': 'true' };
  return isDocumentFragment
    ? createElement(documentJumpIcon, { ...attributes, viewBox: '0 0 16 16', 'stroke-width': 0.833 })
    : createElement(ExternalLink, attributes);
}

export function createOpenLinkButton(href: string, language: UiLanguage): HTMLButtonElement {
  const isDocumentFragment = href.startsWith('#');
  const strings = getUiStrings(language);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-md-link-open-btn';
  button.dataset.tooltip = href;
  button.dataset.tooltipLinkHref = href;
  button.dataset.tooltipKind = 'description';
  button.setAttribute('aria-label', isDocumentFragment ? strings.jumpWithinDocument : strings.openLink);
  button.appendChild(createLinkOpenIcon(isDocumentFragment));
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.dispatchEvent(new CustomEvent('meo-open-link', {
      bubbles: true,
      detail: { href }
    }));
  });
  return button;
}
