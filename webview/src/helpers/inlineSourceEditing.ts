export interface InlineEditRange {
  readonly from: number;
  readonly to: number;
}

/** A selection spanning sibling syntax leaves the rendered structure in place. */
export function inlineSourceContains(candidate: InlineEditRange, selection: InlineEditRange): boolean {
  return candidate.from <= selection.from && selection.to <= candidate.to;
}

export function inlineSourceTarget<T extends InlineEditRange>(
  candidates: readonly T[], selection: InlineEditRange, side = -1
): T | undefined {
  // Two siblings can touch the same caret stop. Keep the side from which the
  // caret arrived, then choose the smallest containing range on that side.
  const atEdge = selection.from === selection.to;
  const edge = selection.from;
  const preferred = atEdge && candidates.some(candidate => side < 0 ? candidate.to === edge : candidate.from === edge);
  let active: T | undefined;
  for (const candidate of candidates) {
    if (preferred && (side < 0 ? candidate.from === edge : candidate.to === edge)) continue;
    if (inlineSourceContains(candidate, selection) && (!active || candidate.to - candidate.from < active.to - active.from)) {
      active = candidate;
    }
  }
  return active;
}
