import type {
  AndroidDeploymentPublication,
  AndroidDeploymentPublisher,
  AndroidPublishInspection,
  AndroidPublishInspectionRequest,
  AndroidPublishRequest,
  DeploymentProviderResult,
  DeploymentRequiredAction,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type {
  GooglePlayArtifactDownloader,
  GooglePlayTokenFactory,
  GooglePlayTransport,
} from '../../../../types/googlePlay.js';
import {
  resolveGooglePlayAccessTokenAsync,
  safeGooglePlayRequest,
} from '../../../../utils/googlePlayRuntime.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD_API =
  'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

export function createGooglePlayAndroidPublisher(options: {
  readonly createToken: GooglePlayTokenFactory;
  readonly request: GooglePlayTransport;
  readonly downloadArtifact: GooglePlayArtifactDownloader;
}): AndroidDeploymentPublisher {
  return {
    inspectAsync: (request) => inspectAsync(request, options),
    publishAsync: (request) => publishAsync(request, options),
    verifyAsync: (request) => verifyAsync(request, options),
  };
}

async function inspectAsync(
  request: AndroidPublishInspectionRequest,
  options: Pick<Parameters<typeof createGooglePlayAndroidPublisher>[0], 'createToken' | 'request'>,
): Promise<DeploymentProviderResult<AndroidPublishInspection>> {
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const response = await safeGooglePlayRequest(options.request, {
    method: 'GET',
    url: trackSummaryUrl(request.packageName, request.track),
    token: access.token,
  });
  if (response === null) return failedInspection('GOOGLE_PLAY_INSPECTION_FAILED');
  const blocked = blockedResult<AndroidPublishInspection>(response.status);
  if (blocked !== null) return blocked;
  if (!isSuccess(response.status)) return failedInspection('GOOGLE_PLAY_INSPECTION_FAILED');
  const activeVersionCodes = parseVersionCodes(response.body);
  return activeVersionCodes === null
    ? failedInspection('GOOGLE_PLAY_INVALID_RESULT')
    : { status: 'completed', value: { track: request.track, activeVersionCodes } };
}

async function publishAsync(
  request: AndroidPublishRequest,
  options: Parameters<typeof createGooglePlayAndroidPublisher>[0],
): Promise<DeploymentProviderResult<AndroidDeploymentPublication>> {
  const access = await resolveGooglePlayAccessTokenAsync({
    ...request,
    createToken: options.createToken,
  });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const archive = await safelyDownload(options.downloadArtifact, request.artifact.archiveUrl);
  if (archive === null) return failedPublication('ANDROID_ARCHIVE_DOWNLOAD_FAILED');
  return publishArchiveAsync(request, access.token, archive, options.request);
}

async function publishArchiveAsync(
  request: AndroidPublishRequest,
  token: string,
  archive: Uint8Array,
  transport: GooglePlayTransport,
): Promise<DeploymentProviderResult<AndroidDeploymentPublication>> {
  const editId = await createEditAsync(request.packageName, token, transport);
  if (editId === null) return failedPublication('GOOGLE_PLAY_EDIT_CREATE_FAILED');
  const uploaded = await uploadBundleAsync(request.packageName, editId, token, archive, transport);
  if (uploaded !== request.artifact.versionCode)
    return failedPublication('GOOGLE_PLAY_VERSION_MISMATCH');
  const trackUpdated = await updateTrackAsync(request, editId, token, transport);
  if (!trackUpdated) return failedPublication('GOOGLE_PLAY_TRACK_UPDATE_FAILED');
  const committed = await commitEditAsync(request.packageName, editId, token, transport);
  return committed
    ? completedPublication(request)
    : failedPublication('GOOGLE_PLAY_EDIT_COMMIT_FAILED');
}

async function verifyAsync(
  request: AndroidPublishRequest,
  options: Pick<Parameters<typeof createGooglePlayAndroidPublisher>[0], 'createToken' | 'request'>,
): Promise<DeploymentProviderResult<AndroidPublishInspection>> {
  const inspection = await inspectAsync(request, options);
  if (inspection.status !== 'completed') return inspection;
  return inspection.value.activeVersionCodes.includes(request.artifact.versionCode)
    ? inspection
    : failedInspection('GOOGLE_PLAY_VERIFICATION_FAILED');
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

async function uploadBundleAsync(
  packageName: string,
  editId: string,
  token: string,
  archive: Uint8Array,
  transport: GooglePlayTransport,
): Promise<number | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'POST',
    url: `${UPLOAD_API}/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/bundles?uploadType=media`,
    token,
    contentType: 'application/octet-stream',
    body: archive,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const parsed = parseJson(response.body);
  return isRecord(parsed) &&
    typeof parsed.versionCode === 'number' &&
    Number.isSafeInteger(parsed.versionCode)
    ? parsed.versionCode
    : null;
}

async function updateTrackAsync(
  request: AndroidPublishRequest,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'PUT',
    url: `${appUrl(request.packageName)}/edits/${encodeURIComponent(editId)}/tracks/${encodeURIComponent(request.track)}`,
    token,
    contentType: 'application/json',
    body: JSON.stringify({
      track: request.track,
      releases: [
        { versionCodes: [String(request.artifact.versionCode)], status: request.releaseStatus },
      ],
    }),
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

function completedPublication(
  request: AndroidPublishRequest,
): DeploymentProviderResult<AndroidDeploymentPublication> {
  return {
    status: 'completed',
    value: {
      target: 'android',
      revision: request.revision,
      buildProvider: request.artifact.provider,
      publishProvider: 'google-play',
      buildId: request.artifact.buildId,
      versionCode: request.artifact.versionCode,
      track: request.track,
      releaseStatus: request.releaseStatus,
    },
  };
}

function parseVersionCodes(body: string): readonly number[] | null {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.releases)) return null;
  const values = parsed.releases.flatMap((release) =>
    isRecord(release) && Array.isArray(release.versionCodes) ? release.versionCodes : [],
  );
  const versionCodes = values.map(readVersionCode);
  return versionCodes.every((value): value is number => value !== null) ? versionCodes : null;
}

