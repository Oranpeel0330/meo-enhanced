import morphdom from 'morphdom';
import { previewSourceMorphKeys, type PreviewSourceLineMapper } from './previewSourceIdentity';
import { addPreviewCodeCopyControls, previewCopyBlockSelector, previewCopyBlockKind } from './previewBlockActions';
import { hasBoundedPreviewResources } from './previewViewportResources';
import { renderDeferredPreviewMath } from './previewMath';
import { type UiLanguage } from '../application/uiLanguage';
import { hasAppliedPreviewCodeHighlight, isPreviewCodeHighlightReady } from './previewCodeHighlight';

const previewMutableStateAttributes = new Set([
  'open',
  'data-source-line',
  'data-source-end-line',
  'data-meo-code-fence-start',
  'data-meo-code-fence-end',
  'data-meo-preview-block'
]);

const previewPresentationSelector = [
  '.meo-export-mermaid[data-source-b64]',
  '.meo-export-math-display',
  '.meo-export-math-inline'
].join(', ');

function isPreviewMathElement(element: Element): boolean {
  return element.classList.contains('meo-export-math-display')
    || element.classList.contains('meo-export-math-inline');
}

function getPreviewPresentationSignature(element: Element): string | null {
  if (element.classList.contains('meo-export-mermaid')) {
    const source = element.getAttribute('data-source-b64');
    return source ? `mermaid:${source}` : null;
  }
  if (!isPreviewMathElement(element)) return null;
  const layout = element.classList.contains('meo-export-math-display') ? 'display' : 'inline';
  const fenced = element.classList.contains('meo-export-math-fenced-display') ? ':fenced' : '';
  const canvas = element.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas');
  const source = element.getAttribute('data-source-b64');
  return `math:${layout}${fenced}:${source ?? canvas?.innerHTML ?? element.innerHTML}`;
}

function previewRootSourceKey(element: Element, main: HTMLElement, sourceKeys: WeakMap<Node, string>): string | undefined {
  for (let root: Element | null = element; root && root !== main; root = root.parentElement) {
    const key = sourceKeys.get(root);
    if (key) return key;
  }
  return undefined;
}

function preparePreviewPresentationMorphKeys(
  currentMain: HTMLElement,
  nextMain: HTMLElement,
  sourceKeys: WeakMap<Node, string>
): WeakMap<Node, string> {
  const available = new Map<string, HTMLElement[]>();
  const unscoped = new Map<string, HTMLElement[]>();
  for (const element of Array.from(currentMain.querySelectorAll<HTMLElement>(previewPresentationSelector))) {
    const signature = getPreviewPresentationSignature(element);
    if (!signature) continue;
    const scope = previewRootSourceKey(element, currentMain, sourceKeys);
    const pool = scope ? available : unscoped, key = scope ? `${scope}:${signature}` : signature;
    const matches = pool.get(key);
    if (matches) matches.push(element);
    else pool.set(key, [element]);
  }

  const keys = new WeakMap<Node, string>();
  let pairIndex = 0;
  for (const element of Array.from(nextMain.querySelectorAll<HTMLElement>(previewPresentationSelector))) {
    const signature = getPreviewPresentationSignature(element);
    const scope = previewRootSourceKey(element, nextMain, sourceKeys);
    // A new duplicate must not steal a formula/diagram owned by an unchanged
    // source root. Unknown/changed roots can still reuse matching presentations.
    const current = signature ? (scope ? available.get(`${scope}:${signature}`)?.shift() : undefined)
      ?? unscoped.get(signature)?.shift() : undefined;
    if (!current) continue;
    const key = `meo-preview-presentation-${pairIndex += 1}`;
    keys.set(current, key); keys.set(element, key);
  }

  return keys;
}

function syncSourceMappingAttributes(fromElement: Element, toElement: Element): void {
  for (const attribute of ['data-source-line', 'data-source-end-line', 'data-meo-preview-block', 'data-meo-code-fence-start', 'data-meo-code-fence-end']) {
    const value = toElement.getAttribute(attribute);
    if (fromElement.getAttribute(attribute) === value) continue;
    if (value === null) fromElement.removeAttribute(attribute);
    else fromElement.setAttribute(attribute, value);
  }
}

