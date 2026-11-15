import { createEditor } from './test-editor-factory';
import { applyBuiltInVisualBaseline } from '../webview/src/helpers/theme';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';

(globalThis as typeof globalThis & {
  KbdAppearanceHarness?: {
    createEditor: typeof createEditor;
    applyBuiltInVisualBaseline: typeof applyBuiltInVisualBaseline;
    applyUiTheme: typeof applyUiTheme;
  };
}).KbdAppearanceHarness = { createEditor, applyBuiltInVisualBaseline, applyUiTheme };
