import {
  WIKI_LINK_RESOLUTION_TIMEOUT_MS,
  type WikiLinkStatus,
  type WikiLinkResolutionResult,
  type ResolveWikiLinksRequest,
  type ResolvedWikiLinksResponse
} from '../../../src/protocol/wikiLinkResolution';
import { createRequestLifecycle, type RequestLifecycleOptions } from './requestLifecycle';

export type WikiLinkResolutionTransportOptions = RequestLifecycleOptions;

export type WikiLinkResolutionTransport = {
  resolve(targets: string[]): Promise<WikiLinkResolutionResult>;
  accept(response: ResolvedWikiLinksResponse): boolean;
};

export function createWikiLinkResolutionTransport(
  postMessage: (message: ResolveWikiLinksRequest) => void,
  options: WikiLinkResolutionTransportOptions = {}
): WikiLinkResolutionTransport {
  const requests = createRequestLifecycle<{ readonly results: WikiLinkStatus[] }>(
    'wiki', WIKI_LINK_RESOLUTION_TIMEOUT_MS, options
  );

  return {
    resolve(targets) {
      return requests.start(
        requestId => postMessage({ type: 'resolveWikiLinks', requestId, targets }),
        { timeout: 'Timed out while resolving Wiki Links', sendFailed: 'Failed to send Wiki Links request' }
      );
    },
    accept(response) {
      return requests.accept(response.requestId, response.result);
    }
  };
}
