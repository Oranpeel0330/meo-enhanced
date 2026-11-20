export type DocumentStatistics = {
  readonly words: number;
  readonly selectedWords: number;
  readonly hasSelection: boolean;
  readonly lines: number;
  readonly line: number | null;
  readonly characters: number;
};
export type DocumentStatisticsPosition = Pick<DocumentStatistics, 'lines' | 'line'> & {
  readonly wordCountStatus: 'limited';
};
export type DocumentStatisticsReport = DocumentStatistics | DocumentStatisticsPosition;

export type DocumentStatisticsMessage = {
  readonly type: 'documentStatistics';
  readonly statistics: DocumentStatisticsReport | null;
};
export function decodeDocumentStatistics(value: unknown): DocumentStatisticsMessage | null {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'documentStatistics'
    || !('statistics' in value)) return null;
  const s = value.statistics;
  if (s === null) return { type: 'documentStatistics', statistics: null };
  if (!s || typeof s !== 'object') return null;
  const data = s as Record<string, unknown>;
  const { lines, line } = data;
  if (typeof lines !== 'number' || !Number.isSafeInteger(lines) || lines < 1
    || !(line === null || typeof line === 'number' && Number.isSafeInteger(line) && line >= 1 && line <= lines)) return null;
  if (data.wordCountStatus === 'limited') {
    return { type: 'documentStatistics', statistics: { lines, line, wordCountStatus: 'limited' } };
  }
  for (const key of ['words', 'selectedWords', 'characters']) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) return null;
  }
  if ((data.selectedWords as number) > (data.words as number) || typeof data.hasSelection !== 'boolean'
    || 'wordCountStatus' in data) return null;
  return { type: 'documentStatistics', statistics: s as DocumentStatistics };
}
