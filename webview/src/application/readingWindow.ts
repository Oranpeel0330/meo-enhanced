/** Nearby work follows viewport height, with a bounded lead even in very short
 * or tall panes. Keep DOM/resource admission in each existing presentation owner. */
export function readingPreparationMargin(height: number): number {
  return Math.ceil(Math.max(800, Math.min(1600, Number.isFinite(height) ? height : 800)));
}

export function readingPreparationRange(top: number, bottom: number) {
  const margin = readingPreparationMargin(bottom - top);
  return { from: top - margin, to: bottom + margin };
}

/** Visible resources share first priority, followed by the closest approach. */
export function readingResourceDistance(bounds: { top: number; bottom: number }, top: number, bottom: number): number {
  return Math.max(0, top - bounds.bottom, bounds.top - bottom);
}
