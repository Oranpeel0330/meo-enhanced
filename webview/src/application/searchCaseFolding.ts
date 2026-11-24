function lowerSameLength(text: string): string | null {
  const lower = text.toLocaleLowerCase();
  return lower.length === text.length ? lower : null;
}

/** Case folding for search. Match offsets are source offsets, so the folded
 * text must keep its length; lower-casing U+0130 or a locale rule may not. */
export function foldSearchCase(text: string): string {
  return lowerSameLength(text) ?? text.split('İ').map(part => lowerSameLength(part)
    ?? Array.from(part, character => lowerSameLength(character) ?? character).join('')).join('i');
}