function syncDescendantSourceMappings(fromElement: Element, toElement: Element): void {
  // Equivalence ignores source identity, including its addition/removal when
  // changing layouts. Walk the proven corresponding structure, not just the
  // old subset of mapped nodes. Themed code can have a different token tree;
  // its existing literal rows are the stable correspondence at that boundary.
  const pairs: Array<readonly [Element, Element]> = [[fromElement, toElement]];
  while (pairs.length) {
    const [from, to] = pairs.pop()!;
    syncSourceMappingAttributes(from, to);
    if (from.matches('code.hljs')) {
      const fromRows = from.querySelectorAll('.meo-export-code-line-source');
      const toRows = to.querySelectorAll('.meo-export-code-line-source');
      for (let index = 0; index < fromRows.length; index++) syncSourceMappingAttributes(fromRows[index], toRows[index]);
    } else {
      for (let index = 0; index < from.children.length; index++) pairs.push([from.children[index], to.children[index]]);
    }
  }
}

function haveEquivalentPreviewAttributes(left: Element, right: Element, preserveCodeLine = false): boolean {
  let leftCount = 0;
  let rightCount = 0;
  for (const attribute of Array.from(left.attributes)) {
    if (previewMutableStateAttributes.has(attribute.name)
      || (preserveCodeLine && attribute.name === 'data-meo-shiki')) continue;
    leftCount += 1;
    if (right.getAttribute(attribute.name) !== attribute.value) return false;
  }
  for (const attribute of Array.from(right.attributes)) {
    if (!previewMutableStateAttributes.has(attribute.name)
      && !(preserveCodeLine && attribute.name === 'data-meo-shiki')) rightCount += 1;
  }
  return leftCount === rightCount;
}

function areEquivalentPreviewNodes(left: Node, right: Node, preserveCodeHighlight = false): boolean {
  if (left.nodeType !== right.nodeType) return false;
  if (left.nodeType !== 1) return left.isEqualNode(right);
  const leftElement = left as Element;
  const rightElement = right as Element;
  const preserveCodeLine = preserveCodeHighlight
    && leftElement.classList.contains('meo-export-code-line-source')
    && rightElement.classList.contains('meo-export-code-line-source')
    && leftElement.hasAttribute('data-meo-shiki');
  if (
    leftElement.tagName !== rightElement.tagName
    || !haveEquivalentPreviewAttributes(leftElement, rightElement, preserveCodeLine)
  ) return false;
  if (preserveCodeLine) return leftElement.textContent === rightElement.textContent;
  if (leftElement.childNodes.length !== rightElement.childNodes.length) return false;
  for (let index = 0; index < leftElement.childNodes.length; index += 1) {
    if (!areEquivalentPreviewNodes(
      leftElement.childNodes[index],
      rightElement.childNodes[index],
      preserveCodeHighlight
    )) return false;
  }
  return true;
}

function areEquivalentPreviewElements(left: HTMLElement, right: HTMLElement): boolean {
  if (left.isEqualNode(right)) return true;
  // Host fallback spans differ from the themed token DOM. Retain that projection
  // only beneath an equivalent code root, so language/structure changes still morph.
  return areEquivalentPreviewNodes(left, right, left.matches('code.hljs') && right.matches('code.hljs'));
}

function preserveLoadedPreviewImage(fromImage: HTMLImageElement, toImage: HTMLImageElement): boolean {
  const loadedSource = fromImage.dataset.meoPreviewImageSource;
  const nextSource = toImage.dataset.meoDeferredImageSrc;
  if (!loadedSource || loadedSource !== nextSource) return false;
  for (const attribute of Array.from(fromImage.attributes)) {
    if (
      attribute.name !== 'src'
      && attribute.name !== 'data-meo-preview-image-source'
      && attribute.name !== 'data-meo-preview-image-ready'
      && !toImage.hasAttribute(attribute.name)
    ) {
      fromImage.removeAttribute(attribute.name);
    }
  }
  for (const attribute of Array.from(toImage.attributes)) {
    if (attribute.name !== 'src' && attribute.name !== 'data-meo-deferred-image-src') {
      fromImage.setAttribute(attribute.name, attribute.value);
    }
  }
  syncSourceMappingAttributes(fromImage, toImage);
  return true;
}

export type PreviewCodeBlockUpdate = {
  readonly current: HTMLElement;
  readonly next: HTMLElement;
};

