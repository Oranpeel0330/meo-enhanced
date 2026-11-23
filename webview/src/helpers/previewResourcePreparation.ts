/** Decode away from the reading layout; the viewport owner admits replacement. */
export function decodePreviewImage(image: HTMLImageElement, source: string, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      image.onload = image.onerror = null;
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => { finish(); image.removeAttribute('src'); };
    if (signal.aborted) { abort(); return; }
    image.onload = () => { void image.decode().catch(() => undefined).then(finish); };
    image.onerror = finish;
    signal.addEventListener('abort', abort, { once: true });
    image.src = source;
  });
}

/** Bounded results for the existing Preview data window. Image decoding and
 * HTML URL resolution share capacity/lifetime without mounting reading DOM. */
export function createPreviewResourcePreparation(document: Document, options: {
  signal: AbortSignal;
  resolveImage(source: string, signal: AbortSignal): Promise<string>;
  resolveHtml(source: string, signal: AbortSignal): Promise<string | null>;
  changed(): void;
}) {
  type Result = { image?: HTMLImageElement; source?: string } | null;
  type Entry = { result: Promise<Result>; pending: boolean; preload?: HTMLLinkElement };
  const entries = new Map<string, Entry>();
  let pending = 0;
  options.signal.addEventListener('abort', () => {
    for (const entry of entries.values()) entry.preload?.remove();
  }, { once: true });
  const prepare = (key: string, run: () => Promise<Result>): boolean => {
    if (entries.has(key)) return true;
    if (options.signal.aborted || pending >= 2) return false;
    while (entries.size >= 8) {
      const oldest = [...entries].find(([, entry]) => !entry.pending);
      if (!oldest) return false;
      oldest[1].preload?.remove();
      entries.delete(oldest[0]);
    }
    pending++;
    const entry: Entry = { pending: true, result: Promise.resolve(null) };
    entry.result = run().catch(() => null).finally(() => {
      entry.pending = false; pending--;
      if (!options.signal.aborted) options.changed();
    });
    entries.set(key, entry);
    return true;
  };
  return {
    prepareImage(source: string): boolean {
      return prepare('image:' + source, async () => {
        const resolved = await options.resolveImage(source, options.signal);
        if (!resolved || options.signal.aborted) return null;
        const image = document.createElement('img');
        image.loading = 'eager';
        await decodePreviewImage(image, resolved, options.signal);
        return !options.signal.aborted && image.naturalWidth > 0 ? { image } : null;
      });
    },
    takeImage(source: string): Promise<HTMLImageElement | null> | undefined {
      const key = 'image:' + source, entry = entries.get(key);
      entries.delete(key);
      return entry?.result.then(value => value?.image ?? null);
    },
    prepareHtml(source: string, preloadImage: boolean): boolean {
      const key = 'html:' + source;
      if (!prepare(key, async () => ({ source: await options.resolveHtml(source, options.signal) ?? '' }))) return false;
      const entry = entries.get(key)!;
      if (preloadImage && !entry.preload) {
        const preload = document.createElement('link');
        preload.rel = 'preload';
        preload.as = 'image';
        entry.preload = preload;
        void entry.result.then(result => {
          if (!result?.source || options.signal.aborted || entries.get(key) !== entry) return;
          preload.href = result.source;
          document.head.append(preload);
        });
      }
      return true;
    },
    async resolveHtml(source: string, signal: AbortSignal): Promise<string | null> {
      const cached = entries.get('html:' + source);
      const result = cached ? (await cached.result)?.source : await options.resolveHtml(source, signal);
      return signal.aborted ? null : result ?? null;
    }
  };
}
