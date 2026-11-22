import { layer, RectangleMarker, type EditorView } from '@codemirror/view';

const caretDeviceWidth = 2;
const cursorClass = 'cm-cursor cm-cursor-primary';

type CaretPosition = { readonly viewportAnchor: number; readonly viewportLayoutLeft: number };

function mountCaretLayer(dom: HTMLElement) {
  const win = dom.ownerDocument.defaultView!;
  let position: CaretPosition | undefined;
  let ratio = 0;
  let resolution: MediaQueryList | undefined;
  const paint = (cursor: HTMLElement, next: CaretPosition) => {
    position = next;
    const density = win.devicePixelRatio;
    const left = Math.round(next.viewportAnchor * density) / density;
    cursor.style.transform = `translateX(${left - next.viewportLayoutLeft}px) scaleX(${1 / density})`;
  };
  const updateResolution = () => {
    const nextRatio = win.devicePixelRatio;
    if (nextRatio === ratio) return;
    ratio = nextRatio;
    const cursor = dom.firstElementChild as HTMLElement | null;
    if (cursor && position) paint(cursor, position);
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

  constructor(rect: RectangleMarker, private readonly owner: CaretLayer) {
    // Leave subpixel placement to the paint transform so layout rounding cannot change the stroke width.
    super(cursorClass, Math.floor(rect.left), rect.top, caretDeviceWidth, rect.height);
    const origin = owner.dom.getBoundingClientRect().left;
    this.position = { viewportAnchor: origin + rect.left, viewportLayoutLeft: origin + this.left };
  }

  override eq(previous: BodyCaretMarker): boolean {
    return super.eq(previous)
      && this.position.viewportAnchor === previous.position.viewportAnchor
      && this.position.viewportLayoutLeft === previous.position.viewportLayoutLeft;
  }

  override draw(): HTMLDivElement {
    const cursor = super.draw();
    this.owner.paint(cursor, this.position);
    return cursor;
  }

  override update(cursor: HTMLElement, previous: BodyCaretMarker): boolean {
    if (!super.update(cursor, previous)) return false;
    this.owner.paint(cursor, this.position);
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
    return RectangleMarker.forRange(view, cursorClass, range).map(rect => new BodyCaretMarker(rect, owner));
  },
  update(update, dom) {
    const moved = update.selectionSet || update.docChanged;
    if (moved) dom.style.animationName = dom.style.animationName === 'cm-blink' ? 'cm-blink2' : 'cm-blink';
    return moved || update.focusChanged || update.viewportChanged;
  }
});
