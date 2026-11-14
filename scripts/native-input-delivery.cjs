// Test driver only. A successful CDP command is not an input-delivery receipt.
const assert = require('node:assert/strict');

class NativeInputCapabilityError extends Error {
  constructor(stage, evidence, cause) {
    super(`Native input capability failed at ${stage}`, { cause });
    this.name = 'NativeInputCapabilityError';
    this.code = 'native-input-unavailable';
    this.stage = stage;
    this.evidence = evidence;
  }
}

async function inspectContentFrameOwner(frame) {
  const element = await frame.frameElement();
  if (!element) throw Error('The content frame has no parent iframe owner');
  try {
    return await element.evaluate(node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        id: node.id,
        visible: style.visibility === 'visible' && !node.hidden && rect.width > 0 && rect.height > 0,
        inert: Boolean(node.closest('[inert]')),
        x: rect.x,
        y: rect.y
      };
    });
  } finally {
    await element.dispose();
  }
}

async function findActiveWebview(browser, heading) {
  const matches = [];
  for (const page of await browser.pages()) for (const frame of page.frames()) {
    const accepted = await (async () => {
      const hasActiveDocument = await frame.evaluate(heading => {
        const root = document.querySelector('.editor-root');
        return Boolean(root?.textContent?.includes(heading) && !document.querySelector('.meo-preload-toolbar'));
      }, heading);
      if (!hasActiveDocument) return false;
      const owner = await inspectContentFrameOwner(frame);
      return owner.id === 'active-frame' && owner.visible && !owner.inert;
    })().catch(() => false);
    if (accepted) matches.push({ page, frame });
  }
  assert.equal(matches.length, 1, 'Exactly one active Webview must match the disposable document heading');
  return matches[0];
}

async function readWebviewPoint({ frame, page }, position) {
  let owner = frame;
  let id;
  while (owner && !id) {
    try { id = new URL(owner.url()).searchParams.get('id'); } catch { /* Not the Webview owner. */ }
    owner = owner.parentFrame();
  }
  assert.ok(id, 'A Webview owner id is required');
  const contentFrame = await inspectContentFrameOwner(frame);
  if (contentFrame.id !== 'active-frame' || !contentFrame.visible || contentFrame.inert) {
    throw Error('The content frame is not active');
  }
  const point = { ...position, innerX: contentFrame.x, innerY: contentFrame.y };
  const origin = await page.evaluate(({ id, point }) => {
    const owners = [...document.querySelectorAll('iframe')].filter(node => {
      try { return new URL(node.src).searchParams.get('id') === id; } catch { return false; }
    });
    if (owners.length !== 1) throw Error('The outer Webview is not unique');
    const owner = owners[0], rect = owner.getBoundingClientRect();
    const x = rect.x + point.innerX + point.x, y = rect.y + point.innerY + point.y;
    if (getComputedStyle(owner).visibility !== 'visible' || document.elementFromPoint(x, y) !== owner) {
      throw Error('The outer Webview is hidden or covered');
    }
    return { x, y, owner: id };
  }, { id, point });
  return { local: point, root: origin };
}

