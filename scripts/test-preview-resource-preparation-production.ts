import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

const requests: string[] = [], resolutions: string[] = [];
let heldImage = Promise.resolve(), releaseHeldImage = () => {};
const assets = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  requests.push(new URL(request.url).pathname);
  if (new URL(request.url).pathname === '/held.svg') await heldImage;
  await new Promise(resolve => setTimeout(resolve, 180));
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260"><rect width="640" height="260" fill="#35678a"/><text x="30" y="120" fill="white">Prepared image</text></svg>',
    { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'Timing-Allow-Origin': '*' } });
} });
const paragraph = (id: string) => `Reading ${id}. ${'Stable prose with mixed 中文 text and **emphasis**. '.repeat(5)}\n\n`;
const fixture = (large: boolean) => Array.from({ length: 24 }, (_, index) => paragraph(`opening-${index}`)).join('')
  + Array.from({ length: 8 }, (_, index) => [
    `## Section ${index}`, '', paragraph(`before-${index}`),
    '```python', `# RESOURCE_CODE_${index}`, `def compute_${index}(value: int):`,
    ...Array.from({ length: 12 }, (_, line) => `    value = value + ${line}  # staged calculation`),
    '    return value', '```', '', `![RESOURCE_IMAGE_${index}](${assets.url}image/${index})`, '',
    '$$', `\\text{RESOURCEMATH${index}} + \\frac{x^2+1}{y}=\\sqrt{z}`, '$$', '',
    '| Kind | Value |', '| --- | ---: |', `| RESOURCE_TABLE_${index} | 42 |`, '',
    `<video data-resource-id="${index}" poster="poster-${index}.svg" width="640" height="260"></video>`, '',
    `<div>RESOURCE_HTML_${index} <b>rendered text</b></div>`, '', paragraph(`after-${index}`)
  ].join('\n')).join('\n') + (large ? '\n' + 'Distant plain paragraph.\n\n'.repeat(9_000)
    + `![Distant control](${assets.url}image/99)` : '');

