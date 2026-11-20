import { createEditor } from './test-editor-factory';
import { createDocumentStatisticsReporter } from '../webview/src/adapters/documentStatistics';
import { documentSnapshot } from '../webview/src/adapters/documentSnapshot';
import type { StatisticsRequest } from '../webview/src/application/documentStatisticsWork';
import { getLivePresentationBand } from '../webview/src/helpers/liveViewportPresentation';

const scope = window as any;
const postWorkerRequest = Worker.prototype.postMessage;
Worker.prototype.postMessage = function(data, ...options) {
  if (Array.isArray(data?.selections)) {
    const request = data as StatisticsRequest;
    scope.statisticsRequests.push({ initial: request.text !== undefined, changes: request.changes });
    if (scope.holdNextStatistics) {
      scope.holdNextStatistics = false;
      scope.releaseStatistics = () => { Reflect.apply(postWorkerRequest, this, [data, ...options]); };
      return;
    }
  }
  Reflect.apply(postWorkerRequest, this, [data, ...options]);
};
scope.mountStatistics = (text: string) => {
  scope.editor?.destroy(); scope.reporter?.dispose();
  scope.statistics = null;
  scope.statisticsRequests = [];
  scope.holdNextStatistics = false;
  scope.releaseStatistics = undefined;
  let reporter: ReturnType<typeof createDocumentStatisticsReporter> | undefined;
  const editor = scope.editor = createEditor({ parent: document.querySelector('#app')!, text, initialMode: 'live',
    onApplyTransaction: edit => reporter?.recordEdit(edit), onStatisticsChange: () => reporter?.schedule(),
    onSelectionChange: selection => { scope.selectionMenu = selection; } });
  scope.statisticsPresentation = () => getLivePresentationBand(editor.view.state) ?? null;
  reporter = scope.reporter = createDocumentStatisticsReporter(() => ({ text: documentSnapshot(editor.view.state.doc),
    lines: editor.view.state.doc.lines,
    ...editor.readStatisticsSelection() }), message => {
    scope.statistics = message.statistics;
  });
  reporter.schedule();
};
