export interface ScrollEndRange {
  readonly start: number;
  readonly end: number;
}

export function scrollEndRange(scroll: Element, extraHeight: number): ScrollEndRange | null {
  const end = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  const start = Math.max(0, end - extraHeight);
  return end > start ? { start, end } : null;
}

export function scrollEndProgress(range: ScrollEndRange | null, top: number): number | null {
  return range && top > range.start ? Math.min(1, (top - range.start) / (range.end - range.start)) : null;
}

export function scrollEndTop(range: ScrollEndRange, progress: number): number {
  return range.start + progress * (range.end - range.start);
}
