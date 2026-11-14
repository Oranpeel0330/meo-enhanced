import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import { createVersionInformation } from './versionInformation';

/** Interactive companion to the navigation item; lives outside the menu's scrolling box. */
export function createFeedbackVersionPopover(options: {
  readonly anchor: HTMLButtonElement;
  readonly menu: HTMLElement;
  readonly information: ReturnType<typeof createVersionInformation>;
  readonly focusNext: () => void;
}) {
  const { anchor, menu, information } = options;
  const doc = anchor.ownerDocument, view = doc.defaultView!;
  const menuGap = 2;
  const element = doc.createElement('div'); element.className = 'feedback-version-popover';
  element.id = 'feedback-version-popover'; element.hidden = true; element.setAttribute('role', 'dialog');
  element.append(information.element); doc.body.append(element);
  anchor.setAttribute('aria-controls', element.id); anchor.setAttribute('aria-expanded', 'false');
  const events = new AbortController();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let positionFrame: number | undefined, disposed = false;
  const contains = (target: Node | null) => !!target && (anchor.contains(target) || element.contains(target));
  const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(value, maximum));

  function cancelClose() {
    clearTimeout(closeTimer); closeTimer = undefined;
  }
  function hide() {
    cancelClose();
    if (positionFrame !== undefined) view.cancelAnimationFrame(positionFrame); positionFrame = undefined;
    element.hidden = true; anchor.classList.remove('is-version-open'); anchor.setAttribute('aria-expanded', 'false'); information.close();
  }
  function position() {
    if (element.hidden || disposed) return;
    const a = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
    if (menu.hidden || a.bottom <= Math.max(8, m.top) || a.top >= Math.min(view.innerHeight - 8, m.bottom)) { hide(); return; }
    element.style.width = `${Math.min(232, view.innerWidth - 16)}px`;
    const { width, height } = element.getBoundingClientRect();
    let left: number, top = clamp(a.top, 8, view.innerHeight - height - 8);
    if (m.left - width - menuGap >= 8) { left = m.left - width - menuGap; element.dataset.side = 'left'; }
    else if (m.right + width + menuGap <= view.innerWidth - 8) { left = m.right + menuGap; element.dataset.side = 'right'; }
    else {
      left = clamp(m.right - width, 8, view.innerWidth - width - 8);
      top = m.bottom + height + menuGap <= view.innerHeight - 8 ? m.bottom + menuGap
        : m.top - height - menuGap >= 8 ? m.top - height - menuGap : clamp(a.bottom + menuGap, 8, view.innerHeight - height - 8);
      element.dataset.side = top >= m.bottom ? 'bottom' : top + height <= m.top ? 'top' : 'overlap';
    }
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  }
  function reposition() {
    if (element.hidden || positionFrame !== undefined) return;
    positionFrame = view.requestAnimationFrame(() => { positionFrame = undefined; position(); });
  }
  function show() {
    cancelClose();
    if (disposed || menu.hidden) return;
    element.hidden = false; anchor.classList.add('is-version-open'); anchor.setAttribute('aria-expanded', 'true');
    information.open(); position();
  }
  function enter() {
    cancelClose();
    if (element.hidden) show();
  }
  function leave(event: PointerEvent | FocusEvent) {
    if (contains(event.relatedTarget as Node | null)) return;
    // Pointer transitions must not dismiss a version panel being used by keyboard.
    if (event.type === 'pointerleave' && (anchor.matches(':focus-visible') || element.querySelector(':focus-visible'))) return;
    if (event.type === 'focusout' && (anchor.matches(':hover') || element.matches(':hover'))) return;
    cancelClose();
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (anchor.matches(':hover') || element.matches(':hover') || anchor.matches(':focus-visible') || element.querySelector(':focus-visible')) return;
      hide();
    }, 100);
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !element.hidden) {
      if (element.contains(doc.activeElement)) anchor.focus();
      hide(); event.preventDefault(); event.stopPropagation();
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target === anchor) {
      show(); element.querySelector<HTMLButtonElement>('button:not(:disabled):not([hidden])')?.focus(); event.preventDefault();
    } else if (event.key === 'Tab' && !event.shiftKey && event.target === anchor && !element.hidden) {
      const first = element.querySelector<HTMLButtonElement>('button:not(:disabled):not([hidden])');
      if (first) { first.focus(); event.preventDefault(); }
    } else if (event.key === 'Tab' && element.contains(event.target as Node)) {
      const buttons = [...element.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])')];
      if (event.shiftKey && event.target === buttons[0]) { anchor.focus(); event.preventDefault(); }
      else if (!event.shiftKey && event.target === buttons.at(-1)) {
        options.focusNext(); hide(); event.preventDefault();
      }
    }
  }
  for (const target of [anchor, element] as HTMLElement[]) {
    target.addEventListener('pointerenter', enter, { signal: events.signal });
    target.addEventListener('pointerleave', leave, { signal: events.signal });
    target.addEventListener('focusin', enter, { signal: events.signal });
    target.addEventListener('focusout', leave, { signal: events.signal });
    target.addEventListener('keydown', keydown, { signal: events.signal });
  }
  view.addEventListener('resize', reposition, { signal: events.signal });
  doc.addEventListener('scroll', reposition, { capture: true, signal: events.signal });
  const observer = new ResizeObserver(reposition); observer.observe(information.element);
  return { contains, hide, reposition,
    setLanguage(language: UiLanguage) { information.setLanguage(language); element.setAttribute('aria-label', language === 'zh-CN' ? '版本信息' : 'Version information'); reposition(); },
    dispose() { if (disposed) return; hide(); disposed = true; events.abort(); observer.disconnect(); information.dispose(); element.remove(); anchor.removeAttribute('aria-controls'); anchor.removeAttribute('aria-expanded'); }
  };
}
