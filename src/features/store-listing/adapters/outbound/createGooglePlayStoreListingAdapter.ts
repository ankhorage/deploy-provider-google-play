import type {
  DeploymentProviderResult,
  DeploymentStoreListingAdapter,
  StoreListingAdapterContext,
  StoreListingAssetSet,
  StoreListingLocale,
  StoreListingRemoteAssetSet,
  StoreListingSyncRequest,
  StoreListingTargetState,
} from '@ankhorage/contracts/deploy-provider';
import { isRecord } from '@ankhorage/utility/object';
import { isNonEmptyString } from '@ankhorage/utility/string';

import type { GooglePlayTokenFactory, GooglePlayTransport } from '../../../../types/googlePlay.js';
import { resolveGooglePlayAccessTokenAsync, safeGooglePlayRequest } from '../../../../utils/googlePlayRuntime.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD_API = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
const SUPPORTED_FIELDS = ['name', 'summary', 'description', 'promoVideoUrl'] as const;
const IMAGE_VARIANTS = [
  ['icon', 'icon'],
  ['feature', 'featureGraphic'],
  ['phone', 'phoneScreenshots'],
  ['seven-inch', 'sevenInchScreenshots'],
  ['ten-inch', 'tenInchScreenshots'],
  ['tv', 'tvScreenshots'],
  ['wear', 'wearScreenshots'],
] as const;

export function createGooglePlayStoreListingAdapter(options: {
  readonly createToken: GooglePlayTokenFactory;
  readonly request: GooglePlayTransport;
}): DeploymentStoreListingAdapter {
  return {
    target: 'android',
    inspectAsync: (context) => inspectAsync(context, options),
    syncAsync: (request) => syncAsync(request, options),
  };
}

async function inspectAsync(
  context: StoreListingAdapterContext,
  options: Parameters<typeof createGooglePlayStoreListingAdapter>[0],
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (context.identity.target !== 'android') return failed('GOOGLE_PLAY_IDENTITY_INVALID');
  const access = await resolveGooglePlayAccessTokenAsync({ ...context, createToken: options.createToken });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const editId = await createEditAsync(context.identity.packageName, access.token, options.request);
  if (editId === null) return failed('GOOGLE_PLAY_EDIT_CREATE_FAILED');
  const state = await readStateAsync(context.identity.packageName, editId, access.token, options.request);
  await discardEditAsync(context.identity.packageName, editId, access.token, options.request);
  return state === null ? failed('GOOGLE_PLAY_LISTING_INSPECTION_FAILED') : { status: 'completed', value: state };
}

async function syncAsync(
  request: StoreListingSyncRequest,
  options: Parameters<typeof createGooglePlayStoreListingAdapter>[0],
): Promise<DeploymentProviderResult<StoreListingTargetState>> {
  if (request.identity.target !== 'android') return failed('GOOGLE_PLAY_IDENTITY_INVALID');
  if (request.plan.status === 'blocked') return failed('GOOGLE_PLAY_LISTING_PLAN_BLOCKED');
  if (request.plan.status === 'no-change') return inspectAsync(request, options);
  const access = await resolveGooglePlayAccessTokenAsync({ ...request, createToken: options.createToken });
  if (!access.ok) return { status: 'action-required', action: access.action };
  const editId = await createEditAsync(request.identity.packageName, access.token, options.request);
  if (editId === null) return failed('GOOGLE_PLAY_EDIT_CREATE_FAILED');
  const synced = await executePlanAsync(request, editId, access.token, options.request);
  if (!synced) return failed('GOOGLE_PLAY_LISTING_SYNC_FAILED');
  const committed = await commitEditAsync(request.identity.packageName, editId, access.token, options.request);
  return committed ? inspectAsync(request, options) : failed('GOOGLE_PLAY_EDIT_COMMIT_FAILED');
}

async function executePlanAsync(
  request: StoreListingSyncRequest,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  for (const step of request.plan.steps) {
    if (step.target !== 'android') continue;
    const success = step.operation === 'replace-assets'
      ? await replaceAssetsAsync(request, step.locale, step.variant, editId, token, transport)
      : await writeLocaleAsync(request, step.locale, editId, token, transport);
    if (!success) return false;
  }
  return true;
}

async function writeLocaleAsync(
  request: StoreListingSyncRequest,
  locale: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  const desired = request.desired.locales.find((item) => item.locale === locale);
  if (desired === undefined || request.identity.target !== 'android') return false;
  const response = await safeGooglePlayRequest(transport, {
    method: 'PUT',
    url: listingUrl(request.identity.packageName, editId, locale),
    token,
    contentType: 'application/json',
    body: JSON.stringify(toGoogleListing(desired)),
  });
  return response !== null && isSuccess(response.status);
}

async function replaceAssetsAsync(
  request: StoreListingSyncRequest,
  locale: string,
  variant: string | undefined,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  if (variant === undefined || request.identity.target !== 'android') return false;
  const imageType = imageTypeFor(variant);
  const set = request.desired.assetSets.find(
    (item) => item.target === 'android' && item.locale === locale && item.variant === variant,
  );
  if (imageType === null || set === undefined) return false;
  const cleared = await clearImagesAsync(request.identity.packageName, editId, locale, imageType, token, transport);
  return cleared && uploadAssetsAsync(request, set, editId, imageType, token, transport);
}

