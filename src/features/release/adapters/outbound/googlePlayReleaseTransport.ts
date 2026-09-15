import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { GooglePlayTransport } from '../../../../types/googlePlay.js';
import { safeGooglePlayRequest } from '../../../../utils/googlePlayRuntime.js';
import { parseGooglePlayJsonRecord } from '../../utils/googlePlayReleaseModel.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const TRACK = 'production';

export async function readGooglePlayReleaseSummaryAsync(options: {
  readonly packageName: string;
  readonly token: string;
  readonly transport: GooglePlayTransport;
}): Promise<Record<string, unknown> | null> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'GET',
    url: `${appUrl(options.packageName)}/tracks/${TRACK}/releases`,
    token: options.token,
  });
  return response !== null && isSuccess(response.status)
    ? parseGooglePlayJsonRecord(response.body)
    : null;
}

export async function createGooglePlayReleaseEditAsync(options: {
  readonly packageName: string;
  readonly token: string;
  readonly transport: GooglePlayTransport;
}): Promise<string | null> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'POST',
    url: `${appUrl(options.packageName)}/edits`,
    token: options.token,
    contentType: 'application/json',
    body: '{}',
  });
  if (response === null || !isSuccess(response.status)) return null;
  const parsed = parseGooglePlayJsonRecord(response.body);
  return parsed !== null && isNonEmptyString(parsed.id) ? parsed.id : null;
}

export async function readGooglePlayReleaseEditTrackAsync(options: {
  readonly packageName: string;
  readonly editId: string;
  readonly token: string;
  readonly transport: GooglePlayTransport;
}): Promise<Record<string, unknown> | null> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'GET',
    url: editTrackUrl(options.packageName, options.editId),
    token: options.token,
  });
  return response !== null && isSuccess(response.status)
    ? parseGooglePlayJsonRecord(response.body)
    : null;
}

export async function writeGooglePlayReleaseEditTrackAsync(options: {
  readonly packageName: string;
  readonly editId: string;
  readonly token: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly transport: GooglePlayTransport;
}): Promise<boolean> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'PUT',
    url: editTrackUrl(options.packageName, options.editId),
    token: options.token,
    contentType: 'application/json',
    body: JSON.stringify(options.body),
  });
  return response !== null && isSuccess(response.status);
}

export async function commitGooglePlayReleaseEditAsync(options: {
  readonly packageName: string;
  readonly editId: string;
  readonly token: string;
  readonly transport: GooglePlayTransport;
}): Promise<boolean> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'POST',
    url: `${appUrl(options.packageName)}/edits/${encodeURIComponent(options.editId)}:commit`,
    token: options.token,
    contentType: 'application/json',
    body: '{}',
  });
  return response !== null && isSuccess(response.status);
}

function appUrl(packageName: string): string {
  return `${API}/${encodeURIComponent(packageName)}`;
}

function editTrackUrl(packageName: string, editId: string): string {
  return `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}/tracks/${TRACK}`;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}
