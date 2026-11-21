import { layer, RectangleMarker, type EditorView } from '@codemirror/view';

const screenPixelWidth = 3;
const cursorClass = 'cm-cursor cm-cursor-primary';

type CaretPosition = { readonly viewportAnchor: number; readonly viewportLayoutLeft: number };

function mountCaretLayer(dom: HTMLElement) {
  const win = dom.ownerDocument.defaultView!;
  let lastPosition: CaretPosition = { viewportAnchor: 0, viewportLayoutLeft: 0 };
  let lastRatio = 0;
  let resolution: MediaQueryList | undefined;
  const paint = (cursor: HTMLElement, position: CaretPosition) => {
    lastPosition = position;
    const ratio = win.devicePixelRatio;
    const snappedLeft = Math.round(position.viewportAnchor * ratio) / ratio;
    cursor.style.transform = `translateX(${snappedLeft - position.viewportLayoutLeft}px) scaleX(${1 / ratio})`;
  };
  const updateResolution = () => {
    const ratio = win.devicePixelRatio;
    if (ratio === lastRatio) return;
    lastRatio = ratio;
    const cursor = dom.firstElementChild as HTMLElement | null;
    if (cursor) paint(cursor, lastPosition);
    resolution?.removeEventListener('change', updateResolution);
    resolution = win.matchMedia(`(resolution: ${ratio}dppx)`);
    resolution.addEventListener('change', updateResolution);
  };
  win.addEventListener('resize', updateResolution);
  updateResolution();
  return {
    dom,
    paint,
    dispose() {
      win.removeEventListener('resize', updateResolution);
      resolution?.removeEventListener('change', updateResolution);
    }
  };
}

type CaretLayer = ReturnType<typeof mountCaretLayer>;
const caretLayers = new WeakMap<EditorView, CaretLayer>();

class BodyCaretMarker extends RectangleMarker {
  private readonly position: CaretPosition;

  constructor(rect: RectangleMarker, private readonly layer: CaretLayer) {
    // Keep layout at an integral CSS coordinate. The paint transform can then
    // snap both edges to screen pixels without a fractional layout width.
    super(cursorClass, Math.floor(rect.left), rect.top, screenPixelWidth, rect.height);
    const origin = layer.dom.getBoundingClientRect().left;
    this.position = {
      viewportAnchor: origin + rect.left,
      viewportLayoutLeft: origin + this.left
    };
  }

  override eq(previous: BodyCaretMarker): boolean {
    return super.eq(previous)
      && this.position.viewportAnchor === previous.position.viewportAnchor
      && this.position.viewportLayoutLeft === previous.position.viewportLayoutLeft;
  }

  override draw(): HTMLDivElement {
    const cursor = super.draw();
    this.layer.paint(cursor, this.position);
    return cursor;
  }

  override update(cursor: HTMLElement, previous: BodyCaretMarker): boolean {
    if (!super.update(cursor, previous)) return false;
    this.layer.paint(cursor, this.position);
    return true;
  }
}

// Project the insertion point through CodeMirror's existing measurement cycle.
// The browser still owns the editable DOM selection and text input.
export const bodyCaret = layer({
  above: true,
  class: 'cm-cursorLayer',
  mount(dom, view) {
    caretLayers.set(view, mountCaretLayer(dom));
  },
  destroy(_dom, view) {
    caretLayers.get(view)?.dispose();
    caretLayers.delete(view);
  },
  markers(view) {
    const range = view.state.selection.main;
    if (!view.hasFocus || !range.empty) return [];
    const owner = caretLayers.get(view)!;
    return RectangleMarker.forRange(view, cursorClass, range)
      .map(rect => new BodyCaretMarker(rect, owner));
  },
  update(update, dom) {
    const moved = update.selectionSet || update.docChanged;
    if (moved) dom.style.animationName = dom.style.animationName === 'cm-blink' ? 'cm-blink2' : 'cm-blink';
    return moved || update.focusChanged || update.viewportChanged;
  }
});
