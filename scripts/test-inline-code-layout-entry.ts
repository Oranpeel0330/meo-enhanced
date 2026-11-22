import { createEditor } from './test-editor-factory';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { setImageSrcResolver } from '../webview/src/helpers/images';

(globalThis as typeof globalThis & {
  InlineCodeLayoutHarness?: {
    createEditor: typeof createEditor;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
    setImageSrcResolver: typeof setImageSrcResolver;
  };
}).InlineCodeLayoutHarness = { createEditor, applyBuiltInVisualBaseline, setImageSrcResolver };
