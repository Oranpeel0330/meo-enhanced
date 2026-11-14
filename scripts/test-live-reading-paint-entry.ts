import { StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { createEditor } from './test-editor-factory';
import { getLivePresentationBand, isLiveViewportPlaceholder, isLiveViewportPresentationEffect,
  restrictLiveWidgetPresentation } from '../webview/src/helpers/liveViewportPresentation';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';

/** Controlled prepared resource: production windowing owns when its current
 * geometry replaces the immutable offscreen estimate. No scroll is simulated. */
class PreparedResource extends WidgetType {
  constructor(readonly height: number) { super(); }
  get estimatedHeight() { return this.height; }
  eq(other: WidgetType) { return other instanceof PreparedResource && other.height === this.height; }
  toDOM() {
    const element = document.createElement('div');
    element.style.cssText = 'height:120px;background:#33546b;color:white;padding:0;';
    element.textContent = 'Complete prepared reading resource';
    return element;
  }
}

(window as any).LiveReadingPaintHarness = {
  create(lines: number) {
    let refined = false, hydrated = 0;
    const text = Array.from({ length: lines }, (_, i) => {
      let seed = i + 1;
      const words = Array.from({ length: 48 }, () => {
        seed = Math.imul(seed, 1664525) + 1013904223 | 0;
        return 'abcdefghijklmnopqrstuvwxyz'[(seed >>> 0) % 26];
      }).join('');
      return `Reading line ${i + 1}: ${words}`;
    }).join('\n');
    const editor = createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
    const view = editor.view, from = view.state.doc.line(220).from, to = view.state.doc.line(224).to;
    const build = (state: typeof view.state): DecorationSet => {
      const ranges = [Decoration.replace({ widget: new PreparedResource(refined ? 120 : 300), block: true }).range(from, to)];
      restrictLiveWidgetPresentation(ranges, state);
      return Decoration.set(ranges);
    };
    const resources = StateField.define<DecorationSet>({
      create: build,
      update(value, transaction) {
        if (!transaction.effects.some(isLiveViewportPresentationEffect)) return value;
        const band = getLivePresentationBand(transaction.state);
        const inside = !!band && to >= band.from && from <= band.to;
        let placeholder = false;
        value.between(from, to, (_from, _to, decoration) => { placeholder = isLiveViewportPlaceholder(decoration.spec.widget); });
        if (placeholder && !inside) return value;
        if (placeholder && inside && refined) hydrated++;
        return build(transaction.state);
      },
      provide: field => EditorView.decorations.from(field)
    });
    view.dispatch({ effects: StateEffect.appendConfig.of(resources), annotations: Transaction.addToHistory.of(false) });
    const snapshot = () => {
      let placeholder = false;
      view.state.field(resources).between(from, to, (_from, _to, decoration) => { placeholder = isLiveViewportPlaceholder(decoration.spec.widget); });
      return { large: usesLargeDocumentDerivedWorkBudget(view.state), placeholder, hydrated,
        head: view.state.selection.main.head, length: view.state.doc.length, viewportEnd: view.viewport.to,
        top: view.scrollDOM.scrollTop, band: getLivePresentationBand(view.state), unchanged: editor.getText() === text };
    };
    (window as any).__readingPaint = { editor, snapshot, refine() { refined = true; }, destroy() { editor.destroy(); } };
    return snapshot();
  }
};
