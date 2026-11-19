import './browser-page-identity-test-helpers';
import '../webview/src/index';
import { EditorView } from '@codemirror/view';
import { syntaxParserRunning } from '@codemirror/language';
import { sourceSyntaxPreparation } from '../webview/src/helpers/sourceSyntax';
import { isLiveInputDerivedWorkPending, isLiveInputDerivedWorkReady, usesLargeDocumentDerivedWorkBudget } from '../webview/src/editor/liveInputDerivedWork';
import { builtinShortcutConflicts, changeEditingPreferences, shortcutReplacements, ShortcutConflictsChangedError } from '../src/application/editingPreferences';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { collectDocumentMathRanges } from '../webview/src/helpers/displayMathBlocks';
import { latexDelimitersFacet } from '../webview/src/editor/mathSyntaxPreference';
(window as any).EditingSettingsHarness = { EditorView, changeEditingPreferences, defaultInputAssistance, builtinShortcutConflicts, shortcutReplacements, ShortcutConflictsChangedError,
  collectDocumentMathRanges, latexDelimitersFacet,
  syntaxParserRunning, sourceSyntaxPreparation, isLiveInputDerivedWorkPending,
  isLiveInputDerivedWorkReady, usesLargeDocumentDerivedWorkBudget };
