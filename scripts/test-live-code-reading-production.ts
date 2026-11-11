import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

let primary: unknown;
try {
  for (const large of [false, true]) {
    const text = Array.from({ length: large ? 90 : 16 }, (_, block) => [
      `## Reading ${block}`, '',
      ...Array.from({ length: 3 }, (_, row) => `Paragraph ${block}-${row}: ${'Stable reading text. '.repeat(5)}`), '',
      block === 11 ? '```python' : '```typescript',
      ...Array.from({ length: block === 12 ? 48 : 6 }, (_, row) => block === 12
        ? `const readingRow12_${row} = "${'oversized '.repeat(20)}";`
        : `const readingRow${block}_${row} = { number: ${row}, text: "value" };`), '```', ''
    ].join('\n')).join('\n');
    assert.equal(assessLargeDocument(text).boundedEditorWork, large);
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      const scope = window as any, NativeWorker = Worker;
      scope.__codeReading = { active: false, wheels: [], requests: [], samples: [], lastWheel: -Infinity };
      scope.Worker = class extends NativeWorker {
        postMessage(data: any, ...args: any[]) {
          if (scope.__codeReading.active && typeof data?.code === 'string') {
            const time = performance.now();
            scope.__codeReading.requests.push({ code: data.code, time,
              scrolling: time - scope.__codeReading.lastWheel < 250 });
          }
          return (NativeWorker.prototype.postMessage as any).call(this, data, ...args);
        }
      };
    });
    const host = await open(page, text, false, 'live');
    try {
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.editor-host .cm-line')]
        .some(line => line.textContent?.includes('readingRow0_0') && [...line.querySelectorAll<HTMLElement>('span[style]')]
          .some(span => !!span.style.color && !span.style.color.includes('var('))));
      const point = await page.evaluate(position => {
        const scope = window as any, probe = scope.__codeReading;
        const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view;
        const bounds = view.scrollDOM.getBoundingClientRect();
        view.scrollDOM.scrollTop = view.lineBlockAt(position).top - bounds.height * 3.5;
        const wheel = (event: WheelEvent) => { probe.wheels.push(event.isTrusted); probe.lastWheel = performance.now(); };
        view.scrollDOM.addEventListener('wheel', wheel, { passive: true });
        probe.stop = () => { probe.active = false; view.scrollDOM.removeEventListener('wheel', wheel); };
        const sample = () => {
          if (!probe.active) return;
          const bounds = view.scrollDOM.getBoundingClientRect();
          const line = [...view.dom.querySelectorAll<HTMLElement>('.cm-line')]
            .find(line => line.textContent?.includes('readingRow10_0'));
          const rect = line?.getBoundingClientRect();
          const colored = !!line && [...line.querySelectorAll<HTMLElement>('span[style]')]
            .some(span => !!span.style.color && !span.style.color.includes('var('));
          probe.samples.push({ time: performance.now(), scrolling: performance.now() - probe.lastWheel < 250,
            visible: !!rect && rect.bottom > bounds.top && rect.top < bounds.bottom, colored,
            top: rect?.top, scrollTop: view.scrollDOM.scrollTop });
          requestAnimationFrame(sample);
        };
        probe.start = () => { probe.active = true; requestAnimationFrame(sample); };
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      }, text.indexOf('readingRow10_0'));
      await frames(page, 12);
      await page.mouse.move(point.x, point.y);
      await page.evaluate(() => (window as any).__codeReading.start());
      for (let index = 0; index < 54; index++) {
        const delta = await page.evaluate(({ position, index }) => {
          const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view;
          const bounds = view.scrollDOM.getBoundingClientRect();
          const top = view.documentTop + view.lineBlockAt(position).top - bounds.top;
          return top > bounds.height * 0.65 ? 90 : top < bounds.height * 0.25 ? -60 : index % 8 < 4 ? 18 : -18;
        }, { position: text.indexOf('readingRow10_0'), index });
        await page.mouse.wheel({ deltaY: delta });
        // CDP command completion is not the renderer's wheel delivery. Admit
        // each real event before sending the next or retiring the frame probe.
        await page.waitForFunction(expected => (window as any).__codeReading.wheels.length === expected,
          {}, index + 1);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const result = await page.evaluate(() => {
        const probe = (window as any).__codeReading; probe.stop();
        const visible = probe.samples.filter((sample: any) => sample.scrolling && sample.visible);
        const colored = visible.filter((sample: any) => sample.colored);
        const geometry = visible.map((sample: any) => sample.top + sample.scrollTop);
        return { wheels: probe.wheels, visible: visible.length, colored: colored.length,
          delay: colored.length ? colored[0].time - visible[0].time : null,
          geometryDrift: Math.max(...geometry) - Math.min(...geometry),
          preparedWhileScrolling: probe.requests.some((request: any) => request.scrolling && request.code.includes('readingRow10_0')),
          requests: probe.requests.map((request: any) => request.code) };
      });
      console.log(JSON.stringify({ large, ...result, requests: result.requests.map((code: string) => code.slice(0, 35)) }));
      assert.equal(result.wheels.length, 54);
      assert.ok(result.wheels.every(Boolean), 'Reading uses trusted wheel events');
      assert.ok(result.visible >= 20, 'The new block must remain visible during sustained scrolling');
      assert.ok(result.preparedWhileScrolling, 'A short block in a warm language must prepare during scrolling');
      assert.ok(result.colored >= 12, 'Prepared code must become colored while native scrolling continues');
      assert.ok(result.geometryDrift <= 2, 'Coloring must retain the reading witness throughout native motion');
      assert.ok(!result.requests.some((code: string) => code.includes('readingRow11_0')), 'Cold languages must retain their original scroll admission');
      assert.ok(!result.requests.some((code: string) => code.includes('readingRow12_0')), 'Oversized fences must retain their original scroll admission');
      assert.ok(!result.requests.some((code: string) => code.includes('readingRow15_0')), 'Reading must not prepare distant document content');
      assert.equal(host.readHost(), text);
      assert.deepEqual(host.errors, []);
      const directory = '.local/test-artifacts/live-code-reading'; fs.mkdirSync(directory, { recursive: true });
      await page.screenshot({ path: `${directory}/${large ? 'large' : 'ordinary'}.png` });
    } finally { host.dispose(); await page.close(); }
  }
} catch (error) { primary = error; throw error; }
finally {
  server.stop(true);
  if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary);
}
