export type ShortcutSnippetPart = string | { variable: string; raw: string } | { field: number; initial?: string };
export const shortcutSnippetFinalField = 100;

export function parseShortcutSnippet(template: string): ShortcutSnippetPart[] {
  const tokens = /\\([$\\}])|\$\{(?:(\d{1,2})(?::([^{}\r\n]*))?|([A-Z_][A-Z_0-9]*))\}|\$(\d{1,2})(?!\d)|\$([A-Z_][A-Z_0-9]*)/g;
  const parts: ShortcutSnippetPart[] = [];
  let offset = 0;
  for (const match of template.matchAll(tokens)) {
    parts.push(template.slice(offset, match.index));
    const [raw, escaped, field, initial, variable, shortField, shortVariable] = match;
    const name = variable ?? shortVariable;
    if (escaped) parts.push(escaped);
    else if (name) parts.push({ variable: name, raw });
    else parts.push({ field: Number(field ?? shortField) || shortcutSnippetFinalField, initial });
    offset = match.index + raw.length;
  }
  parts.push(template.slice(offset));
  return parts;
}

export function shortcutSnippetSupportsTable(parts: readonly ShortcutSnippetPart[]): boolean {
  let finalCursor = false;
  for (const part of parts) {
    if (typeof part === 'string' || !('field' in part)) continue;
    if (part.field !== shortcutSnippetFinalField || part.initial !== undefined || finalCursor) return false;
    finalCursor = true;
  }
  return true;
}