async function createPointerDriver({ frame, page, mouse = page.mouse, timeoutMs = 2000 }) {

  const pointFor = async selector => {
    const point = await frame.$eval(selector, node => {
      if (!node.isConnected || node.closest('[inert]') || node.disabled) throw Error('Target is not interactive');
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (style.visibility !== 'visible' || right <= left || bottom <= top) throw Error('Target is not visible');
      const x = (left + right) / 2, y = (top + bottom) / 2;
      if (!node.contains(document.elementFromPoint(x, y))) throw Error('The target is covered');
      return { x, y };
    });
    return readWebviewPoint({ frame, page }, point);
  };

  const gesture = async (selector, delta = { x: 0, y: 0 }) => {
    const evidence = { selector, delta, commands: [], events: [], bindingReceipts: [],
      timeline: { startedAt: Date.now() }, releaseAttempted: false };
    const binding = '__meoInputReceipt_' + Math.random().toString(36).slice(2);
    let stage = 'target', armed = false, held = false, bound = false, notify, client, contextId, receive;
    // Receiving an input is independent of the render task it starts. Observe
    // through the protocol binding, so a busy renderer cannot starve polling.
    const waitForReceipt = predicate => {
      if (evidence.events.some(predicate)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { notify = undefined; reject(new Error(`Input receipt exceeded ${timeoutMs}ms`)); }, timeoutMs);
        notify = () => {
          if (!evidence.events.some(predicate)) return;
          clearTimeout(timer); notify = undefined; resolve();
        };
      });
    };
    try {
      let point = await pointFor(selector);
      evidence.point = point;
      stage = 'observation';
      // Attached older Workbenches can omit frame loading history, causing
      // page.exposeFunction to skip an already interactive child frame. Bind
      // to the observed frame's actual CDP context instead of that page hint.
      await frame.evaluate(() => undefined);
      client = frame.client;
      contextId = frame.mainRealm().context?.id;
      assert.ok(client && Number.isInteger(contextId), 'The observed Chromium frame must have a CDP context');
      receive = event => {
        if (event.name !== binding || event.executionContextId !== contextId) return;
        try {
          const receipt = JSON.parse(event.payload);
          evidence.bindingReceipts.push({ type: receipt.type, observedAt: receipt.observedAt, receivedAt: Date.now() });
          evidence.events.push(receipt); notify?.();
        } catch (error) { (evidence.receiverErrors ??= []).push(String(error)); }
      };
      client.on('Runtime.bindingCalled', receive);
      await client.send('Runtime.addBinding', { name: binding, executionContextId: contextId });
      bound = true;
      evidence.observer = await frame.evaluate(({ selector, binding }) => {
        if (window.__meoInputDelivery) throw Error('Another pointer probe is active');
        if (typeof window[binding] !== 'function') throw Error('The observed frame receipt binding was not installed');
        const events = [], bindingErrors = [];
        const expectedTarget = document.querySelector(selector);
        const record = event => {
          const receipt = { type: event.type, observedAt: Date.now(), trusted: event.isTrusted, pointerId: event.pointerId,
            button: event.button, buttons: event.buttons, x: event.clientX, y: event.clientY,
            target: event.target?.tagName, className: String(event.target?.className ?? ''),
            targetMatches: Boolean(expectedTarget?.isConnected && expectedTarget.contains(event.target)) };
          events.push(receipt);
          try { window[binding](JSON.stringify(receipt)); }
          catch (error) { bindingErrors.push(String(error)); }
        };
        for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.addEventListener(type, record, true);
        window.__meoInputDelivery = { events, bindingErrors, stop() {
          for (const type of ['pointerdown', 'pointermove', 'pointerup']) window.removeEventListener(type, record, true);
        } };
        return { bindingType: typeof window[binding], armedAt: Date.now() };
      }, { selector, binding });
      armed = true;
      evidence.timeline.moveRequestedAt = Date.now();
      await mouse.move(point.root.x, point.root.y);
      evidence.timeline.moveAcknowledgedAt = Date.now();
      evidence.commands.push('move');
      stage = 'pointermove';
      await waitForReceipt(event => event.type === 'pointermove' && event.trusted);
      const isCurrentMove = event => event.type === 'pointermove' && event.trusted && event.targetMatches
        && Math.abs(event.x - point.local.x) <= 1 && Math.abs(event.y - point.local.y) <= 1;
      if (!evidence.events.some(isCurrentMove)) {
        const current = await pointFor(selector);
        if (Math.abs(current.root.x - point.root.x) <= 1 && Math.abs(current.root.y - point.root.y) <= 1) {
          throw new Error('Delivered movement did not reach the unchanged target');
        }
        evidence.geometryChange = { before: point, after: current };
        point = current; evidence.point = point;
        await mouse.move(point.root.x, point.root.y);
        evidence.commands.push('move after observed layout change');
        await waitForReceipt(isCurrentMove);
      }
      stage = 'pointerdown';
      held = true;
      await mouse.down();
      evidence.commands.push('press acknowledged');
      await waitForReceipt(event =>
        event.type === 'pointerdown' && event.trusted && event.button === 0 && event.targetMatches
        && Math.abs(event.x - point.local.x) <= 1 && Math.abs(event.y - point.local.y) <= 1);
      if (delta.x || delta.y) {
        stage = 'pointermove';
        await mouse.move(point.root.x + delta.x, point.root.y + delta.y, { steps: 6 });
        evidence.commands.push('drag acknowledged');
      }
      stage = 'pointerup';
      evidence.releaseAttempted = true;
      await mouse.up();
      held = false;
      evidence.commands.push('release acknowledged');
      const down = evidence.events.find(event => event.type === 'pointerdown' && event.trusted);
      await waitForReceipt(event => event.type === 'pointerup' && event.trusted && event.pointerId === down.pointerId);
      return evidence;
    } catch (cause) {
      evidence.cause = String(cause?.stack || cause);
      evidence.timeline.failedAt = Date.now();
      throw new NativeInputCapabilityError(stage, evidence, cause);
    } finally {
      if (held) {
        evidence.releaseAttempted = true;
        try { await mouse.up(); } catch (error) { evidence.releaseError = String(error); }
      }
      if (armed) {
        try {
          const observation = await frame.evaluate(() => {
            const probe = window.__meoInputDelivery;
            probe.stop(); delete window.__meoInputDelivery;
            return { events: probe.events, bindingErrors: probe.bindingErrors };
          });
          evidence.events = observation.events;
          evidence.bindingErrors = observation.bindingErrors;
        } catch (error) { evidence.observationError = String(error); }
      }
      if (bound) {
        try {
          await client.send('Runtime.removeBinding', { name: binding });
          await frame.evaluate(name => { delete window[name]; }, binding);
        }
        catch (error) { evidence.observationError = String(error); }
      }
      if (client && receive) client.off('Runtime.bindingCalled', receive);
    }
  };
  return { click: selector => gesture(selector), drag: (selector, x, y = 0) => gesture(selector, { x, y }) };
}

module.exports = { NativeInputCapabilityError, findActiveWebview, readWebviewPoint, createPointerDriver };
