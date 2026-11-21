import { createEditor } from './test-editor-factory';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';

(globalThis as typeof globalThis & {
  HtmlBreakRenderingHarness?: {
    createEditor: typeof createEditor;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
  };
}).HtmlBreakRenderingHarness = { createEditor, applyBuiltInVisualBaseline };
