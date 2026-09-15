import type {
  DeploymentProviderResult,
  DeploymentReleaseAdapter,
  ReleaseControlExecutionResult,
  ReleaseControlRequest,
  ReleaseInspectionRequest,
  ReleaseMutationResult,
  ReleaseObservedAndroidState,
  ReleaseStepExecutionRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { GooglePlayTokenFactory, GooglePlayTransport } from '../../../../types/googlePlay.js';
import {
  resolveGooglePlayAccessTokenAsync,
  safeGooglePlayRequest,
} from '../../../../utils/googlePlayRuntime.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const TRACK = 'production';

export function createGooglePlayReleaseAdapter(options: {
  readonly createToken: GooglePlayTokenFactory;
  readonly request: GooglePlayTransport;
}): DeploymentReleaseAdapter {
  return {
    target: 'android',
    inspectAsync: (request) => inspectAsync(request, options),
    executeStepAsync: (request) => executeStepAsync(request, options),
    controlAsync: (request) => controlAsync(request, options),
  };
}

async function inspectAsync(
  request: ReleaseInspectionRequest,
  options: Parameters<typeof createGooglePlayReleaseAdapter>[0],
): Promise<DeploymentProviderResult<ReleaseObservedAndroidState>> {
  if (request.identity.target !== 'android')
    return failedInspection('GOOGLE_PLAY_IDENTITY_INVALID');
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const response = await safeGooglePlayRequest(options.request, {
    method: 'GET',
    url: trackSummaryUrl(request.identity.packageName),
    token: access.token,
  });
  if (response === null || !isSuccess(response.status))
    return failedInspection('GOOGLE_PLAY_RELEASE_INSPECTION_FAILED');
  const release = findRelease(parseJson(response.body), request.version);
  return {
    status: 'completed',
    value: release === null ? missing() : observed(request.version, release),
  };
}

async function executeStepAsync(
  request: ReleaseStepExecutionRequest,
  options: Parameters<typeof createGooglePlayReleaseAdapter>[0],
): Promise<ReleaseMutationResult> {
  if (request.identity.target !== 'android' || request.step.target !== 'android')
    return blocked('GOOGLE_PLAY_RELEASE_TARGET_INVALID');
  if (request.step.operation === 'verify' || request.step.operation === 'record')
    return { status: 'completed' };
  if (!['sync-notes', 'release', 'rollout'].includes(request.step.operation))
    return blocked('GOOGLE_PLAY_RELEASE_STEP_UNSUPPORTED');
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return blocked(access.action.code);
  return mutateReleaseAsync(request, access.token, options.request);
}

async function controlAsync(
  request: ReleaseControlRequest,
  options: Parameters<typeof createGooglePlayReleaseAdapter>[0],
): Promise<ReleaseControlExecutionResult> {
  if (request.identity.target !== 'android' || request.control.target !== 'android') {
    return {
      status: 'blocked',
      mutationAttempted: false,
      code: 'GOOGLE_PLAY_RELEASE_CONTROL_INVALID',
    };
  }
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'blocked', mutationAttempted: false, code: access.action.code };
  const result = await mutateControlAsync(request, access.token, options.request);
  return result
    ? { status: 'completed', mutationAttempted: true }
    : { status: 'failed', mutationAttempted: true, code: 'GOOGLE_PLAY_RELEASE_CONTROL_FAILED' };
}

async function mutateReleaseAsync(
  request: ReleaseStepExecutionRequest,
  token: string,
  transport: GooglePlayTransport,
): Promise<ReleaseMutationResult> {
  if (request.identity.target !== 'android') return blocked('GOOGLE_PLAY_IDENTITY_INVALID');
  const edit = await createEditAsync(request.identity.packageName, token, transport);
  if (edit === null) return failedMutation('GOOGLE_PLAY_EDIT_CREATE_FAILED');
  const track = await readEditTrackAsync(request.identity.packageName, edit, token, transport);
  if (track === null) return failedMutation('GOOGLE_PLAY_RELEASE_INSPECTION_FAILED');
  const updated = updateReleaseBody(track, request);
  if (updated === null) return blocked('GOOGLE_PLAY_RELEASE_NOT_FOUND');
  const written = await writeEditTrackAsync(
    request.identity.packageName,
    edit,
    token,
    updated,
    transport,
  );
  if (!written) return failedMutation('GOOGLE_PLAY_RELEASE_UPDATE_FAILED');
  return (await commitEditAsync(request.identity.packageName, edit, token, transport))
    ? { status: 'completed' }
    : failedMutation('GOOGLE_PLAY_EDIT_COMMIT_FAILED');
}

async function mutateControlAsync(
  request: ReleaseControlRequest,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  if (request.identity.target !== 'android' || request.control.target !== 'android') return false;
  const edit = await createEditAsync(request.identity.packageName, token, transport);
  if (edit === null) return false;
  const track = await readEditTrackAsync(request.identity.packageName, edit, token, transport);
  if (track === null) return false;
  const updated = updateControlBody(track, request.desired.version, request.control.action);
  if (updated === null) return false;
  return (
    (await writeEditTrackAsync(request.identity.packageName, edit, token, updated, transport)) &&
    commitEditAsync(request.identity.packageName, edit, token, transport)
  );
}