function readVersionCode(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function blockedResult<T>(status: number): DeploymentProviderResult<T> | null {
  const action =
    status === 401
      ? authenticationAction()
      : status === 403
        ? permissionAction()
        : status === 404
          ? bootstrapAction()
          : null;
  return action === null ? null : { status: 'action-required', action };
}

function authenticationAction(): DeploymentRequiredAction {
  return {
    type: 'authentication',
    provider: 'google-play',
    target: 'android',
    code: 'GOOGLE_PLAY_AUTHENTICATION_REQUIRED',
    message: 'Google Play authentication is required for Android deployment.',
  };
}

function permissionAction(): DeploymentRequiredAction {
  return {
    type: 'manual-action',
    provider: 'google-play',
    target: 'android',
    code: 'GOOGLE_PLAY_PERMISSION_REQUIRED',
    message:
      'Grant the service account permission to manage this application in Google Play Console.',
  };
}

function bootstrapAction(): DeploymentRequiredAction {
  return {
    type: 'manual-action',
    provider: 'google-play',
    target: 'android',
    code: 'GOOGLE_PLAY_APP_BOOTSTRAP_REQUIRED',
    message:
      'Create and bootstrap the Android application in Google Play Console before API delivery.',
  };
}

function failedInspection(code: string): DeploymentProviderResult<AndroidPublishInspection> {
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

function failedPublication(code: string): DeploymentProviderResult<AndroidDeploymentPublication> {
  return {
    status: 'failed',
    failure: {
      code,
      message: 'Google Play Android publication failed.',
      target: 'android',
      provider: 'google-play',
    },
  };
}

async function safelyDownload(
  download: GooglePlayArtifactDownloader,
  url: string,
): Promise<Uint8Array | null> {
  try {
    return await download(url);
  } catch {
    return null;
  }
}

function appUrl(packageName: string): string {
  return `${API}/${encodeURIComponent(packageName)}`;
}

function trackSummaryUrl(packageName: string, track: string): string {
  return `${appUrl(packageName)}/tracks/${encodeURIComponent(track)}/releases`;
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