type Sample = { time: number; scrolling: boolean; targets: { kind: string; id: string; ready: boolean }[] };
const reports: unknown[] = [];
let primaryError: unknown;
try {
  for (const large of [false, true]) {
    requests.length = resolutions.length = 0;
    const text = fixture(large);
    assert.equal(assessLargeDocument(text).windowedPreview, large);
    const page = await browser.newPage();
    const host = await open(page, text, false, 'preview', { resolveImageSrc: async source => {
      resolutions.push(source);
      if (!source.startsWith('poster-')) return source;
      await new Promise(resolve => setTimeout(resolve, 180));
      return `${assets.url}poster/${source}`;
    } });
    try {
      const point = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!;
        const probe = { active: true, scrolling: true, samples: [] as Sample[], mounted: {} as Record<string, number> };
        (window as any).__resourcePreparationProbe = probe;
        const sample = () => {
          if (!probe.active) return;
          const targets: Sample['targets'] = [];
          const collect = (node: Element, kind: string, id: string, ready: boolean) => {
            probe.mounted[`${kind}:${id}`] ??= performance.now();
            const bounds = node.getBoundingClientRect();
            if (bounds.height > 0 && bounds.top < doc.defaultView!.innerHeight - 8 && bounds.bottom > 8) targets.push({ kind, id, ready });
          };
          for (const code of doc.querySelectorAll('code.hljs')) {
            const id = code.textContent?.match(/RESOURCE_CODE_(\d+)/)?.[1];
            const rows = [...code.querySelectorAll<HTMLElement>('.meo-export-code-line-source')];
            if (id) collect(code, 'code', id, rows.length > 0 && rows.every(row => !!row.dataset.meoShiki));
          }
          for (const image of doc.images) {
            const id = image.alt.match(/RESOURCE_IMAGE_(\d+)/)?.[1];
            if (id) collect(image, 'image', id, image.complete && image.naturalWidth > 1 && !image.hasAttribute('data-meo-deferred-image-src'));
          }
          for (const formula of doc.querySelectorAll('.meo-export-math-display')) {
            const source = formula.getAttribute('data-source-b64');
            const id = source && atob(source).match(/RESOURCEMATH(\d+)/)?.[1];
            if (id) collect(formula, 'math', id, !!formula.querySelector('.katex-html'));
          }
          for (const poster of doc.querySelectorAll<HTMLVideoElement>('video[data-resource-id]')) {
            const fetched = doc.defaultView!.performance.getEntriesByName(poster.poster, 'resource')
              .some(entry => (entry as PerformanceResourceTiming).responseEnd > 0);
            collect(poster, 'poster', poster.dataset.resourceId!, poster.poster.includes('/poster/') && fetched);
          }
          probe.samples.push({ time: performance.now(), scrolling: probe.scrolling, targets });
          requestAnimationFrame(sample);
        };
        sample();
        const bounds = frame.getBoundingClientRect();
        return { x: bounds.right - 35, y: bounds.top + 180 };
      });
      await page.mouse.move(point.x, point.y);
      // Begin cold: no resource-ready wait before trusted, continuous wheels.
      for (let turn = 0; turn < 42; turn++) {
        await page.mouse.wheel({ deltaY: 230 });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await page.evaluate(() => { (window as any).__resourcePreparationProbe.scrolling = false; });
      await new Promise(resolve => setTimeout(resolve, 700));
      const observation = await page.evaluate(() => {
        const probe = (window as any).__resourcePreparationProbe; probe.active = false; return probe;
      }) as { samples: Sample[]; mounted: Record<string, number> };
      const moving = observation.samples.filter(sample => sample.scrolling);
      const keys = new Set(moving.flatMap(sample => sample.targets.map(target => `${target.kind}:${target.id}`)));
      const entries = [...keys].map(key => {
        const visible = moving.filter(sample => sample.targets.some(target => `${target.kind}:${target.id}` === key));
        const ready = visible.filter(sample => sample.targets.some(target => `${target.kind}:${target.id}` === key && target.ready));
        return { key, frames: visible.length, ready: ready.length, initialBlank: ready.length ? visible.indexOf(ready[0]!) : visible.length };
      }).filter(entry => entry.frames >= 8);
      for (const kind of ['code', 'image', 'math', 'poster']) {
        assert.ok(entries.filter(entry => entry.key.startsWith(kind + ':')).length >= 3, `${large}/${kind}: actual viewport crossings required`);
      }
      for (const entry of entries) {
        assert.ok(entry.ready >= 3, `${large}/${entry.key}: resource remained blank/uncolored during continuous reading: ${JSON.stringify(entry)}`);
        if (large && /^(code|image):/.test(entry.key)) assert.ok(entry.initialBlank <= 4, `${entry.key}: prepared content must arrive within four entry frames`);
      }
      for (const source of new Set(requests)) assert.equal(requests.filter(value => value === source).length, 1, `${source}: retained preparation restarted`);
      assert.ok(!requests.includes('/image/99'), 'distant content must not be prepared across the document');
      for (const source of new Set(resolutions)) assert.equal(resolutions.filter(value => value === source).length, 1, `${source}: retained resolution restarted`);
      assert.equal(host.readHost(), text);
      assert.deepEqual(host.errors, []);
      const screenshot = `.local/probes/preview-resource-preparation-${large ? 'windowed' : 'ordinary'}.png`;
      fs.mkdirSync('.local/probes', { recursive: true });
      await page.screenshot({ path: screenshot });
      reports.push({ large, entries, requests: [...requests], resolutions: resolutions.length, screenshot });
    } finally { host.dispose(); await page.close(); }
  }
  heldImage = new Promise<void>(resolve => { releaseHeldImage = resolve; });
  const page = await browser.newPage();
  const previous = `![Late control](${assets.url}held.svg)\n\n` + fixture(true);
  const host = await open(page, previous, false, 'preview', { resolveImageSrc: source => source });
  try {
    await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('img[alt="Late control"]'));
    const replacement = '# Replacement document\n\nThe current document owns every presentation.';
    await host.replaceHostText(replacement);
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('h1')?.textContent === 'Replacement document');
    releaseHeldImage();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await page.evaluate(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('img')), false,
      'late preparation from the retired frame cannot reappear');
    assert.equal(host.readHost(), replacement);
    assert.deepEqual(host.errors, []);
    reports.push({ replacement: 'retired preparation cancelled' });
  } finally { releaseHeldImage(); host.dispose(); await page.close(); }
  fs.writeFileSync('.local/probes/preview-resource-preparation-production.json', JSON.stringify(reports, null, 2));
  console.log('Preview resource preparation: cold native scroll, code/image/math/HTML, retained requests and ordinary/windowed documents passed');
} catch (error) { primaryError = error; throw error; }
finally {
  releaseHeldImage();
  assets.stop(true); server.stop(true);
  if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError);
}