function updateReleaseBody(value: unknown, request: ReleaseStepExecutionRequest): unknown | null {
  if (!isRecord(value) || !Array.isArray(value.releases)) return null;
  const rollout = request.desired.rollout.android;
  const releases = value.releases.map((release) => {
    if (!isRecord(release) || release.name !== request.desired.version) return release;
    if (request.step.operation === 'sync-notes')
      return { ...release, releaseNotes: toReleaseNotes(request.desired.notes) };
    if (request.step.operation === 'rollout' && rollout?.mode === 'staged') {
      return {
        ...release,
        status: 'inProgress',
        ...(rollout.initialFraction === undefined
          ? {}
          : { userFraction: Number(rollout.initialFraction) }),
      };
    }
    return { ...release, status: 'completed' };
  });
  return releases.some((release) => isRecord(release) && release.name === request.desired.version)
    ? { ...value, releases }
    : null;
}

function updateControlBody(
  value: unknown,
  version: string,
  action: 'halt' | 'resume',
): unknown | null {
  if (!isRecord(value) || !Array.isArray(value.releases)) return null;
  const releases = value.releases.map((release) =>
    isRecord(release) && release.name === version
      ? { ...release, status: action === 'halt' ? 'halted' : 'inProgress' }
      : release,
  );
  return releases.some((release) => isRecord(release) && release.name === version)
    ? { ...value, releases }
    : null;
}

function findRelease(value: unknown, version: string): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.releases)) return null;
  return (
    value.releases.find(
      (release) => isRecord(release) && release.name === version && isRecord(release),
    ) ?? null
  );
}

function observed(version: string, release: Record<string, unknown>): ReleaseObservedAndroidState {
  const status = readRolloutStatus(release.status);
  const fraction =
    typeof release.userFraction === 'number' ? String(release.userFraction) : undefined;
  return {
    target: 'android',
    version,
    artifactRevision: null,
    versionCodes: readVersionCodes(release.versionCodes),
    releaseNotes: readReleaseNotes(release.releaseNotes),
    rolloutStatus: status,
    ...(fraction === undefined ? {} : { userFraction: fraction }),
  };
}

function missing(): ReleaseObservedAndroidState {
  return {
    target: 'android',
    version: null,
    artifactRevision: null,
    versionCodes: [],
    releaseNotes: [],
    rolloutStatus: 'missing',
  };
}

function readVersionCodes(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === 'string' ? [item] : []))
    : [];
}

function readReleaseNotes(value: unknown): ReleaseObservedAndroidState['releaseNotes'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && isNonEmptyString(item.language) && typeof item.text === 'string'
      ? [{ locale: item.language, text: item.text }]
      : [],
  );
}

function toReleaseNotes(
  notes: ReleaseStepExecutionRequest['desired']['notes'],
): readonly Readonly<Record<string, string>>[] {
  return notes.map((note) => ({ language: note.locale, text: note.text }));
}

function readRolloutStatus(value: unknown): ReleaseObservedAndroidState['rolloutStatus'] {
  return value === 'draft' || value === 'inProgress' || value === 'halted' || value === 'completed'
    ? value
    : 'missing';
}

async function createEditAsync(
  packageName: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<string | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'POST',
    url: `${appUrl(packageName)}/edits`,
    token,
    contentType: 'application/json',
    body: '{}',
  });
  if (response === null || !isSuccess(response.status)) return null;
  const parsed = parseJson(response.body);
  return isRecord(parsed) && isNonEmptyString(parsed.id) ? parsed.id : null;
}

async function readEditTrackAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<unknown | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'GET',
    url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}/tracks/${TRACK}`,
    token,
  });
  return response !== null && isSuccess(response.status) ? parseJson(response.body) : null;
}

async function writeEditTrackAsync(
  packageName: string,
  editId: string,
  token: string,
  body: unknown,
  transport: GooglePlayTransport,
): Promise<boolean> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'PUT',
    url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}/tracks/${TRACK}`,
    token,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  return response !== null && isSuccess(response.status);
}

async function commitEditAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'POST',
    url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}:commit`,
    token,
    contentType: 'application/json',
    body: '{}',
  });
  return response !== null && isSuccess(response.status);
}

function appUrl(packageName: string): string {
  return `${API}/${encodeURIComponent(packageName)}`;
}

function trackSummaryUrl(packageName: string): string {
  return `${appUrl(packageName)}/tracks/${TRACK}/releases`;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function blocked(code: string): ReleaseMutationResult {
  return { status: 'blocked', code };
}

function failedMutation(code: string): ReleaseMutationResult {
  return { status: 'failed', code };
}

function failedInspection(code: string): DeploymentProviderResult<ReleaseObservedAndroidState> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'Google Play release state could not be inspected.',
      target: 'android',
      provider: 'google-play',
    },
  };
}
