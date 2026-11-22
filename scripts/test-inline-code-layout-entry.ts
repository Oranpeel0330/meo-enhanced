import { createEditor } from './test-editor-factory';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { setImageSrcResolver } from '../webview/src/helpers/images';
import { usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';

(globalThis as typeof globalThis & {
  InlineCodeLayoutHarness?: {
    createEditor: typeof createEditor;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
    setImageSrcResolver: typeof setImageSrcResolver;
    usesLargeDocumentDerivedWorkBudget: typeof usesLargeDocumentDerivedWorkBudget;
  };
}).InlineCodeLayoutHarness = { createEditor, applyBuiltInVisualBaseline, setImageSrcResolver, usesLargeDocumentDerivedWorkBudget };
