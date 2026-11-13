import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

const assets = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
  await new Promise(resolve => setTimeout(resolve, 180));
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#35678a"/><text x="25" y="100" fill="white">Prepared reading image</text></svg>',
    { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
} });
const paragraph = (id: string) => `Reading ${id}. ${'Stable reading text with **emphasis** and 中文. '.repeat(5)}\n\n`;
const fixture = (large: boolean) => Array.from({ length: 24 }, (_, index) => paragraph(`opening-${index}`)).join('')
  + Array.from({ length: 8 }, (_, index) => [
    `## Section ${index}`, '', paragraph(`before-${index}`),
    '```python', `# LIVE_CODE_${index}`, `def compute_${index}(value: int):`,
    ...Array.from({ length: 12 }, (_, row) => `    value = value + ${row}  # calculation`), '    return value', '```', '',
    `![LIVE_IMAGE_${index}](${assets.url}image/${index})`, '',
    '$$', `\\text{LIVEMATH${index}}+\\frac{x^2+1}{y}=\\sqrt{z}`, '$$', '',
    '| Kind | Value |', '| --- | ---: |', `| LIVE_TABLE_${index} | 42 |`, '', `<div>LIVE_HTML_${index} <b>reading text</b></div>`, '',
    paragraph(`after-${index}`)
  ].join('\n')).join('\n') + (large ? '\n' + 'Distant paragraph.\n\n'.repeat(9_000)
    + '\n\n```python\n# LIVE_CODE_99\nnever_prepare_this_distant_code = True\n```\n\n' + `![Distant](${assets.url}image/99)` : '');
