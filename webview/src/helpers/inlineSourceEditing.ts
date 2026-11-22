export interface InlineEditRange {
  readonly from: number;
  readonly to: number;
}

/** A selection spanning sibling syntax leaves the rendered structure in place. */
export function inlineSourceContains(candidate: InlineEditRange, selection: InlineEditRange): boolean {
  return selection.from === selection.to
    ? candidate.from < selection.from && selection.to < candidate.to
    : candidate.from <= selection.from && selection.to <= candidate.to;
}

export function innermostInlineSource<T extends InlineEditRange>(
  candidates: Iterable<T>, selection: InlineEditRange
): T | undefined {
  let active: T | undefined;
  for (const candidate of candidates) {
    if (inlineSourceContains(candidate, selection) && (!active || candidate.to - candidate.from < active.to - active.from)) {
      active = candidate;
    }
  }
  return active;
}
