/** Shared task marker syntax. The capture is a space or an x in either case. */
export const markdownTaskMarkerPattern = String.raw`\[([ xX])\]`;
export const markdownTaskContentPrefix = new RegExp(String.raw`^${markdownTaskMarkerPattern}(?:\s+|$)`);
