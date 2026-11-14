import sharp from 'sharp';

export type ReadingPaint = { data: Uint8Array; width: number; height: number; scale: number };
export async function decodeReadingPaint(jpeg: string): Promise<ReadingPaint> {
  const source = Buffer.from(jpeg, 'base64'), metadata = await sharp(source).metadata();
  const { data, info } = await sharp(source).resize({ width: 640 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, scale: info.width / metadata.width! };
}

/** Match stable body ink across compositor frames, excluding chrome/gutter.
 * Confidence rejects blank images, repeated rows and ambiguous scene changes. */
export function readingPaintShift(before: ReadingPaint, after: ReadingPaint) {
  if (before.width !== after.width || before.height !== after.height) return null;
  const { width, height, scale } = before, top = Math.ceil(48 * scale), bottom = height - Math.ceil(12 * scale);
  const features: { x: number; y: number; value: number }[] = [];
  for (let y = top; y < bottom; y += 2) for (let x = Math.ceil(76 * scale); x < width - Math.ceil(140 * scale); x += 2) {
    const value = before.data[y * width + x]!;
    if (value > 85 && Math.abs(value - before.data[y * width + x + 2]!) > 25) features.push({ x, y, value });
  }
  const candidates: { dy: number; score: number; count: number }[] = [];
  for (let dy = -Math.ceil(400 * scale); dy <= Math.ceil(400 * scale); dy++) {
    let count = 0, score = 0;
    for (const feature of features) {
      const y = feature.y + dy;
      if (y < top || y >= bottom) continue;
      count++; score += Math.min(1, Math.abs(feature.value - after.data[y * width + feature.x]!) / 100);
    }
    if (count >= Math.max(60, features.length * .5)) candidates.push({ dy, score: score / count, count });
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  if (!best) return null;
  const second = candidates.find(candidate => Math.abs(candidate.dy - best.dy) > 3);
  return { dy: best.dy / scale, score: best.score, margin: (second?.score ?? 1) - best.score, features: best.count };
}
