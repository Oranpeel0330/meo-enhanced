import { createEditor } from './test-editor-factory';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';

(globalThis as typeof globalThis & {
  HtmlBreakRenderingHarness?: {
    createEditor: typeof createEditor;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
    usesLargeDocumentDerivedWorkBudget: typeof usesLargeDocumentDerivedWorkBudget;
  };
}).HtmlBreakRenderingHarness = { createEditor, applyBuiltInVisualBaseline, usesLargeDocumentDerivedWorkBudget };
