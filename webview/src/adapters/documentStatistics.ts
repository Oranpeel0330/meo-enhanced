import { readDocumentText, type DocumentText, type DocumentTextEdit } from '../../../src/foundation/documentSnapshot';
import type { DocumentStatisticsMessage } from '../../../src/protocol/documentStatistics';
import type { StatisticsResponse } from './documentStatisticsIndex';
import {
  maximumStatisticsChanges, maximumStatisticsDocumentLength, maximumStatisticsSelections,
  type StatisticsRequest, type StatisticsSelection
} from '../application/documentStatisticsWork';

const statisticsTimeoutMs = 10_000;
const maximumQueuedEdits = 32;

type StatisticsInput = {
  text: DocumentText;
  selections: readonly StatisticsSelection[];
  lines: number;
  line: number | null;
  hasSelection?: boolean;
};

export function createDocumentStatisticsReporter(
  read: () => StatisticsInput | null,
  post: (message: DocumentStatisticsMessage) => void
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let worker: Worker | undefined, loading: Promise<void> | undefined;
  let workerLoad: AbortController | undefined;
  let sentText: DocumentText | undefined, failedText: DocumentText | undefined;
  let flight: { id: number; state: StatisticsInput } | undefined;
  let edits: DocumentTextEdit[] = [];
  let generation = 0, lifecycle = 0, visible = true, disposed = false;
  const resetWorker = () => {
    lifecycle++;
    workerLoad?.abort(); workerLoad = undefined; loading = undefined;
    worker?.terminate(); worker = undefined; sentText = undefined; flight = undefined;
    edits = []; clearTimeout(deadline);
  };
  const limited = ({ lines, line }: StatisticsInput) => post({
    type: 'documentStatistics', statistics: { lines, line: line === null ? null : Math.min(line, lines), wordCountStatus: 'limited' }
  });
  const queue = () => {
    clearTimeout(timer);
    if (visible && !disposed) timer = setTimeout(() => void run(), 180);
  };
  const fail = (id: number, state: StatisticsInput) => {
    failedText = state.text;
    resetWorker();
    if (id === generation) limited(state);
    else queue();
  };
  const load = async () => {
    const owner = lifecycle, controller = workerLoad = new AbortController();
    const uri = document.body.dataset.meoStatisticsWorkerSrc;
    if (!uri) throw new Error('Statistics worker URI missing');
    const response = await fetch(uri, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) throw new Error('Statistics worker unavailable');
    const source = await response.text();
    if (owner !== lifecycle) return;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    let current: Worker;
    try { current = new Worker(url); } finally { URL.revokeObjectURL(url); }
    worker = current;
    current.onerror = event => {
      event.preventDefault();
      if (worker === current && flight) fail(flight.id, flight.state);
    };
    current.onmessageerror = () => { if (worker === current && flight) fail(flight.id, flight.state); };
    current.onmessage = ({ data }: MessageEvent<StatisticsResponse>) => {
      if (worker !== current || flight?.id !== data.id) return;
      const { state } = flight;
      if (data.reset) { fail(data.id, state); return; }
      clearTimeout(deadline); flight = undefined;
      if (data.id !== generation) { queue(); return; }
      if (data.statistics) post({ type: 'documentStatistics', statistics: data.statistics });
      else limited(state);
    };
  };
  const run = async () => {
    timer = undefined;
    if (disposed || !visible) return;
    const state = read(); if (!state) return;
    if (state.text.length > maximumStatisticsDocumentLength) {
      if (worker || loading) resetWorker();
      failedText = undefined;
      limited(state);
      return;
    }
    if (state.selections.length > maximumStatisticsSelections || failedText === state.text) {
      limited(state);
      return;
    }
    failedText = undefined;
    if (flight) return;
    const id = generation;
    const owner = lifecycle;
    try {
      if (!worker) {
        loading ??= load().finally(() => { if (owner === lifecycle) { loading = undefined; workerLoad = undefined; } });
        await loading;
      }
      if (owner !== lifecycle || !worker || flight) return;
      if (id !== generation) { queue(); return; }
      const composed = edits[0]?.before === sentText && edits.at(-1)?.after === state.text
        ? edits.reduce((acc, edit) => acc.compose(edit)).changes : undefined;
      const update = composed && composed.length <= maximumStatisticsChanges ? composed : undefined;
      const text = state.text !== sentText && !update ? readDocumentText(state.text) : undefined;
      const { selections, hasSelection } = state;
      const line = state.line === null ? null : Math.min(state.line, state.lines);
      worker.postMessage({ id, text, changes: update, selections, line, hasSelection } satisfies StatisticsRequest);
      sentText = state.text; edits = []; flight = { id, state };
      deadline = setTimeout(() => fail(id, state), statisticsTimeoutMs);
    } catch { if (owner === lifecycle) fail(id, state); }
  };
  return {
    schedule() { generation++; queue(); },
    recordEdit(edit: DocumentTextEdit) {
      // Keep inexpensive receipts on the input path. Compose and serialize only
      // the edits observed for a revision the worker can actually reuse.
      if (visible && sentText !== undefined && edit.after.length <= maximumStatisticsDocumentLength
        && (edits.at(-1)?.after ?? sentText) === edit.before && edits.length < maximumQueuedEdits) edits.push(edit);
      else edits = [];
    },
    setVisible(next: boolean) {
      if (disposed || visible === next) return;
      visible = next;
      if (!visible) { clearTimeout(timer); resetWorker(); }
      else queue();
    },
    dispose() { disposed = true; clearTimeout(timer); resetWorker(); }
  };
}
