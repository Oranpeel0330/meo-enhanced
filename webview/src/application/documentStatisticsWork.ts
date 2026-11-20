import type { DocumentTextChange } from '../../../src/foundation/documentSnapshot';

// Limit admissions before flattening or posting a document revision. These
// bounds apply to automatic statistics, independently of the editing budget.
export const maximumStatisticsDocumentLength = 4 * 1024 * 1024;
export const maximumStatisticsBlockLength = 512 * 1024;
export const maximumStatisticsBlocks = 32_768;
export const maximumStatisticsSelections = 8_192;
export const maximumStatisticsChanges = 8_192;

export type StatisticsSelection = Readonly<{ from: number; to: number }>;
export type StatisticsRequest = Readonly<{
  id: number;
  text?: string;
  changes?: readonly DocumentTextChange[];
  selections: readonly StatisticsSelection[];
  line: number | null;
  hasSelection?: boolean;
}>;
