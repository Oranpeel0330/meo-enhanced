import assert from 'node:assert/strict';
import { createPreviewReadingWork } from '../webview/src/application/previewReadingWork';
import { readingPreparationMargin, readingPreparationRange, readingResourceDistance } from '../webview/src/application/readingWindow';

for (const height of [0, 200, 720, 1000, 4000]) {
  const margin = readingPreparationMargin(height), band = readingPreparationRange(100, 100 + height);
  assert.ok(margin >= 800 && margin <= 1600, 'resource preparation remains bounded across pane sizes');
  assert.deepEqual(band, { from: 100 - margin, to: 100 + height + margin });
}
assert.equal(readingPreparationMargin(1000), 1000, 'tall panes prepare one screen, independently of their width');
assert.equal(readingResourceDistance({ top: -1000, bottom: 20 }, 0, 720), 0, 'a tall visible resource outranks speculative work');
assert.equal(readingResourceDistance({ top: 800, bottom: 900 }, 0, 720), 80);
assert.equal(readingResourceDistance({ top: -200, bottom: -80 }, 0, 720), 80, 'both scroll directions share the approach rule');

let time = 0, batches = 0, inBatch = false;
const work = createPreviewReadingWork({ now: () => time, budgetMs: 4,
  batch(run) { assert.equal(inBatch, false); inBatch = true; batches++; try { run(); } finally { inBatch = false; } } });
const first = {}, second = {}, trace: string[] = [];
work.request(first, () => { trace.push('superseded'); });
work.request(first, () => { assert.ok(inBatch); trace.push('first'); time += 4; });
work.request(second, () => { trace.push('second'); time++; });
assert.equal(work.drain(), true);
assert.deepEqual(trace, ['first']);
assert.equal(work.drain(), false);
assert.deepEqual(trace, ['first', 'second']);
assert.equal(batches, 2, 'A turn owns one complete transaction');

let safeToCommit = false, deferredPublished = false;
const deferred = work.commit(() => { deferredPublished = true; }, undefined, () => safeToCommit);
work.request(second, () => { trace.push('safe preparation'); });
assert.equal(work.drain(), true);
assert.equal(trace.at(-1), 'safe preparation', 'unsafe geometry cannot block independent preparation');
assert.equal(deferredPublished, false);
safeToCommit = true;
assert.equal(work.drain(), false);
await deferred;
assert.equal(deferredPublished, true, 'a ready result commits once its existing owner releases native motion');

// Known expensive work waits for a fresh budget but must never starve.
trace.length = 0;
work.request(second, () => { trace.push('small'); time += 0.5; });
work.request(first, () => { trace.push('large'); time += 8; });
assert.equal(work.drain(), true);
assert.deepEqual(trace, ['small']);
assert.equal(work.drain(), false);
assert.deepEqual(trace, ['small', 'large']);

// A continuing key gets one step per turn; repeated requests retain latest intent.
let remaining = 3;
work.request(first, () => { remaining--; return remaining > 0; });
assert.equal(work.drain(), true); assert.equal(remaining, 2);
work.request(first, () => { remaining = 0; });
assert.equal(work.drain(), false); assert.equal(remaining, 0);

let published = false, settled = false;
const cancelled = work.commit(() => { published = true; }, reason => { assert.equal(reason, 'retired'); }).then(() => { settled = true; });
work.cancel(); await cancelled;
assert.equal(published, false); assert.equal(settled, true);
const accepted = work.commit(() => { assert.ok(inBatch); published = true; });
assert.equal(published, false);
assert.equal(work.drain(), false); await accepted; assert.equal(published, true);

// Cancellation during a step must discard old continuations and leave new intent.
work.request(first, () => { work.cancel(); work.request(second, () => { trace.push('new'); }); return true; });
assert.equal(work.drain(), true);
trace.length = 0; assert.equal(work.drain(), false); assert.deepEqual(trace, ['new']);
const failed = work.commit(() => { throw Error('commit failure'); });
work.drain(); await assert.rejects(failed, /commit failure/);
let released = false;
work.request(first, () => { throw Error('preparation failure'); });
const retired = work.commit(() => { throw Error('obsolete commit'); }, reason => { assert.equal(reason, 'failed'); }).then(() => { released = true; });
assert.throws(() => work.drain(), /preparation failure/); await retired;
assert.equal(released, true); assert.equal(work.hasPending(), false);
let restored = false;
const hidden = work.commit(() => {}, () => { restored = true; work.request(first, () => { trace.push('replacement'); }); });
work.cancel(); await hidden;
assert.equal(restored, true); assert.equal(work.hasPending(), true);
work.drain();
let commits = 0;
const many = Array.from({ length: 20 }, () => work.commit(() => { commits++; }));
work.drain(); assert.equal(commits, 8, 'Even cheap ready results must yield between bounded batches');
while (work.drain()) {}
await Promise.all(many); assert.equal(commits, 20);
console.log('Preview reading work: shared budget, atomic turns, latest intent, continuation, cancellation and failure passed');
