import {
  LOCAL_LINK_RESOLUTION_TIMEOUT_MS,
  type LocalLinkStatus,
  type LocalLinkResolutionResult,
  type ResolveLocalLinksRequest,
  type ResolvedLocalLinksResponse
} from '../../../src/protocol/localLinkResolution';
import { createRequestLifecycle, type RequestLifecycleOptions } from './requestLifecycle';

export type LocalLinkResolutionTransportOptions = RequestLifecycleOptions;

export type LocalLinkResolutionTransport = {
  resolve(targets: string[]): Promise<LocalLinkResolutionResult>;
  accept(response: ResolvedLocalLinksResponse): boolean;
};

export function createLocalLinkResolutionTransport(
  postMessage: (message: ResolveLocalLinksRequest) => void,
  options: LocalLinkResolutionTransportOptions = {}
): LocalLinkResolutionTransport {
  const requests = createRequestLifecycle<{ readonly results: LocalLinkStatus[] }>(
    'local-link', LOCAL_LINK_RESOLUTION_TIMEOUT_MS, options
  );

  return {
    resolve(targets) {
      return requests.start(
        requestId => postMessage({ type: 'resolveLocalLinks', requestId, targets }),
        { timeout: 'Timed out while resolving local links', sendFailed: 'Failed to send local links request' }
      );
    },
    accept(response) {
      return requests.accept(response.requestId, response.result);
    }
  };
}
