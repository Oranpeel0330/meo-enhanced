import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser } from './browser-test-helpers';

process.env.MEO_TEST_NATIVE_SMOOTH_SCROLLING = '1';
const { browser, server, open } = await import('./input-presentation-test-helpers');

const graph = ['flowchart LR', ...Array.from({ length: 5 }, (_, lane) => [
  `subgraph lane${lane}[Processing lane ${lane}]`, 'direction LR',
  ...Array.from({ length: 8 }, (_, step) => `N${lane}_${step}[Stage ${lane}.${step} validation]${step < 7 ? ` --> N${lane}_${step + 1}` : ''}`), 'end'
].join('\n')), ...Array.from({ length: 4 }, (_, lane) => `N${lane}_3 --> N${lane + 1}_4`)].join('\n');
const opening = Array.from({ length: 24 }, (_, i) => `Reading ${i}. ${'A stable paragraph of reading text. '.repeat(6)}\n\n`).join('');
const reports: unknown[] = [];
const modes = process.argv.includes('--source-only') ? ['source'] as const : ['live', 'preview', 'source'] as const;
let failure: unknown;
try {
  for (const mode of modes) for (const large of [false, true]) {
    const text = opening + `\n\n\`\`\`mermaid\n${graph}\n\`\`\`\n\nAFTER_GRAPH stable reading witness.\n\n`
      + 'Distant paragraph.\n\n'.repeat(large ? 9_000 : 80);
    const page = await browser.newPage();
    const host = await open(page, text, false, mode);
    try {
      if (mode === 'source') {
        await page.click('.source-preview-button');
        await page.waitForFunction(() => {
          const host = document.querySelector<HTMLElement>('.preview-host');
          return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview') && host && !host.hidden && !host.inert
            && getComputedStyle(host).visibility !== 'hidden'
            && !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc');
        });
      }
      const point = await page.evaluate(({ mode, position, after }) => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const doc = mode === 'live' ? document : frame.contentDocument!;
        const view = mode === 'live' ? (document.querySelector<any>('.editor-host .cm-content').cmTile.root.view) : null;
        const scroll = view?.scrollDOM ?? doc.scrollingElement!;
        const probe = { active: true, scrolling: true, samples: [] as any[], writes: [] as number[], wheels: 0,
          firstWheel: 0, tasks: [] as number[] };
        new PerformanceObserver(list => {
          if (probe.scrolling) for (const task of list.getEntries()) {
            if (probe.firstWheel > 0 && task.startTime >= probe.firstWheel) probe.tasks.push(task.duration);
          }
        }).observe({ entryTypes: ['longtask'] });
        (window as any).__mermaidReading = probe;
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
        Object.defineProperty(scroll, 'scrollTop', { configurable: true, get() { return descriptor.get!.call(this); },
          set(value) { if (probe.scrolling && probe.wheels > 0) probe.writes.push(value); descriptor.set!.call(this, value); } });
        doc.addEventListener('wheel', event => { if (event.isTrusted && !event.defaultPrevented) {
          probe.wheels++; probe.firstWheel ||= performance.now();
        } }, { passive: true });
        const sample = () => {
          if (!probe.active) return;
          const bounds = view?.scrollDOM.getBoundingClientRect();
          const height = bounds?.height ?? doc.defaultView!.innerHeight;
          const block = doc.querySelector(mode === 'live' ? '.meo-mermaid-block' : '.meo-export-mermaid');
          const box = block?.getBoundingClientRect();
          const top = mode === 'live' ? view.documentTop + view.lineBlockAt(position).top - bounds.top : box?.top;
          const blockHeight = mode === 'live' ? view.lineBlockAt(position).height : box?.height;
          const svg = doc.querySelector(mode === 'live' ? '.meo-mermaid-svg-wrapper svg' : '.meo-export-mermaid-svg svg');
          const viewportTop = bounds?.top ?? 0, viewportBottom = bounds?.bottom ?? height;
          const ready = !!svg && [...svg.querySelectorAll('.node')].some(node => {
            const rect = node.getBoundingClientRect();
            return rect.width > .5 && rect.height > .5 && rect.top < viewportBottom - 8 && rect.bottom > viewportTop + 8;
          });
          const witness = mode === 'live' ? view.documentTop + view.lineBlockAt(after).top + scroll.scrollTop
            : [...doc.querySelectorAll('p')].find(node => node.textContent?.includes('AFTER_GRAPH'))?.getBoundingClientRect().top! + scroll.scrollTop;
          probe.samples.push({ time: performance.now(), visible: top !== undefined && top < height - 8 && top + (blockHeight ?? 0) > 8,
            ready, top: scroll.scrollTop, witness, scrolling: probe.scrolling, boxHeight: box?.height,
            held: block?.classList.contains('meo-reading-size-held') });
          requestAnimationFrame(sample);
        };
        sample();
        const bounds = mode === 'live' ? view.scrollDOM.getBoundingClientRect() : frame.getBoundingClientRect();
        return { x: bounds.left + bounds.width * .65, y: bounds.top + 180 };
      }, { mode, position: text.indexOf('```mermaid'), after: text.indexOf('AFTER_GRAPH') });
      await page.mouse.move(point.x, point.y);
      // Deliberately no idle/readiness wait before the first trusted wheel.
      for (let i = 0; i < 50; i++) {
        const packet = await page.evaluate(({ mode, position }) => {
          if (mode === 'live') {
            const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view, bounds = view.scrollDOM.getBoundingClientRect();
            const top = view.documentTop + view.lineBlockAt(position).top - bounds.top;
            return { x: bounds.left + bounds.width * .65, y: bounds.top + 180,
              delta: top > bounds.height * .6 ? 140 : top < 100 ? -60 : 18 };
          }
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!, bounds = frame.getBoundingClientRect();
          const top = doc.querySelector('.meo-export-mermaid')?.getBoundingClientRect().top ?? 1000;
          return { x: bounds.left + bounds.width * .65, y: bounds.top + 180,
            delta: top > doc.defaultView!.innerHeight * .6 ? 140 : top < 100 ? -60 : 18 };
        }, { mode, position: text.indexOf('```mermaid') });
        await page.mouse.move(packet.x, packet.y);
        await page.mouse.wheel({ deltaY: packet.delta });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const result = await page.evaluate(() => {
        const probe = (window as any).__mermaidReading; probe.scrolling = false; return probe;
      });
      fs.mkdirSync('.local/test-artifacts/mermaid-reading-generation', { recursive: true });
      await page.screenshot({ path: `.local/test-artifacts/mermaid-reading-generation/${mode}-${large}-motion.png` });
      await new Promise(resolve => setTimeout(resolve, 700));
      const settled = await page.evaluate(mode => {
        const probe = (window as any).__mermaidReading; probe.active = false;
        const doc = mode === 'live' ? document : document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
        return { held: !!doc?.querySelector('.meo-reading-size-held') };
      }, mode);
      const visible = result.samples.filter((sample: any) => sample.scrolling && sample.visible);
      const ready = visible.filter((sample: any) => sample.ready);
      const firstVisible = visible[0]?.time, firstReady = ready[0]?.time;
      const delay = firstReady === undefined ? null : firstReady - firstVisible;
      const report = { mode, large, wheels: result.wheels, visible: visible.length, ready: ready.length, delay,
        writes: result.writes, tasks: result.tasks, samples: result.samples };
      reports.push(report);
      fs.mkdirSync('.local/test-artifacts/mermaid-reading-generation', { recursive: true });
      fs.writeFileSync('.local/test-artifacts/mermaid-reading-generation/latest.json', JSON.stringify(reports, null, 2));
      console.log(JSON.stringify({ mode, large, wheels: result.wheels, visible: visible.length, ready: ready.length, delay, writes: result.writes.length,
        maxLongTask: Math.max(0, ...result.tasks) }));
      assert.deepEqual(host.errors, []); assert.equal(host.readHost(), text);
      assert.ok(result.wheels >= 48 && visible.length >= 8, 'Exercise continuous trusted scrolling through the real graph');
      assert.ok(ready.length >= 8 && delay !== null && delay <= 500, 'Cold graph must finish and display during motion, within 500ms of entry');
      assert.deepEqual(result.writes, [], 'Generation and display must not compensate scrollTop during native motion');
      const firstReadyIndex = result.samples.findIndex((sample: any) => sample.ready);
      if (firstReadyIndex > 0) {
        const before = result.samples[firstReadyIndex - 1], after = result.samples[firstReadyIndex];
        assert.ok(Math.abs(after.witness - before.witness) <= 2, 'Publishing the completed SVG must retain following reading geometry');
      }
      assert.equal(settled.held, false, 'The existing reading owner releases temporary geometry after motion');
      await page.screenshot({ path: `.local/test-artifacts/mermaid-reading-generation/${mode}-${large}.png` });
    } finally { host.dispose(); await page.close(); }
  }
  if (!process.argv.includes('--source-only')) {
    const text = opening.repeat(5) + '\n```mermaid\nsequenceDiagram\nA->>B: DistantEngineResume\n```\n\n'
      + 'Distant paragraph.\n\n'.repeat(9_000);
    const page = await browser.newPage(), host = await open(page, text, false, 'preview');
    try {
      const point = await page.$eval('.preview-frame', frame => {
        const bounds = frame.getBoundingClientRect(); return { x: bounds.left + bounds.width * .65, y: bounds.top + 180 };
      });
      await page.mouse.move(point.x, point.y);
      for (let index = 0; index < 50; index++) {
        const delta = await page.evaluate(() => {
          const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, block = doc.querySelector('.meo-export-mermaid');
          if (!block) return 1400;
          const top = block.getBoundingClientRect().top;
          return top > doc.defaultView!.innerHeight * .6 ? 140 : top < 100 ? -60 : 18;
        });
        await page.mouse.wheel({ deltaY: delta });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const before = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!, block = doc.querySelector('.meo-export-mermaid');
        const bounds = block?.getBoundingClientRect();
        return { visible: !!bounds && bounds.top < doc.defaultView!.innerHeight && bounds.bottom > 0,
          rendered: !!block?.querySelector('.meo-export-mermaid-svg svg') };
      });
      assert.equal(before.visible, true, 'The unsupported cold engine must enter the actual viewport');
      assert.equal(before.rendered, false, 'An indivisible cold engine retains native gesture protection');
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector('.meo-export-mermaid-svg svg')?.textContent?.includes('DistantEngineResume'));
      assert.deepEqual(host.errors, []); assert.equal(host.readHost(), text);
      console.log('Indivisible engine: deferred during wheels and resumed by the reading owner after motion');
    } finally { host.dispose(); await page.close(); }
  }
  console.log('Cold complex Mermaid: generation/display during native scrolling and ordinary/windowed documents passed');
} catch (error) { failure = error; throw error; }
finally { server.stop(true); if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure); }