function morphPreviewMain(
  frameDocument: Document,
  currentMain: HTMLElement,
  html: string,
  deferUnreadyCodeBlock: boolean,
  pendingCodeBlocks: readonly PreviewCodeBlockUpdate[] | undefined,
  isCurrent: () => boolean,
  retainTableColumns = true,
  sourceRevision?: { before: string | null; after: string; mapSourceLine?: PreviewSourceLineMapper },
  retainedPositionMarker?: HTMLElement | null
): PreviewCodeBlockUpdate[] {
  const updates: PreviewCodeBlockUpdate[] = pendingCodeBlocks ? [...pendingCodeBlocks] : [];
  let presentationKeys = new WeakMap<Node, string>();
  let sourceKeys = new WeakMap<Node, string>();
  const actionKeys = new WeakMap<Node, string>();
  let nextActionKey = 0;
  if (!pendingCodeBlocks) {
    const nextMain = frameDocument.createElement('main');
    nextMain.className = 'meo-export-doc';
    nextMain.innerHTML = html;
    if (sourceRevision) sourceKeys = previewSourceMorphKeys(currentMain, nextMain, sourceRevision.before, sourceRevision.after, sourceRevision.mapSourceLine);
    const nearbyControls = hasBoundedPreviewResources(frameDocument);
    if (!nearbyControls) addPreviewCodeCopyControls(nextMain, frameDocument.documentElement.lang as UiLanguage);
    const currentTables = retainTableColumns ? Array.from(currentMain.querySelectorAll<HTMLTableElement>('table')) : [];
    const tableSource = (table: HTMLTableElement) => {
      // Fitted columns belong to the same mapped root as the table DOM. Raw
      // line numbers change when text is inserted above an untouched table.
      return previewRootSourceKey(table, currentMain.contains(table) ? currentMain : nextMain, sourceKeys)
        ?? table.closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine;
    };
    const availableTables = new Set(currentTables);
    Array.from(nextMain.querySelectorAll<HTMLTableElement>('table')).forEach(table => {
      // The replacement window can start before/after the accepted window.
      // Its first table is not necessarily the same source table.
      const current = currentTables.find(candidate => availableTables.has(candidate)
        && tableSource(candidate) === tableSource(table));
      if (current) availableTables.delete(current);
      const columns = current
        ?.querySelector<HTMLTableColElement>(':scope > colgroup[data-meo-preview-columns]');
      if (columns && current) {
        table.prepend(columns.cloneNode(true));
        // Column tracks and their fitted table box form one layout. Keeping
        // only the tracks briefly restores an automatic-width table until the
        // next visibility callback, moving narrow columns on every input.
        for (const property of ['width', 'min-width', 'max-width', 'table-layout', '--meo-preview-table-cell-inline-padding']) {
          const value = current.style.getPropertyValue(property);
          if (value) table.style.setProperty(property, value, current.style.getPropertyPriority(property));
        }
        table.classList.toggle('meo-preview-table-compressed', current.classList.contains('meo-preview-table-compressed'));
      }
    });
    presentationKeys = preparePreviewPresentationMorphKeys(currentMain, nextMain, sourceKeys);
    updates.push({ current: currentMain, next: nextMain });
  }
  const deferredCodeBlocks: PreviewCodeBlockUpdate[] = [];
  for (const { current, next } of updates) {
    if (!currentMain.contains(current)) continue;
    morphdom(current, next, {
      childrenOnly: !pendingCodeBlocks,
      getNodeKey(node) {
        if (node.nodeType !== 1) return undefined;
        const element = node as Element;
        // Cached overlay references must never be repurposed as document blocks.
        const overlay = ['meo-preview-source-position-marker']
          .find(className => element.classList.contains(className));
        if (overlay) return overlay;
        const presentation = presentationKeys.get(node);
        if (presentation) return presentation;
        if (element.classList.contains('meo-preview-code-actions')) {
          // Controls carry listeners and must never become rendered content.
          // Reuse them only when their direct block has a proven identity pair.
          const acceptedKey = actionKeys.get(node);
          if (acceptedKey) return acceptedKey;
          const owner = element.parentElement;
          const ownerKey = owner && (presentationKeys.get(owner) ?? sourceKeys.get(owner));
          const key = owner && ownerKey ? `preview-actions:${previewCopyBlockKind(owner)}:${ownerKey}`
            : `preview-actions:unmatched:${nextActionKey += 1}`;
          actionKeys.set(node, key);
          return key;
        }
        if (element.id) return element.id;
        const source = sourceKeys.get(node);
        if (source) return source;
        // Non-source window roots keep their existing positional fallback.
        const block = element.getAttribute('data-meo-preview-block');
        const line = element.getAttribute('data-source-line');
        return block !== null ? `preview-block:${block}:${element.tagName}:${line ?? ''}` : undefined;
      },
      onBeforeNodeDiscarded(node) {
        // The position overlay belongs to this reading document, not its
        // rendered Markdown. Keep it mounted while its owner accepts the new
        // source mapping (which can still hide an unmapped destination).
        return node !== retainedPositionMarker;
      },
      onBeforeElUpdated(fromElement, toElement) {
        if (hasBoundedPreviewResources(frameDocument)
          && fromElement.matches(previewCopyBlockSelector) && toElement.matches(previewCopyBlockSelector)
          && previewCopyBlockKind(fromElement) === previewCopyBlockKind(toElement)) {
          // Match only controls that already exist. Populating the entire
          // detached replacement would undo viewport-scoped initialization.
          for (const selector of [':scope > .meo-preview-code-actions', ':scope > .meo-export-code-language-label']) {
            const control = fromElement.querySelector(selector);
            if (control && !toElement.querySelector(selector)) toElement.append(control.cloneNode(true));
          }
        }
        if (
          fromElement.classList.contains('meo-preview-code-actions')
          && toElement.classList.contains('meo-preview-code-actions')
        ) return false;
        if (
          fromElement.tagName === 'IMG'
          && toElement.tagName === 'IMG'
          && preserveLoadedPreviewImage(
            fromElement as HTMLImageElement,
            toElement as HTMLImageElement
          )
        ) {
          return false;
        }
        const mermaidSource = fromElement.dataset.sourceB64;
        if (
          mermaidSource
          && fromElement.classList.contains('meo-export-mermaid')
          && toElement.classList.contains('meo-export-mermaid')
        ) {
          const nextSource = toElement.dataset.sourceB64;
          if (
            nextSource
            && nextSource !== mermaidSource
            && fromElement.classList.contains('is-rendered')
            && fromElement.querySelector('svg')
          ) {
            // Keep the last successful diagram on screen while the replacement is
            // rendered off-layout. The renderer commits the new SVG atomically.
            fromElement.dataset.sourceB64 = nextSource;
            fromElement.dataset.meoPreviewMermaidPending = 'true';
            delete fromElement.dataset.meoPreviewMermaidAppearance;
            syncSourceMappingAttributes(fromElement, toElement);
            return false;
          }
          if (mermaidSource !== nextSource) return true;
          syncSourceMappingAttributes(fromElement, toElement);
          return false;
        }
        const fromPresentation = getPreviewPresentationSignature(fromElement);
        if (
          fromPresentation?.startsWith('math:')
          && fromPresentation === getPreviewPresentationSignature(toElement)
        ) {
          syncSourceMappingAttributes(fromElement, toElement);
          return false;
        }
        // A previously generated formula must update atomically. Deferral is
        // for unseen content, not a reason to replace a readable result with
        // raw TeX until the next intersection delivery.
        if (fromPresentation?.startsWith('math:') && fromElement.querySelector('.katex')) {
          renderDeferredPreviewMath(toElement as HTMLElement);
        }
        if (
          deferUnreadyCodeBlock
          && fromElement.classList.contains('meo-export-code-block-wrap')
          && toElement.classList.contains('meo-export-code-block-wrap')
          && (fromElement.textContent !== toElement.textContent || fromElement.dataset.meoCodeId !== toElement.dataset.meoCodeId)
          && hasAppliedPreviewCodeHighlight(fromElement)
          && !isPreviewCodeHighlightReady(toElement, isCurrent)
        ) {
          // Keep the last fully themed block until the replacement tokens exist.
          // The Shiki refresh callback revisits only this block and commits the
          // new source and token DOM together before the next visible frame.
          syncSourceMappingAttributes(fromElement, toElement);
          deferredCodeBlocks.push({ current: fromElement, next: toElement });
          return false;
        }
        if (fromElement.tagName === 'DETAILS') {
          toElement.toggleAttribute('open', (fromElement as HTMLDetailsElement).open);
        }
        if (areEquivalentPreviewElements(fromElement, toElement)) {
          syncDescendantSourceMappings(fromElement, toElement);
          return false;
        }
        return true;
      }
    });
  }
  // A pending block must not retain the rest of the detached document tree.
  for (const { next } of deferredCodeBlocks) next.remove();
  return deferredCodeBlocks;
}

/** Preserve accepted DOM and source identity while replacing a rendered revision. */
export const previewReconciliation = { signature: getPreviewPresentationSignature, update: morphPreviewMain };
