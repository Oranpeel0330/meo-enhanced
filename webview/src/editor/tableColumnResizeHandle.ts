export const tableColumnResizeHighlightPrefix = '--meo-table-resize-column-';

export function tableColumnResizeHighlightProperty(column: string | number): string {
  return `${tableColumnResizeHighlightPrefix}${column}`;
}

export function createTableColumnResizeHandle(column: number): HTMLSpanElement {
  const handle = document.createElement('span');
  handle.className = 'meo-md-html-table-column-resize-handle';
  handle.dataset.tableResizeColumn = String(column);
  handle.setAttribute('aria-hidden', 'true');
  // Cloned header cells and newly mounted rows inherit the same column highlight.
  handle.style.setProperty('--meo-table-resize-highlight', `var(${tableColumnResizeHighlightProperty(column)}, none)`);
  return handle;
}
