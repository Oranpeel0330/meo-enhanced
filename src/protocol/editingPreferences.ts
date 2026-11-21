import { isEditingPreferences, isEditingPreferencesChange, type EditingPreferences, type EditingPreferencesChange, type ShortcutPlatform } from '../foundation/editingPreferences';
import { decodeRequestResult, type RequestResult } from './requestResult';

export const EDITING_PREFERENCES_TIMEOUT_MS = 10_000;
export type UpdateEditingPreferencesRequest = {
  readonly type: 'updateEditingPreferences';
  readonly requestId: string;
  readonly change: EditingPreferencesChange;
  readonly platform?: ShortcutPlatform;
};
export type EditingPreferencesUpdateResult = RequestResult<EditingPreferences> | {
  readonly ok: false;
  readonly error: { readonly code: 'shortcut-conflicts-changed'; readonly message: string };
  readonly preferences: EditingPreferences;
};
export type UpdatedEditingPreferencesResponse = {
  readonly type: 'updatedEditingPreferences';
  readonly requestId: string;
  readonly revision: number;
  readonly result: EditingPreferencesUpdateResult;
};
export type EditingPreferencesChangedEvent = { readonly type: 'editingPreferencesChanged'; readonly preferences: EditingPreferences; readonly revision: number };

function revision(value: unknown): number | null { return value === undefined ? 0 : Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }

export function decodeUpdateEditingPreferencesRequest(value: unknown): UpdateEditingPreferencesRequest | null {
  if (!isRecord(value) || value.type !== 'updateEditingPreferences' || typeof value.requestId !== 'string'
    || value.requestId.length === 0 || value.requestId.length > 100 || !isEditingPreferencesChange(value.change)) return null;
  const { platform } = value;
  if (platform !== undefined && platform !== 'windows' && platform !== 'mac' && platform !== 'other') return null;
  return { type: value.type, requestId: value.requestId, change: value.change, ...(platform ? { platform } : {}) };
}

export function decodeUpdatedEditingPreferencesResponse(value: unknown): UpdatedEditingPreferencesResponse | null {
  if (!isRecord(value) || value.type !== 'updatedEditingPreferences' || typeof value.requestId !== 'string' || !value.requestId) return null;
  const version = revision(value.revision);
  if (version === null) return null;
  if (isRecord(value.result) && value.result.ok === false && isRecord(value.result.error)
    && value.result.error.code === 'shortcut-conflicts-changed' && typeof value.result.error.message === 'string'
    && isEditingPreferences(value.result.preferences)) {
    return { type: value.type, requestId: value.requestId, revision: version, result: {
      ok: false, error: { code: value.result.error.code, message: value.result.error.message }, preferences: value.result.preferences
    } };
  }
  const result = decodeRequestResult(value.result, candidate => isEditingPreferences(candidate) ? candidate : null);
  return result ? { type: value.type, requestId: value.requestId, revision: version, result } : null;
}

export function decodeEditingPreferencesChangedEvent(value: unknown): EditingPreferencesChangedEvent | null {
  return isRecord(value) && value.type === 'editingPreferencesChanged' && isEditingPreferences(value.preferences) && revision(value.revision) !== null
    ? { type: value.type, preferences: value.preferences, revision: revision(value.revision)! } : null;
}
