export const DEFAULT_EDITOR_CONTENT_WIDTH = 1200;
export const EDITOR_CONTENT_WIDTH_MIN = 400;
export const EDITOR_CONTENT_WIDTH_MAX = 2400;
export const EDITOR_CONTENT_WIDTH_STEP = 100;

export function isEditorContentWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= EDITOR_CONTENT_WIDTH_MIN && value <= EDITOR_CONTENT_WIDTH_MAX;
}

export function normalizeEditorContentWidth(value: unknown): number {
  return isEditorContentWidth(value) ? value : DEFAULT_EDITOR_CONTENT_WIDTH;
}
