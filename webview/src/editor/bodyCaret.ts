import { layer, RectangleMarker } from '@codemirror/view';

const cursorClass = 'cm-cursor cm-cursor-primary';

// Project the insertion point through CodeMirror's existing measurement cycle.
// The browser still owns the editable DOM selection and text input.
export const bodyCaret = layer({
  above: true,
  class: 'cm-cursorLayer',
  markers(view) {
    const range = view.state.selection.main;
    if (!view.hasFocus || !range.empty) return [];
    return RectangleMarker.forRange(view, cursorClass, range);
  },
  update(update, dom) {
    const moved = update.selectionSet || update.docChanged;
    if (moved) dom.style.animationName = dom.style.animationName === 'cm-blink' ? 'cm-blink2' : 'cm-blink';
    return moved || update.focusChanged || update.viewportChanged;
  }
});