async function uploadAssetsAsync(
  request: StoreListingSyncRequest,
  set: StoreListingAssetSet,
  editId: string,
  imageType: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<boolean> {
  if (request.identity.target !== 'android') return false;
  for (const asset of set.assets) {
    const bytes = await request.assets.readAsync(asset.relativePath);
    const response = await safeGooglePlayRequest(transport, {
      method: 'POST',
      url: uploadImageUrl(request.identity.packageName, editId, set.locale, imageType),
      token,
      contentType: asset.mediaType,
      body: bytes,
    });
    if (response === null || !isSuccess(response.status)) return false;
  }
  return true;
}

async function readStateAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<StoreListingTargetState | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'GET',
    url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}/listings`,
    token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const locales = parseListings(response.body);
  if (locales === null) return null;
  const assetSets = await readAssetSetsAsync(packageName, editId, token, transport, locales);
  return assetSets === null
    ? null
    : { target: 'android', locales, assetSets, supportedFields: SUPPORTED_FIELDS, diagnostics: [] };
}

async function readAssetSetsAsync(
  packageName: string,
  editId: string,
  token: string,
  transport: GooglePlayTransport,
  locales: readonly StoreListingLocale[],
): Promise<readonly StoreListingRemoteAssetSet[] | null> {
  const sets = await Promise.all(
    locales.flatMap((locale) =>
      IMAGE_VARIANTS.map(([variant, imageType]) =>
        readAssetSetAsync(packageName, editId, locale.locale, variant, imageType, token, transport),
      ),
    ),
  );
  return sets.every((set): set is StoreListingRemoteAssetSet => set !== null) ? sets : null;
}

async function readAssetSetAsync(
  packageName: string,
  editId: string,
  locale: string,
  variant: string,
  imageType: string,
  token: string,
  transport: GooglePlayTransport,
): Promise<StoreListingRemoteAssetSet | null> {
  const response = await safeGooglePlayRequest(transport, {
    method: 'GET',
    url: imagesUrl(packageName, editId, locale, imageType),
    token,
  });
  if (response === null || !isSuccess(response.status)) return null;
  const hashes = parseImageHashes(response.body);
  return hashes === null ? null : { target: 'android', locale, variant, checksum: 'sha256', hashes };
}

function parseListings(body: string): readonly StoreListingLocale[] | null {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.listings)) return null;
  const listings = parsed.listings.map(parseListing);
  return listings.every((listing): listing is StoreListingLocale => listing !== null) ? listings : null;
}

function parseListing(value: unknown): StoreListingLocale | null {
  if (!isRecord(value) || !isNonEmptyString(value.language) || !isNonEmptyString(value.title)) return null;
  return {
    locale: value.language,
    name: value.title,
    ...(isNonEmptyString(value.shortDescription) ? { summary: value.shortDescription } : {}),
    ...(isNonEmptyString(value.fullDescription) ? { description: value.fullDescription } : {}),
    ...(isNonEmptyString(value.video) ? { promoVideoUrl: value.video } : {}),
  };
}

function parseImageHashes(body: string): readonly string[] | null {
  const parsed = parseJson(body);
  if (!isRecord(parsed) || !Array.isArray(parsed.images)) return null;
  const hashes = parsed.images.map((image) => (isRecord(image) && isNonEmptyString(image.sha256) ? image.sha256 : null));
  return hashes.every((hash): hash is string => hash !== null) ? hashes : null;
}

function toGoogleListing(locale: StoreListingLocale): Readonly<Record<string, string>> {
  return {
    language: locale.locale,
    title: locale.name,
    ...(locale.summary === undefined ? {} : { shortDescription: locale.summary }),
    ...(locale.description === undefined ? {} : { fullDescription: locale.description }),
    ...(locale.promoVideoUrl === undefined ? {} : { video: locale.promoVideoUrl }),
  };
}

async function clearImagesAsync(packageName: string, editId: string, locale: string, imageType: string, token: string, transport: GooglePlayTransport): Promise<boolean> {
  const response = await safeGooglePlayRequest(transport, { method: 'DELETE', url: imagesUrl(packageName, editId, locale, imageType), token });
  return response !== null && isSuccess(response.status);
}

async function createEditAsync(packageName: string, token: string, transport: GooglePlayTransport): Promise<string | null> {
  const response = await safeGooglePlayRequest(transport, { method: 'POST', url: `${appUrl(packageName)}/edits`, token, contentType: 'application/json', body: '{}' });
  if (response === null || !isSuccess(response.status)) return null;
  const parsed = parseJson(response.body);
  return isRecord(parsed) && isNonEmptyString(parsed.id) ? parsed.id : null;
}

async function commitEditAsync(packageName: string, editId: string, token: string, transport: GooglePlayTransport): Promise<boolean> {
  const response = await safeGooglePlayRequest(transport, { method: 'POST', url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}:commit`, token, contentType: 'application/json', body: '{}' });
  return response !== null && isSuccess(response.status);
}

async function discardEditAsync(packageName: string, editId: string, token: string, transport: GooglePlayTransport): Promise<void> {
  await safeGooglePlayRequest(transport, { method: 'DELETE', url: `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}`, token });
}

function imageTypeFor(variant: string): string | null {
  return IMAGE_VARIANTS.find(([name]) => name === variant)?.[1] ?? null;
}

function appUrl(packageName: string): string {
  return `${API}/${encodeURIComponent(packageName)}`;
}

function listingUrl(packageName: string, editId: string, locale: string): string {
  return `${appUrl(packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(locale)}`;
}

function imagesUrl(packageName: string, editId: string, locale: string, imageType: string): string {
  return `${listingUrl(packageName, editId, locale)}/${encodeURIComponent(imageType)}`;
}

function uploadImageUrl(packageName: string, editId: string, locale: string, imageType: string): string {
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

function failed(code: string): DeploymentProviderResult<StoreListingTargetState> {
  return { status: 'failed', failure: { code, message: 'Google Play store listing operation failed.', target: 'android', provider: 'google-play' } };
}
