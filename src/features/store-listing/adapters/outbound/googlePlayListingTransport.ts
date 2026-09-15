import type {
  StoreListingAssetSet,
  StoreListingLocale,
  StoreListingRemoteAssetSet,
  StoreListingSyncRequest,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { GooglePlayTransport } from '../../../../types/googlePlay.js';
import { safeGooglePlayRequest } from '../../../../utils/googlePlayRuntime.js';
import {
  parseGooglePlayImageSet,
  parseGooglePlayListings,
  toGooglePlayListing,
} from '../../utils/googlePlayListingModel.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD_API = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

export async function createGooglePlayEditAsync(
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

export async function commitGooglePlayEditAsync(
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

export async function discardGooglePlayEditAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<void> {
  await safeGooglePlayRequest(transport, {
    method: 'DELETE',
    url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}`,
    token,
  });
}

export async function readGooglePlayListingsAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<readonly StoreListingLocale[] | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'GET',
    url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}/listings`,
    token,
  });
  return response !== null && isSuccess(response.status)
    ? parseGooglePlayListings(response.body)
    : null;
}

export async function readGooglePlayAssetSetAsync(options: {
  readonly packageName: string;
  readonly editId: string;
  readonly locale: string;
  readonly variant: string;
  readonly imageType: string;
  readonly token: string;
  readonly transport: GooglePlayTransport;
}): Promise<StoreListingRemoteAssetSet | null> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'GET',
    url: imagesUrl(options.packageName, options.editId, options.locale, options.imageType),
    token: options.token,
  });
  return response !== null && isSuccess(response.status)
    ? parseGooglePlayImageSet({
        body: response.body,
        locale: options.locale,
        variant: options.variant,
      })
    : null;
}

export async function writeGooglePlayLocaleAsync(options: {
  readonly packageName: string;
  readonly editId: string;
  readonly locale: StoreListingLocale;
  readonly token: string;
  readonly transport: GooglePlayTransport;
}): Promise<boolean> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'PUT',
    url: listingUrl(options.packageName, options.editId, options.locale.locale),
    token: options.token,
    contentType: 'application/json',
    body: JSON.stringify(toGooglePlayListing(options.locale)),
  });
  return response !== null && isSuccess(response.status);
}

export async function replaceGooglePlayAssetsAsync(options: {
  readonly packageName: string;
  readonly editId: string;
  readonly set: StoreListingAssetSet;
  readonly imageType: string;
  readonly token: string;
  readonly transport: GooglePlayTransport;
  readonly request: StoreListingSyncRequest;
}): Promise<boolean> {
  const cleared = await clearImagesAsync(options);
  if (!cleared) return false;
  for (const asset of options.set.assets) {
    const bytes = await options.request.assets.readAsync(asset.relativePath);
    const response = await safeGooglePlayRequest(options.transport, {
      method: 'POST',
      url: uploadImageUrl(
        options.packageName,
        options.editId,
        options.set.locale,
        options.imageType,
      ),
      token: options.token,
      contentType: asset.mediaType,
      body: bytes,
    });
    if (response === null || !isSuccess(response.status)) return false;
  }
  return true;
}

async function clearImagesAsync(options: {
  readonly packageName: string;
  readonly editId: string;
  readonly set: StoreListingAssetSet;
  readonly imageType: string;
  readonly token: string;
  readonly transport: GooglePlayTransport;
}): Promise<boolean> {
  const response = await safeGooglePlayRequest(options.transport, {
    method: 'DELETE',
    url: imagesUrl(
      options.packageName,
      options.editId,
      options.set.locale,
      options.imageType,
    ),
    token: options.token,
  });
  return response !== null && isSuccess(response.status);
}

function appUrl(packageName: string): string {
  return `${API}/${encodeURIComponent(packageName)}`;
}

function listingUrl(packageName: string, editId: string, locale: string): string {
  return `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(locale)}`;
}

function imagesUrl(
  packageName: string,
  editId: string,
  locale: string,
  imageType: string,
): string {
  return `${listingUrl(packageName, editId, locale)}/${encodeURIComponent(imageType)}`;
}

function uploadImageUrl(
  packageName: string,
  editId: string,
  locale: string,
  imageType: string,
): string {
  return `${UPLOAD_API}/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(locale)}/${encodeURIComponent(imageType)}?uploadType=media`;
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