type Target = { kind: string; id: string; position: number };
type Sample = { time: number; scrolling: boolean; visible: (Target & { ready: boolean })[] };
const reports: unknown[] = [];
let primary: unknown;
try {
  for (const large of [false, true]) {
    const text = fixture(large);
    assert.equal(assessLargeDocument(text).boundedEditorWork, large);
    const targets: Target[] = [...text.matchAll(/LIVE_(CODE|IMAGE|TABLE|HTML)_(\d+)|LIVEMATH(\d+)/g)].map(match => ({
      kind: match[3] ? 'math' : match[1]!.toLowerCase(), id: match[3] ?? match[2]!, position: match.index
    }));
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      const scope = window as any, NativeWorker = Worker;
      scope.__livePreparation = { active: true, scrolling: false, samples: [], requests: [], wheels: [] };
      scope.Worker = class extends NativeWorker {
        postMessage(data: any, ...args: any[]) {
          const id = data?.lang === 'python' && data?.code?.match(/LIVE_CODE_(\d+)/)?.[1];
          if (id) scope.__livePreparation.requests.push({ id, time: performance.now(), cold: data.grammars?.length > 0 });
          return (NativeWorker.prototype.postMessage as any).call(this, data, ...args);
        }
      };
    });
    const host = await open(page, text, false, 'live', { resolveImageSrc: source => source });
    try {
      const point = await page.evaluate(targets => {
        const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view, p = (window as any).__livePreparation;
        const wheel = (event: WheelEvent) => p.wheels.push(event.isTrusted);
        view.scrollDOM.addEventListener('wheel', wheel, { passive: true });
        p.stop = () => { p.active = false; view.scrollDOM.removeEventListener('wheel', wheel); };
        const sample = () => {
          if (!p.active) return;
          const bounds = view.scrollDOM.getBoundingClientRect(), visible: (Target & { ready: boolean })[] = [];
          for (const target of targets) {
            const block = view.lineBlockAt(target.position), top = view.documentTop + block.top;
            if (top >= bounds.bottom - 8 || top + block.height <= bounds.top + 8) continue;
            let ready = false;
            if (target.kind === 'code') {
              const line = [...view.dom.querySelectorAll<HTMLElement>('.cm-line')].find(line => line.textContent?.includes(`LIVE_CODE_${target.id}`));
              ready = !!line && [...line.querySelectorAll<HTMLElement>('span[style]')].some(span => !!span.style.color && !span.style.color.includes('var('));
            } else if (target.kind === 'image') {
              ready = [...view.dom.querySelectorAll<HTMLImageElement>('.meo-md-image img')].some(image => image.src.includes(`/image/${target.id}`) && image.complete && image.naturalWidth > 1);
            } else if (target.kind === 'math') {
              ready = [...view.dom.querySelectorAll('.katex-html')].some(node => {
                try { return Math.abs(view.posAtDOM(node) - target.position) < 80; } catch { return false; }
              });
            } else {
              const line = view.state.doc.lineAt(target.position).number;
              const element = view.dom.querySelector(`[data-meo-rendered-block-start-line="${target.kind === 'table' ? line - 2 : line}"]`);
              ready = target.kind === 'table' ? !!element?.querySelector('td') : !!element?.querySelector('.meo-md-html-content');
            }
            visible.push({ ...target, ready });
          }
          p.samples.push({ time: performance.now(), scrolling: p.scrolling, visible });
          requestAnimationFrame(sample);
        };
        p.scrolling = true; sample();
        const bounds = view.scrollDOM.getBoundingClientRect();
        return { x: bounds.left + bounds.width * 0.7, y: bounds.top + bounds.height * 0.5 };
      }, targets);
      await page.mouse.move(point.x, point.y);
      // Start cold and keep native motion; never wait for a language or image.
      for (let index = 0; index < 48; index++) {
        await page.mouse.wheel({ deltaY: 230 });
        await page.waitForFunction(count => (window as any).__livePreparation.wheels.length === count, {}, index + 1);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      await page.evaluate(() => { (window as any).__livePreparation.scrolling = false; });
      const result = await page.evaluate(() => { const p = (window as any).__livePreparation; p.stop(); return p; }) as {
        samples: Sample[]; requests: { id: string; time: number; cold: boolean }[]; wheels: boolean[];
      };
      const entries = targets.map(target => {
        const visible = result.samples.filter(sample => sample.scrolling && sample.visible.some(item => item.kind === target.kind && item.id === target.id));
        const ready = visible.filter(sample => sample.visible.some(item => item.kind === target.kind && item.id === target.id && item.ready));
        return { ...target, frames: visible.length, ready: ready.length, firstVisible: visible[0]?.time,
          delay: ready.length ? ready[0]!.time - visible[0]!.time : null };
      }).filter(entry => entry.frames >= 8);
      reports.push({ large, entries, requests: result.requests });
      fs.mkdirSync('.local/test-artifacts/live-resource-preparation', { recursive: true });
      fs.writeFileSync('.local/test-artifacts/live-resource-preparation/latest.json', JSON.stringify(reports, null, 2));
      assert.equal(result.wheels.length, 48); assert.ok(result.wheels.every(Boolean));
      for (const kind of ['code', 'image', 'math', 'table', 'html']) assert.ok(entries.filter(entry => entry.kind === kind).length >= 5, `${large}/${kind}: actual viewport crossings required`);
      for (const entry of entries) {
        assert.ok(entry.ready >= 3 && entry.delay !== null && entry.delay <= 80,
          `${large}/${entry.kind}:${entry.id}: cold content waited through continuous reading: ${JSON.stringify(entry)}`);
      }
      const cold = result.requests.find(request => request.cold);
      assert.ok(cold && cold.time < entries.find(entry => entry.kind === 'code' && entry.id === cold.id)!.firstVisible!, 'Cold Worker preparation must start before first entry');
      assert.ok(!result.requests.some(request => request.id === '99'), 'Preparation must stay inside the data window');
      assert.equal(host.readHost(), text); assert.deepEqual(host.errors, []);
      await page.screenshot({ path: `.local/test-artifacts/live-resource-preparation/${large ? 'large' : 'ordinary'}.png` });
      console.log(JSON.stringify({ large, crossings: entries.length, maximumDelay: Math.max(...entries.map(entry => entry.delay!)) }));
    } finally { host.dispose(); await page.close(); }
  }
} catch (error) { primary = error; throw error; }
finally { assets.stop(true); server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
