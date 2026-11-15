import { loadingPresentationStyles } from '../../../src/foundation/loadingPresentationStyles';
export { loadingPresentationStyles };

/** Callers choose immediate feedback for empty regions and own readiness and cancellation. */
export function createLoadingPresentation(className: string, existingElement?: HTMLElement | null) {
  if (!document.getElementById('meo-loading-presentation-style')) {
    const style = document.createElement('style'); style.id = 'meo-loading-presentation-style';
    style.textContent = loadingPresentationStyles; document.head.append(style);
  }
  const element = existingElement ?? document.createElement('div');
  element.className = `surface-loading ${className}`;
  if (!existingElement) element.hidden = true;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  const spinner = element.querySelector<HTMLElement>('.surface-loading-spinner') ?? document.createElement('span');
  spinner.className = `surface-loading-spinner ${className}-spinner`;
  spinner.setAttribute('aria-hidden', 'true');
  const label = element.querySelector<HTMLElement>('.surface-loading-label') ?? document.createElement('span');
  label.className = 'surface-loading-label';
  if (spinner.parentElement !== element) element.append(spinner);
  if (label.parentElement !== element) element.append(label);
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    element,
    get pending() { return pending; },
    setLabel(text: string) { label.textContent = text; },
    begin(canShow: () => boolean, onVisible: () => void, { immediate = false }: { readonly immediate?: boolean } = {}) {
      if (pending && (!immediate || !element.hidden)) return;
      pending = true;
      const show = () => {
        timer = undefined;
        if (!pending || !canShow()) return;
        element.hidden = false;
        onVisible();
      };
      if (immediate) {
        clearTimeout(timer);
        show();
      } else timer = setTimeout(show, 200);
    },
    finish(retainCover = false) {
      clearTimeout(timer); timer = undefined; pending = false;
      if (!retainCover) element.hidden = true;
    }
  };
}
