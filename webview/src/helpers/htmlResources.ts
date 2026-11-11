import { mapHtmlSrcset } from '../../../src/shared/htmlPolicy';
import { htmlStyleHasResources, withoutHtmlStyleResources } from '../../../src/shared/htmlStyleResources';
import { resolveHtmlStyles } from '../adapters/htmlStylesTransport';

const pendingResources = new WeakMap<Element, Map<string, { source: string; signal: AbortSignal }>>();
const resolvedStyles = new WeakMap<Element, string>();
const authoredStyles = new WeakMap<Element, string>();
const pendingStyles = new WeakMap<Element, { source: string; signal: AbortSignal }>();

export function preserveHtmlStyleResources(from: Element, to: Element): void {
  const authored = authoredStyles.get(from), resolved = resolvedStyles.get(from);
  if (authored !== undefined && resolved !== undefined && to.getAttribute('style') === authored && from.getAttribute('style') === resolved) {
    to.setAttribute('style',resolved);
  }
}

export function resolveHtmlStylesElement(element: HTMLStyleElement, options: { signal: AbortSignal; force?: boolean; commit(apply: () => void): void }): void {
  const source = element.textContent ?? '';
  if (!htmlStyleHasResources(source) || !options.force && resolvedStyles.get(element) === source) return;
  const previous = pendingStyles.get(element);
  if (!options.force && previous?.source === source && previous.signal === options.signal && !previous.signal.aborted) return;
  const request = {source,signal:options.signal};
  pendingStyles.set(element,request);
  void resolveHtmlStyles(source, options.signal).then(css => {
    if (options.signal.aborted || pendingStyles.get(element) !== request || !element.isConnected || element.textContent !== source) return;
    const accepted = css ?? withoutHtmlStyleResources(source);
    options.commit(() => {
      if (options.signal.aborted || pendingStyles.get(element) !== request || element.textContent !== source) return;
      pendingStyles.delete(element);
      element.textContent = accepted;
      resolvedStyles.set(element, accepted);
    });
  });
}

/** Reuses the owning surface's resolver, cancellation and geometry commit.
 * Pictures and media stay native elements; an image widget cannot replace a
 * picture's direct img child without breaking browser source selection. */
export function resolveHtmlResources(root: ParentNode, options: {
  resolve(source: string, signal: AbortSignal): Promise<string | null>;
  signal: AbortSignal;
  commit(apply: () => void): void;
}): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-meo-html-src],[data-meo-html-poster],[data-meo-html-srcset],[data-meo-html-href],[style]')) {
    for (const name of ['src', 'poster', 'srcset', 'href', 'style']) {
      const key = `data-meo-html-${name}`;
      const source = element.getAttribute(name === 'style' ? 'style' : key);
      if (!source) continue;
      if (name === 'style' && (!htmlStyleHasResources(source) || resolvedStyles.get(element) === source)) continue;
      if (name === 'style') authoredStyles.set(element,source);
      let pending = pendingResources.get(element);
      const previous = pending?.get(name);
      if (previous?.source === source && previous.signal === options.signal && !previous.signal.aborted) continue;
      if (!pending) pendingResources.set(element, pending = new Map());
      const request = { source, signal: options.signal };
      pending.set(name, request);
      const resolve = async () => {
        if (name === 'style') {
          const resolved = await resolveHtmlStyles(`x{${source}}`, options.signal);
          if (options.signal.aborted) return '';
          const css = resolved ?? withoutHtmlStyleResources(`x{${source}}`);
          return css.slice(css.indexOf('{') + 1, css.lastIndexOf('}'));
        }
        if (name !== 'srcset') return options.resolve(source, options.signal);
        const urls = new Map<string, string>();
        mapHtmlSrcset(source, url => { urls.set(url, ''); return url; });
        await Promise.all([...urls.keys()].map(async url => urls.set(url, await options.resolve(url, options.signal) ?? '')));
        return mapHtmlSrcset(source, url => urls.get(url) ?? '');
      };
      void resolve().then(value => {
        if (pending.get(name) !== request) return;
        if (options.signal.aborted) { pending.delete(name); return; }
        options.commit(() => {
          if (pending.get(name) !== request) return;
          pending.delete(name);
          if (options.signal.aborted || !element.isConnected) return;
          if (name === 'style' && element.getAttribute('style') !== source) return;
          if (value) element.setAttribute(name, value); else element.removeAttribute(name);
          if (name === 'style') resolvedStyles.set(element, value ?? '');
          element.removeAttribute(key);
          const media = element.closest<HTMLMediaElement>('audio,video');
          if (media && name === 'src') media.load();
        });
      }).catch(() => {
        // A failed/cancelled resolution leaves the source marker available to retry.
        if (pending.get(name) === request) pending.delete(name);
      });
    }
  }
}
