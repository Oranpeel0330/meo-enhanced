import type { ResolvedHtmlStylesResponse, ResolveHtmlStylesRequest } from '../../../src/protocol/htmlStyles';

let post: ((message: ResolveHtmlStylesRequest) => void) | undefined;
let counter = 0;
const pending = new Map<string, (css: string | null) => void>();

export function initializeHtmlStyles(postMessage: (message: ResolveHtmlStylesRequest) => void): void { post = postMessage; }

export function acceptHtmlStyles(message: ResolvedHtmlStylesResponse): void {
  pending.get(message.requestId)?.(message.result.ok ? message.result.value.css : null);
}

export function resolveHtmlStyles(css: string, signal: AbortSignal): Promise<string | null> {
  if (!post || signal.aborted) return Promise.resolve(null);
  const requestId = `html-styles-${counter++}`;
  return new Promise(resolve => {
    const finish = (value: string | null = null) => {
      pending.delete(requestId);
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish();
    const timeout = setTimeout(() => finish(), 15_000);
    pending.set(requestId, finish);
    signal.addEventListener('abort', abort, { once: true });
    try { post!({ type: 'resolveHtmlStyles', requestId, css }); } catch { finish(); }
  });
}
