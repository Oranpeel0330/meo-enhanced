import { decodeRequestResult, type RequestResult } from './requestResult';

export type ResolveHtmlStylesRequest = { readonly type: 'resolveHtmlStyles'; readonly requestId: string; readonly css: string };
export type ResolvedHtmlStylesResponse = { readonly type: 'resolvedHtmlStyles'; readonly requestId: string; readonly result: RequestResult<{ css: string }> };
export type HtmlStylesChanged = { readonly type: 'htmlStylesChanged' };

export function decodeHtmlStylesChanged(value: unknown): HtmlStylesChanged | null {
  return value && typeof value === 'object' && 'type' in value && value.type === 'htmlStylesChanged' ? { type: 'htmlStylesChanged' } : null;
}

export function decodeResolveHtmlStylesRequest(value: unknown): ResolveHtmlStylesRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Record<string, unknown>;
  return request.type === 'resolveHtmlStyles' && typeof request.requestId === 'string' && request.requestId.length > 0 && typeof request.css === 'string'
    ? { type: 'resolveHtmlStyles', requestId: request.requestId, css: request.css } : null;
}

export function decodeResolvedHtmlStylesResponse(value: unknown): ResolvedHtmlStylesResponse | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as Record<string, unknown>;
  const result = decodeRequestResult(response.result, candidate => candidate && typeof candidate === 'object' && 'css' in candidate && typeof candidate.css === 'string' ? { css: candidate.css } : null);
  return response.type === 'resolvedHtmlStyles' && typeof response.requestId === 'string' && response.requestId.length > 0 && result
    ? { type: 'resolvedHtmlStyles', requestId: response.requestId, result } : null;
}
