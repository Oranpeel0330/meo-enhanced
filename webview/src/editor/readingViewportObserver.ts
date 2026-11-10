import { readingPreparationMargin } from '../application/readingWindow';

export type ReadingViewportObserver = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>;

/** One resizable approach band, reusable by resource types without new timers.
 * disconnect releases all listeners; observe can resume a paused owner. */
export function observeReadingViewport(document: Document, changed: (entries: IntersectionObserverEntry[]) => void,
  root: HTMLElement | null = null): ReadingViewportObserver | null {
  const window = document.defaultView as (Window & typeof globalThis) | null;
  if (!window?.IntersectionObserver) return null;
  const targets = new Set<Element>();
  let observer: IntersectionObserver | null = null, resize: ResizeObserver | null = null;
  let margin = -1;
  const refresh = () => {
    if (!targets.size) return;
    const nextMargin = readingPreparationMargin(root ? root.clientHeight : document.documentElement.clientHeight);
    if (observer && margin === nextMargin) return;
    observer?.disconnect();
    margin = nextMargin;
    const next = new window.IntersectionObserver(entries => { if (observer === next) changed(entries); },
      // An implicit root crosses the iframe and clips targets before applying
      // rootMargin. The resource's own document must own its approach band.
      { root: root ?? document, rootMargin: `${margin}px 0px` });
    observer = next;
    for (const target of targets) next.observe(target);
  };
  const disconnect = () => {
    observer?.disconnect(); observer = null;
    resize?.disconnect(); resize = null;
    window.removeEventListener('resize', refresh);
    targets.clear();
  };
  return {
    observe(target) {
      if (targets.has(target)) return;
      if (!targets.size) {
        window.addEventListener('resize', refresh);
        if (root && window.ResizeObserver) { resize = new window.ResizeObserver(refresh); resize.observe(root); }
      }
      targets.add(target);
      if (observer) observer.observe(target); else refresh();
    },
    unobserve(target) {
      targets.delete(target); observer?.unobserve(target);
      if (!targets.size) disconnect();
    },
    disconnect
  };
}
