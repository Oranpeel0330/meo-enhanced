import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { decodeReadingPaint, readingPaintShift } from './reading-paint-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-live-reading-paint-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
process.env.MEO_TEST_NATIVE_SMOOTH_SCROLLING = '1';
const browser = await launchTestBrowser();
const directory = '.local/test-artifacts/live-reading-paint';
fs.mkdirSync(directory, { recursive: true });
let failure: unknown;
try {
  for (const large of [false, true]) {
    const page = await browser.newPage(), frames: { data: string; time: number }[] = [], errors: string[] = [];
    const client = await page.createCDPSession();
    page.on('pageerror', error => errors.push(String(error)));
    client.on('Page.screencastFrame', event => {
      frames.push({ data: event.data, time: event.metadata.timestamp ?? 0 });
      void client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    });
    try {
      await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
      await page.setContent('<!doctype html><style>:root{--vscode-editor-foreground:#e6edf3;--vscode-editor-background:#111314;--meo-content-editor-foreground:#e6edf3;--meo-content-editor-background:#111314;--meo-content-sideBar-background:#111314;--meo-content-panel-border:#333}html,body,#app{height:100%;margin:0}</style><body class="vscode-dark"><div id="app" class="editor-host"></div>');
      await page.addStyleTag({ path: 'webview/src/styles.css' });
      await page.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({postMessage(){},getState(){},setState(){}});' });
      await page.addScriptTag({ content: await build.outputs[0]!.text() });
      await page.evaluate(lines => (window as any).LiveReadingPaintHarness.create(lines), large ? 2400 : 450);
      await page.click('.cm-content .cm-line');
      await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
      await page.waitForFunction(large => {
        const value = (window as any).__readingPaint.snapshot();
        return value.head === value.length && value.viewportEnd === value.length
          && (!large || value.placeholder && value.band.to === value.length);
      }, {}, large);
      const initial = await page.evaluate(() => { const scope = (window as any).__readingPaint; scope.refine(); return scope.snapshot(); });
      assert.equal(initial.large, large, 'Use the real ordinary/large-document policy paths');
      const point = await page.$eval('.cm-scroller', scroll => {
        const bounds = scroll.getBoundingClientRect(); return { x: bounds.right - 28, y: bounds.top + bounds.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await client.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
      let reachedStart = false;
      for (let packet = 0; packet < 500; packet++) {
        await page.mouse.wheel({ deltaY: -240 });
        await new Promise(resolve => setTimeout(resolve, 20));
        if (await page.$eval('.cm-scroller', scroll => scroll.scrollTop <= 1)) { reachedStart = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      await client.send('Page.stopScreencast');
      assert.ok(frames.length >= 20, 'Capture actual compositor frames before comparing reading motion');
      await page.screenshot({ path: `${directory}/${large ? 'large' : 'ordinary'}.png` });
      fs.writeFileSync(`${directory}/${large ? 'large' : 'ordinary'}-sample.jpg`, Buffer.from(frames[Math.floor(frames.length / 2)]!.data, 'base64'));
      const final = await page.evaluate(() => (window as any).__readingPaint.snapshot());
      const shifts: { frame: number; dy: number; score: number; margin: number; features: number }[] = [];
      let previous = await decodeReadingPaint(frames[0]!.data);
      for (let index = 1; index < frames.length; index++) {
        const current = await decodeReadingPaint(frames[index]!.data), shift = readingPaintShift(previous, current);
        if (shift) shifts.push({ frame: index, ...shift });
        previous = current;
      }
      const wrongWay = shifts.filter(shift => shift.dy < -12 && shift.score < .35 && shift.margin > .08);
      fs.writeFileSync(`${directory}/${large ? 'large' : 'ordinary'}.json`, JSON.stringify({ initial, final, reachedStart,
        frames: frames.length, shifts, wrongWay, errors }, null, 2));
      for (const shift of wrongWay.slice(0, 3)) for (const index of [shift.frame - 1, shift.frame, shift.frame + 1]) {
        if (frames[index]) fs.writeFileSync(`${directory}/${large}-frame-${index}.jpg`, Buffer.from(frames[index]!.data, 'base64'));
      }
      console.log(JSON.stringify({ large, reachedStart, frames: frames.length, hydrated: final.hydrated, wrongWay }));
      assert.deepEqual(errors, []); assert.ok(final.unchanged && reachedStart);
      assert.ok(frames.length >= 20 && shifts.filter(shift => shift.score < .35 && shift.margin > .08).length >= 15,
        'Observe enough unambiguous compositor frames of real native scrolling');
      if (large) assert.ok(final.hydrated > 0, 'Hydrate the prepared offscreen resource through the production presentation window');
      assert.deepEqual(wrongWay, [], 'Upward native reading must not paint a reverse jump and recover on the next frame');
    } finally { await page.evaluate(() => (window as any).__readingPaint?.destroy()); await client.detach(); await page.close(); }
  }
} catch (error) { failure = error; throw error; }
finally { if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure); }
